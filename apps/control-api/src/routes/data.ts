import {
  configDigest,
  ConfigValidationError,
  loadOrganizationLayer,
  parseRepositoryConfig,
  pruneDefaults,
  resolveConfig,
} from '@reviewbot/config';
import { runWithoutTenant, type Db } from '@reviewbot/db';
import {
  decideCrossTenantRelationship,
  listCrossTenantRelationships,
  listRelationships,
  createCrossTenantInvite,
  proposeCrossTenantRelationship,
  verifyCrossTenantInvite,
  setRelationshipEnabled,
  transitionRelationship,
  upsertRelationship,
  type CrossTenantStatus,
} from '@reviewbot/multi-repo';
import { cancelReviewJob, enqueueJob } from '@reviewbot/queue';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@reviewbot/notifications';
import { currentMonthStart, provisionTenantInTransaction } from '@reviewbot/entitlement';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AUDIT_SORTS, auditFacets, listAudit } from '../audit-read-model.js';
import { previewConfig } from '../config-preview.js';
import { requirePermission } from '../rbac.js';
import { isPlatformOperator } from '../platform-operator.js';
import { parseListParams, strFilter } from '../list-query.js';
import {
  getRepositoryConfig,
  getRunners,
  getUsageSummary,
  INSTALLATION_SORTS,
  listInstallations,
  listRepositories,
  listReviewProgress,
  REPOSITORY_SORTS,
} from '../read-model.js';
import {
  FINDING_SORTS,
  getFindingDetail,
  getReviewDetail,
  listFindings,
  listReviewRuns,
  listSuppressed,
  REVIEW_SORTS,
  SUPPRESSED_SORTS,
} from '../review-read-model.js';

function tenantOf(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) {
    void reply.code(400).send({ error: 'no_tenant_in_context' });
    return undefined;
  }
  return tenantId;
}

