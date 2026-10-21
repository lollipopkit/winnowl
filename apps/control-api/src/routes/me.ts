import { runWithoutTenant, type Db } from '@reviewbot/db';
import {
  OVERAGE_ACTIONS,
  checkQuota,
  currentMonthStart,
  periodUsage,
  resolvePlan,
  resolvePublicRepoBilling,
  setOveragePolicy,
  type OverageAction,
} from '@reviewbot/entitlement';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requirePermission } from '../rbac.js';
import { isPlatformOperator } from '../platform-operator.js';
import { getDashboardSummary } from '../read-model.js';

function tenantOf(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) void reply.code(400).send({ error: 'no_tenant_in_context' });
  return tenantId;
}

/** `APP_INSTALL_URL`, else built from `GITHUB_APP_SLUG`; null rather than a guessed link (which could install someone else's App). */
export function appInstallUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.APP_INSTALL_URL?.trim();
  if (explicit) return explicit;
  const slug = env.GITHUB_APP_SLUG?.trim();
  return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
}

export function registerMeRoutes(app: FastifyInstance, db: Db): void {
  // No permission gate: anyone sees their own context (anonymous = viewer without tenant).
  app.get('/v1/me', async (req) => {
    const auth = req.auth;
    let memberships: { tenantId: string; tenantName: string; role: string }[] = [];
    if (auth?.userId) {
      const userId = auth.userId;
      // Cross-tenant: the user's memberships in all tenants, filtered by user_id.
      memberships = (
        await runWithoutTenant(() => db
          .selectFrom('memberships')
          .innerJoin('tenants', 'tenants.id', 'memberships.tenant_id')
          .select(['memberships.tenant_id as tenantId', 'tenants.name as tenantName', 'memberships.role as role'])
          .where('memberships.user_id', '=', userId)
          .where('memberships.status', '=', 'active')
          .orderBy('memberships.created_at', 'asc')
          .execute())
      ).map((m) => ({ tenantId: m.tenantId, tenantName: m.tenantName, role: m.role }));
    }
    // Placeholder emails (@oidc.local / @provider.local) are not shown.
    let email: string | null = null;
    let displayName: string | null = null;
    if (auth?.userId) {
      const u = await runWithoutTenant(() =>
        db.selectFrom('users').select(['email', 'display_name']).where('id', '=', auth.userId!).executeTakeFirst(),
      );
      const raw = u?.email ?? null;
      email = raw && !/@(oidc|provider)\.local$/.test(raw) ? raw : null;
      displayName = u?.display_name ?? null;
    }
    // No membership: onboarding needs the install URL and whether an installation is pending approval
    // (pending_installations is keyed by the same forge user id).
    let pendingInstallation: { provider: string; accountLogin: string; createdAt: string } | null = null;
    if (memberships.length === 0 && auth?.identity) {
      const identity = auth.identity;
      const row = await runWithoutTenant(() =>
        db
          .selectFrom('pending_installations')
          .select(['provider', 'account_login', 'created_at'])
          .where('provider', '=', identity.provider)
          .where('installer_provider_user_id', '=', identity.subject)
          .where('status', '=', 'pending')
          .orderBy('created_at', 'desc')
          .executeTakeFirst(),
      );
      if (row) {
        pendingInstallation = {
          provider: row.provider,
          accountLogin: row.account_login,
          createdAt: new Date(row.created_at as unknown as string).toISOString(),
        };
      }
    }
    return {
      role: auth?.role ?? 'viewer',
      tenantId: auth?.tenantId ?? null,
      userId: auth?.userId ?? null,
      email,
      displayName,
      isOperator: isPlatformOperator(auth),
      memberships,
      pendingInstallation,
      installUrl: appInstallUrl(),
    };
  });

  app.get('/v1/subscription', { preHandler: requirePermission('plan:read') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { plan, overageAction } = await resolvePlan(db, tenantId);
    const start = currentMonthStart();
    // Same discounting as the quota gate so the page and the gate agree.
    const usage = await periodUsage(db, tenantId, start, await resolvePublicRepoBilling(db));
    const quota = checkQuota(plan, usage, overageAction);
    return {
      plan: {
        key: plan.key,
        name: plan.name,
        modelTier: plan.modelTier,
        monthlyCostCapUsd: plan.monthlyCostCapUsd,
        monthlyReviewQuota: plan.monthlyReviewQuota,
        monthlyTokenQuota: plan.monthlyTokenQuota,
        maxConcurrency: plan.maxConcurrency,
      },
      overageAction,
      periodStart: start.toISOString(),
      periodEnd: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString(),
      usage,
      withinQuota: quota.withinQuota,
    };
  });

  app.put('/v1/subscription/overage-policy', { preHandler: requirePermission('billing:manage') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const { action } = (req.body ?? {}) as { action?: string };
    if (!OVERAGE_ACTIONS.includes(action as OverageAction)) return reply.code(400).send({ error: 'invalid_action' });
    if (!(await setOveragePolicy(db, tenantId, action as OverageAction)))
      return reply.code(409).send({ error: 'no_active_subscription' });
    await db
      .insertInto('audit_events')
      .values({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        actor: req.auth?.actorId ?? null,
        action: 'subscription.overage_policy',
        target: tenantId,
        detail: { action },
        created_at: new Date(),
      })
      .execute();
    return { ok: true };
  });

  app.get('/v1/dashboard', { preHandler: requirePermission('review:read') }, async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    return getDashboardSummary(db, tenantId);
  });
}
