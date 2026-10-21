import type { Db } from '@reviewbot/db';
import {
  deleteFactFeed,
  insertEcosystemFact,
  insertFactFeed,
  listFactFeeds,
  updateFactFeed,
  isFactEcosystem,
  listEcosystemFactsPage,
  normalizeFactSources,
  reviewEcosystemFact,
} from '@reviewbot/knowledge';
import type { FastifyInstance } from 'fastify';
import { paged, parseListParams, strFilter } from '../list-query.js';
import { requirePlatformOperator } from '../platform-operator.js';
import { parseExpiry } from '../expiry.js';


const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Operator-only. Operator-entered facts are approved on creation; `proposedFrom` is visible only here. */
export function registerEcosystemFactRoutes(app: FastifyInstance, db: Db): void {
  app.get('/v1/ecosystem-facts', { preHandler: requirePlatformOperator }, async (req) => {
    const params = parseListParams(req.query, { sortable: ['createdAt'], defaultSort: 'createdAt' });
    const { items, total } = await listEcosystemFactsPage(db, {
      limit: params.limit,
      offset: params.offset,
      dir: params.dir,
      status: strFilter(req.query, 'status'),
      q: strFilter(req.query, 'q'),
    });
    return paged(items, total, params);
  });

  app.post('/v1/ecosystem-facts', { preHandler: requirePlatformOperator }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ecosystem = String(body.ecosystem ?? '');
    const subject = optStr(body.subject);
    const claim = optStr(body.claim);
    const sources = normalizeFactSources(Array.isArray(body.sources) ? body.sources.filter((s): s is string => typeof s === 'string') : []);
    if (!isFactEcosystem(ecosystem)) return reply.code(400).send({ error: 'invalid_ecosystem' });
    if (!subject || !claim) return reply.code(400).send({ error: 'subject_claim_required' });
    if (sources.length === 0) return reply.code(400).send({ error: 'source_required' });
    const expiresAt = parseExpiry(body.expiresAt);
    if (expiresAt === 'invalid') return reply.code(400).send({ error: 'invalid_expires_at' });
    const versions = optStr(body.versions);
    const detail = optStr(body.detail);
    const fact = await insertEcosystemFact(db, {
      ecosystem,
      subject,
      ...(versions ? { versions } : {}),
      claim,
      ...(detail ? { detail } : {}),
      sources,
      origin: 'operator',
      approvedBy: req.auth!.actorId!,
      ...(expiresAt ? { expiresAt } : {}),
    });
    return reply.code(201).send(fact);
  });

  for (const action of ['approve', 'reject'] as const) {
    app.post(`/v1/ecosystem-facts/:id/${action}`, { preHandler: requirePlatformOperator }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const expiresAt = parseExpiry(body.expiresAt);
      if (expiresAt === 'invalid') return reply.code(400).send({ error: 'invalid_expires_at' });
      const text = (k: string): string | null | undefined => (k in body ? (optStr(body[k]) ?? null) : undefined);
      const edits = {
        ...(optStr(body.subject) ? { subject: optStr(body.subject)! } : {}),
        ...(optStr(body.claim) ? { claim: optStr(body.claim)! } : {}),
        ...(text('versions') !== undefined ? { versions: text('versions')! } : {}),
        ...(text('detail') !== undefined ? { detail: text('detail')! } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      };
      const fact = await reviewEcosystemFact(db, id, { action, reviewer: req.auth!.actorId!, edits });
      if (!fact) return reply.code(409).send({ error: 'transition_rejected' });
      return fact;
    });
  }

  // Release-notes feeds: pages the runner extracts proposed facts from every 7 days.
  app.get('/v1/ecosystem-fact-feeds', { preHandler: requirePlatformOperator }, async () => ({
    items: await listFactFeeds(db),
  }));

  app.post('/v1/ecosystem-fact-feeds', { preHandler: requirePlatformOperator }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ecosystem = String(body.ecosystem ?? '');
    const subject = optStr(body.subject);
    const url = optStr(body.url)?.trim();
    if (!isFactEcosystem(ecosystem)) return reply.code(400).send({ error: 'invalid_ecosystem' });
    if (!subject) return reply.code(400).send({ error: 'subject_required' });
    // Public http(s) pages only; the runner fetches through Exa, never directly.
    if (!url || normalizeFactSources([url]).length === 0) return reply.code(400).send({ error: 'invalid_url' });
    const label = optStr(body.label);
    try {
      const feed = await insertFactFeed(db, { ecosystem, subject, url, ...(label ? { label } : {}), createdBy: req.auth!.actorId! });
      return reply.code(201).send(feed);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'feed_exists' });
      throw err;
    }
  });

  for (const action of ['enable', 'disable', 'refresh'] as const) {
    app.post(`/v1/ecosystem-fact-feeds/:id/${action}`, { preHandler: requirePlatformOperator }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = await updateFactFeed(db, id, action === 'refresh' ? { refresh: true } : { enabled: action === 'enable' });
      return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    });
  }

  app.delete('/v1/ecosystem-fact-feeds/:id', { preHandler: requirePlatformOperator }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return (await deleteFactFeed(db, id)) ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
}