export function registerDataRoutes(app: FastifyInstance, db: Db): void {
  const read = { preHandler: requirePermission('review:read') };

  app.get('/v1/installations', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const params = parseListParams(req.query, {
      sortable: INSTALLATION_SORTS,
      defaultSort: 'createdAt',
    });
    return listInstallations(db, tenantId, params, {
      status: strFilter(req.query, 'status'),
      q: strFilter(req.query, 'q'),
    });
  });

  app.get('/v1/repositories', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const params = parseListParams(req.query, {
      sortable: REPOSITORY_SORTS,
      defaultSort: 'namespace',
      defaultDir: 'asc',
    });
    return listRepositories(db, tenantId, params, { q: strFilter(req.query, 'q') });
  });

  app.get('/v1/reviews', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const params = parseListParams(req.query, { sortable: REVIEW_SORTS, defaultSort: 'createdAt' });
    return listReviewRuns(db, tenantId, params, {
      repositoryId: strFilter(req.query, 'repositoryId'),
      status: strFilter(req.query, 'status'),
    });
  });

  // Cost is business data: admin+.
  app.get('/v1/usage', { preHandler: requirePermission('usage:read') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const since = strFilter(req.query, 'since');
    const sinceDate = since ? new Date(since) : currentMonthStart();
    if (Number.isNaN(sinceDate.getTime())) return reply.code(400).send({ error: 'invalid_since' });
    return getUsageSummary(db, tenantId, sinceDate);
  });


  // `all=1` is the cross-tenant operator view (isPlatformOperator), run inside `runWithoutTenant`.
  app.get('/v1/reviews/progress', read, async (req, reply) => {
    const all = strFilter(req.query, 'all') === '1';
    if (all) {
      if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
      return runWithoutTenant(() => listReviewProgress(db, {}));
    }
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    return listReviewProgress(db, { tenantId });
  });

  /*
   * Stop requires `review:trigger`: whoever can start a review can stop it. Another tenant's job and a
   * finished job both return 404, so existence is not leaked. Operators stopping another tenant's job first
   * read its tenant without a tenant context, then cancel with the same explicit tenant predicate.
   */
  app.post(
    '/v1/reviews/progress/:jobId/cancel',
    { preHandler: requirePermission('review:trigger') },
    async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const tenantId = req.auth?.tenantId;
      const cancelled = tenantId ? await cancelReviewJob(db, tenantId, jobId) : false;
      if (cancelled) return { ok: true };
      if (!isPlatformOperator(req.auth)) return reply.code(404).send({ error: 'review_not_running' });
      const byOperator = await runWithoutTenant(async () => {
        const job = await db
          .selectFrom('jobs')
          .select('tenant_id')
          .where('id', '=', jobId)
          .executeTakeFirst();
        return job ? cancelReviewJob(db, job.tenant_id, jobId) : false;
      });
      if (!byOperator) return reply.code(404).send({ error: 'review_not_running' });
      return { ok: true };
    },
  );

  app.get('/v1/reviews/:revisionId', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { revisionId } = req.params as { revisionId: string };
    const detail = await getReviewDetail(db, tenantId, revisionId);
    if (!detail) return reply.code(404).send({ error: 'review_not_found' });
    return detail;
  });

  app.get('/v1/repositories/:repositoryId/config', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { repositoryId } = req.params as { repositoryId: string };
    const config = await getRepositoryConfig(db, tenantId, repositoryId);
    if (!config) return reply.code(404).send({ error: 'config_not_found' });
    return config;
  });

  // Read permission: it only evaluates a draft, nothing is saved.
  app.post('/v1/repositories/:repositoryId/config/preview', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { repositoryId } = req.params as { repositoryId: string };
    const repo = await db
      .selectFrom('repositories')
      .select('id')
      .where('id', '=', repositoryId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!repo) return reply.code(404).send({ error: 'repository_not_found' });
    try {
      return await previewConfig(db, tenantId, repositoryId, parseRepositoryConfig(req.body));
    } catch (err) {
      if (err instanceof ConfigValidationError)
        return reply.code(400).send({ error: 'invalid_config', message: err.message });
      throw err;
    }
  });

  // panel_settings: the panel overlay (repo yaml wins on conflicts; the review mirror never writes it).
  // settings: refreshed effective config so the gate and UI see changes immediately.
  app.put(
    '/v1/repositories/:repositoryId/config',
    { preHandler: requirePermission('config:write') },
    async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      if (!tenantId) return;
      const { repositoryId } = req.params as { repositoryId: string };
      const repo = await db
        .selectFrom('repositories')
        .select('id')
        .where('id', '=', repositoryId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!repo) return reply.code(404).send({ error: 'repository_not_found' });

      let config;
      try {
        config = parseRepositoryConfig(req.body);
      } catch (err) {
        if (err instanceof ConfigValidationError)
          return reply.code(400).send({ error: 'invalid_config', message: err.message });
        throw err;
      }
      const digest = configDigest(config);
      const settings = config as unknown as Record<string, unknown>;
      // Store only the diff from what the panel sits on (schema and organization defaults): saving the full config
      // would freeze today's defaults as this repository's own choices.
      const organization = await loadOrganizationLayer(db, tenantId);
      const panelSettings = pruneDefaults(config, resolveConfig(organization ? [organization] : []).config);
      const now = new Date();
      const saved = await db
        .insertInto('repository_settings')
        .values({
          repository_id: repositoryId,
          tenant_id: tenantId,
          settings,
          panel_settings: panelSettings,
          config_digest: digest,
          source: 'panel',
          updated_at: now,
        })
        .onConflict((oc) =>
          oc
            .column('repository_id')
            .doUpdateSet({
              settings,
              panel_settings: panelSettings,
              config_digest: digest,
              source: 'panel',
              updated_at: now,
            })
            .where('repository_settings.source', '<>', 'repo-file'),
        )
        .returning('repository_id')
        .executeTakeFirst();
      if (!saved) return reply.code(409).send({ error: 'repository_config_read_only' });
      return { ok: true, digest };
    },
  );

  app.post(
    '/v1/repositories/:repositoryId/security-scan',
    { preHandler: requirePermission('action:approve') },
    async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      if (!tenantId) return;
      const { repositoryId } = req.params as { repositoryId: string };
      const repo = await db
        .selectFrom('repositories')
        .select('id')
        .where('id', '=', repositoryId)
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      if (!repo) return reply.code(404).send({ error: 'repository_not_found' });
      const { jobId } = await enqueueJob(db, {
        tenantId,
        type: 'security_scan',
        payload: { tenantId, repositoryId, trigger: 'manual' },
        dedupeKey: `security-scan:${repositoryId}`,
      });
      return { ok: true, jobId };
    },
  );

  const RELATIONSHIP_KINDS = new Set([
    'api-provider',
    'api-consumer',
    'shared-schema',
    'generated-client',
    'library-dependent',
    'deployment-dependent',
  ]);
  app.get('/v1/repository-relationships', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    return listRelationships(db, tenantId);
  });

  app.post(
    '/v1/repository-relationships',
    { preHandler: requirePermission('config:write') },
    async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      if (!tenantId) return;
      const body = (req.body ?? {}) as {
        sourceRepositoryId?: string;
        targetRepositoryId?: string;
        kind?: string;
        instructions?: string;
        enabled?: boolean;
      };
      if (
        !body.sourceRepositoryId ||
        !body.targetRepositoryId ||
        !body.kind ||
        !RELATIONSHIP_KINDS.has(body.kind)
      ) {
        return reply.code(400).send({ error: 'invalid_relationship' });
      }
      // Both repositories must belong to this tenant.
      const repos = await db
        .selectFrom('repositories')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', 'in', [body.sourceRepositoryId, body.targetRepositoryId])
        .execute();
      if (repos.length < 2) return reply.code(404).send({ error: 'repository_not_found' });
      const id = await upsertRelationship(db, tenantId, {
        sourceRepositoryId: body.sourceRepositoryId,
        targetRepositoryId: body.targetRepositoryId,
        kind: body.kind as Parameters<typeof upsertRelationship>[2]['kind'],
        ...(body.instructions ? { instructions: body.instructions } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      });
      return { ok: true, id };
    },
  );

  app.post(
    '/v1/repository-relationships/:id/toggle',
    { preHandler: requirePermission('config:write') },
    async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      if (!tenantId) return;
      const { id } = req.params as { id: string };
      const { enabled } = (req.body ?? {}) as { enabled?: boolean };
      const ok = await setRelationshipEnabled(db, tenantId, id, enabled !== false);
      if (!ok) return reply.code(404).send({ error: 'relationship_not_found' });
      return { ok: true };
    },
  );

  // Only proposed relationships can be decided; reject is a permanent veto.
  for (const action of ['approve', 'reject'] as const) {
    app.post(
      `/v1/repository-relationships/:id/${action}`,
      { preHandler: requirePermission('config:write') },
      async (req, reply) => {
        const tenantId = tenantOf(req, reply);
        if (!tenantId) return;
        const { id } = req.params as { id: string };
        const ok = await transitionRelationship(db, tenantId, id, action);
        if (!ok) return reply.code(404).send({ error: 'proposal_not_found' });
        await db
          .insertInto('audit_events')
          .values({
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            actor: req.auth?.actorId ?? null,
            action: `cross-repo.relationship-${action === 'approve' ? 'approved' : 'rejected'}`,
            target: id,
            detail: {},
            created_at: new Date(),
          })
          .execute();
        return { ok: true, status: action === 'approve' ? 'active' : 'rejected' };
      },
    );
  }

  // Cross-tenant relationships: RLS shows rows where this tenant is either side; write rights depend on the side.
  app.get('/v1/cross-tenant-relationships', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { status } = (req.query ?? {}) as { status?: string };
    const rows = await listCrossTenantRelationships(
      db,
      tenantId,
      status ? { status: status as CrossTenantStatus } : {},
    );
    return rows.map((r) => ({ ...r, side: r.sourceTenantId === tenantId ? 'source' : 'target' }));
  });

  // The downstream issues a self-describing HMAC-signed token; redeeming only verifies the signature, so neither side reads across tenants.
  app.post(
    '/v1/cross-tenant-invites',
    { preHandler: requirePermission('config:write') },
    async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      if (!tenantId) return;
      const secret = process.env.CROSS_TENANT_INVITE_SECRET;
      if (!secret) return reply.code(501).send({ error: 'cross_tenant_not_configured' });
      const body = (req.body ?? {}) as { repositoryId?: string; kind?: string };
      if (!body.repositoryId || !body.kind || !RELATIONSHIP_KINDS.has(body.kind))
        return reply.code(400).send({ error: 'invalid_invite' });
      const owned = await db
        .selectFrom('repositories')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', body.repositoryId)
        .executeTakeFirst();
      if (!owned) return reply.code(404).send({ error: 'repository_not_found' });
      const token = createCrossTenantInvite(secret, {
        targetTenantId: tenantId,
        targetRepositoryId: body.repositoryId,
        kind: body.kind,
      });
      return { ok: true, token };
    },
  );

  // Redeeming creates a proposed relationship that the downstream must still approve.
  app.post(
    '/v1/cross-tenant-relationships/redeem',
    { preHandler: requirePermission('config:write') },
    async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      if (!tenantId) return;
      const secret = process.env.CROSS_TENANT_INVITE_SECRET;
      if (!secret) return reply.code(501).send({ error: 'cross_tenant_not_configured' });
      const body = (req.body ?? {}) as {
        token?: string;
        sourceRepositoryId?: string;
        rationale?: string;
      };
      if (!body.token || !body.sourceRepositoryId)
        return reply.code(400).send({ error: 'invalid_redeem' });
      const src = await db
        .selectFrom('repositories')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', body.sourceRepositoryId)
        .executeTakeFirst();
      if (!src) return reply.code(404).send({ error: 'source_repository_not_found' });
      // Uniform 400 on any failure so this cannot be used as a probe.
      const invite = verifyCrossTenantInvite(secret, body.token);
      if (!invite) return reply.code(400).send({ error: 'invalid_or_expired_invite' });
      if (invite.targetTenantId === tenantId)
        return reply.code(400).send({ error: 'same_tenant_use_repository_relationships' });
      const rel = await proposeCrossTenantRelationship(db, {
        sourceTenantId: tenantId,
        sourceRepositoryId: body.sourceRepositoryId,
        targetTenantId: invite.targetTenantId,
        targetRepositoryId: invite.targetRepositoryId,
        kind: invite.kind,
        ...(req.auth?.actorId ? { proposedBy: req.auth.actorId } : {}),
        ...(body.rationale ? { rationale: body.rationale } : {}),
      });
      return { ok: true, id: rel.id, status: rel.status };
    },
  );

  // Only the target tenant can approve/reject; either side can revoke.
  for (const decision of ['approve', 'reject', 'revoke'] as const) {
    app.post(
      `/v1/cross-tenant-relationships/:id/${decision}`,
      { preHandler: requirePermission('config:write') },
      async (req, reply) => {
        const tenantId = tenantOf(req, reply);
        if (!tenantId) return;
        const { id } = req.params as { id: string };
        const updated = await decideCrossTenantRelationship(db, {
          id,
          actingTenantId: tenantId,
          decision,
          ...(req.auth?.actorId ? { decidedBy: req.auth.actorId } : {}),
        });
        if (!updated)
          return reply.code(404).send({ error: 'relationship_not_found_or_not_permitted' });
        await db
          .insertInto('audit_events')
          .values({
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            actor: req.auth?.actorId ?? null,
            action: `cross-tenant.relationship-${decision}d`,
            target: id,
            detail: { status: updated.status } as unknown as Record<string, unknown>,
            created_at: new Date(),
          })
          .execute();
        return { ok: true, status: updated.status };
      },
    );
  }

  app.post(
    '/v1/repository-relationships/discover',
    { preHandler: requirePermission('config:write') },
    async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      if (!tenantId) return;
      const { jobId } = await enqueueJob(db, {
        tenantId,
        type: 'relationship_discover',
        payload: { tenantId, trigger: 'manual' },
        dedupeKey: `rel-discover:${tenantId}`,
      });
      return { ok: true, jobId };
    },
  );

  // Pending installations: operator-only, they have no tenant and are outside RLS.
  app.get(
    '/v1/pending-installations',
    { preHandler: requirePermission('review:read') },
    async (req, reply) => {
      if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
      const { status } = (req.query ?? {}) as { status?: string };
      let q = db
        .selectFrom('pending_installations')
        .select([
          'id',
          'provider',
          'installation_native_id',
          'account_login',
          'installer_login',
          'status',
          'decided_by',
          'decided_at',
          'created_at',
        ])
        .orderBy('created_at', 'desc')
        .limit(200);
      if (status) q = q.where('status', '=', status);
      const rows = await q.execute();
      return {
        items: rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          installationNativeId: r.installation_native_id,
          accountLogin: r.account_login,
          installerLogin: r.installer_login,
          status: r.status,
          decidedBy: r.decided_by,
          decidedAt: r.decided_at
            ? new Date(r.decided_at as unknown as string).toISOString()
            : null,
          createdAt: new Date(r.created_at as unknown as string).toISOString(),
        })),
      };
    },
  );

  for (const action of ['approve', 'reject'] as const) {
    app.post(
      `/v1/pending-installations/:id/${action}`,
      { preHandler: requirePermission('review:read') },
      async (req, reply) => {
        if (!isPlatformOperator(req.auth)) return reply.code(403).send({ error: 'operator_only' });
        const { id } = req.params as { id: string };
        // Deliberately cross-tenant: this provisions a new tenant, and the operator's own tenant
        // context would make RLS reject every row provisionTenantInTransaction inserts.
        const result = await runWithoutTenant(() =>
          db.transaction().execute(async (trx) => {
            const row = await trx
              .selectFrom('pending_installations')
              .selectAll()
              .where('id', '=', id)
              .where('status', '=', 'pending')
              .forUpdate()
              .executeTakeFirst();
            if (!row) return { kind: 'missing' as const };

            if (action === 'approve') {
              // Current pending rows contain enough host metadata only for GitHub SaaS.
              if (row.provider !== 'github')
                return { kind: 'unsupported' as const, provider: row.provider };
              await provisionTenantInTransaction(trx, {
                provider: row.provider,
                host: {
                  baseUrl: 'https://github.com',
                  apiUrl: 'https://api.github.com',
                  isSaas: true,
                },
                installationNativeId: row.installation_native_id,
                accountLogin: row.account_login,
                installer: {
                  providerUserId: row.installer_provider_user_id,
                  login: row.installer_login,
                },
              });
            }
            await trx
              .updateTable('pending_installations')
              .set({
                status: action === 'approve' ? 'approved' : 'rejected',
                decided_by: req.auth?.actorId ?? null,
                decided_at: new Date(),
              })
              .where('id', '=', id)
              .where('status', '=', 'pending')
              .execute();
            return { kind: 'updated' as const };
          }),
        );
        if (result.kind === 'missing')
          return reply.code(404).send({ error: 'pending_installation_not_found' });
        if (result.kind === 'unsupported')
          return reply.code(409).send({
            error: 'pending_installation_provider_not_supported',
            provider: result.provider,
          });
        return { ok: true, status: action === 'approve' ? 'approved' : 'rejected' };
      },
    );
  }

  app.get('/v1/notifications', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const q = (req.query ?? {}) as { limit?: string; offset?: string; unread?: string };
    const params = parseListParams(q, { sortable: ['createdAt'], defaultSort: 'createdAt' });
    return listNotifications(db, tenantId, {
      limit: params.limit,
      offset: params.offset,
      ...(q.unread === '1' || q.unread === 'true' ? { unreadOnly: true } : {}),
    });
  });

  app.post('/v1/notifications/:id/read', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { id } = req.params as { id: string };
    const ok = await markNotificationRead(db, tenantId, id);
    if (!ok) return reply.code(404).send({ error: 'notification_not_found_or_already_read' });
    return { ok: true };
  });

  app.post('/v1/notifications/read-all', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    return { ok: true, updated: await markAllNotificationsRead(db, tenantId) };
  });

  app.get('/v1/findings', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const params = parseListParams(req.query, {
      sortable: FINDING_SORTS,
      defaultSort: 'lastSeenAt',
    });
    return listFindings(db, tenantId, params, {
      status: strFilter(req.query, 'status'),
      repositoryId: strFilter(req.query, 'repositoryId'),
      severity: strFilter(req.query, 'severity'),
      q: strFilter(req.query, 'q'),
    });
  });

  app.get('/v1/findings/:findingId', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { findingId } = req.params as { findingId: string };
    const detail = await getFindingDetail(db, tenantId, findingId, strFilter(req.query, 'revisionId'));
    if (!detail) return reply.code(404).send({ error: 'finding_not_found' });
    return detail;
  });

  app.get('/v1/suppressed', read, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const params = parseListParams(req.query, {
      sortable: SUPPRESSED_SORTS,
      defaultSort: 'createdAt',
    });
    return listSuppressed(db, tenantId, params, {
      repositoryId: strFilter(req.query, 'repositoryId'),
      q: strFilter(req.query, 'q'),
    });
  });

  // Shared pools (tenant_id IS NULL) are operator-only; tenants see their own pools and job counts.
  app.get('/v1/runners', read, async (req, reply) => {
    const allTenants = isPlatformOperator(req.auth);
    const tenantId = allTenants ? '' : tenantOf(req, reply);
    if (!allTenants && !tenantId) return;
    const params = parseListParams(req.query, {
      sortable: ['lastHeartbeatAt'],
      defaultSort: 'lastHeartbeatAt',
    });
    const load = () =>
      getRunners(db, tenantId ?? '', { allTenants, limit: params.limit, offset: params.offset });
    return allTenants ? runWithoutTenant(load) : load();
  });

  app.get('/v1/audit', { preHandler: requirePermission('audit:read') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const params = parseListParams(req.query, { sortable: AUDIT_SORTS, defaultSort: 'createdAt' });
    return listAudit(db, tenantId, params, {
      action: strFilter(req.query, 'action'),
      actor: strFilter(req.query, 'actor'),
      q: strFilter(req.query, 'q'),
    });
  });

  app.get('/v1/audit/facets', { preHandler: requirePermission('audit:read') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    return auditFacets(db, tenantId);
  });
}
