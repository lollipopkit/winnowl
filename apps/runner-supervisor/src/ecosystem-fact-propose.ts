import { detectInjectionAttempt, type ModelTier, type ResolvedModelSource } from '@reviewbot/agent-pi';
import type { Db } from '@reviewbot/db';
import {
  FACT_LIMITS,
  type EcosystemFactOrigin,
  insertEcosystemFact,
  isFactEcosystem,
  listFactsForSubject,
  normalizeFactSources,
} from '@reviewbot/knowledge';
import { billRevision } from './learning-propose.js';
import { newUsage, resolveProposeNearDup, type NearDupChecker } from './propose-common.js';
import type { JobHandler } from './supervisor.js';

/**
 * ecosystem_fact_propose job: agent-verified ecosystem facts → `proposed` rows. Sources are already
 * filtered in the engine; this screens for injection, sanitizes, truncates and dedupes. Only platform
 * operators see proposed facts, and approval gates them from reaching any tenant's review.
 */

/** Same shape as review-engine's ExternalFactCandidate (payload round-trips through JSON). */
export interface ProposedExternalFact {
  ecosystem: string;
  subject: string;
  versions?: string;
  claim: string;
  detail?: string;
  sources: string[];
}

export interface EcosystemFactProposePayload {
  tenantId: string;
  repositoryId: string;
  revisionId: string;
  facts: ProposedExternalFact[];
}

export interface EcosystemFactProposeDeps {
  resolveModel: (tier?: ModelTier) => ResolvedModelSource | null;
}

function normalizeClaim(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[.。]+$/, '').trim();
}

/** Outcome of proposing one fact (shared by review submissions and release-notes feeds). */
export type ProposeOutcome = 'inserted' | 'duplicate' | 'dropped';

/**
 * One candidate fact → a `proposed` row: injection screening, sanitising, truncation, exact and
 * (optional) semantic dedup against every fact on the same subject, rejected ones included.
 */
export async function proposeEcosystemFact(
  db: Db,
  f: ProposedExternalFact,
  ctx: {
    origin: 'review' | 'feed';
    proposedFrom: EcosystemFactOrigin;
    nearDup: NearDupChecker;
    log: (message: string, data?: Record<string, unknown>) => void;
  },
): Promise<ProposeOutcome> {
  const injection = detectInjectionAttempt(`${f.subject}\n${f.versions ?? ''}\n${f.claim}\n${f.detail ?? ''}`);
  if (injection.suspicious) {
    ctx.log('ecosystem-fact-propose: injection suspected, fact dropped', { ...ctx.proposedFrom, patterns: injection.patterns });
    return 'dropped';
  }
  const ecosystem = isFactEcosystem(f.ecosystem) ? f.ecosystem : 'other';
  const subject = f.subject.trim().slice(0, FACT_LIMITS.subject);
  const claim = f.claim.trim().slice(0, FACT_LIMITS.claim);
  const detail = f.detail ? f.detail.trim().slice(0, FACT_LIMITS.detail) : '';
  const versions = f.versions ? f.versions.trim().slice(0, FACT_LIMITS.versions) : '';
  const sources = normalizeFactSources(f.sources ?? []);
  if (!subject || !claim || sources.length === 0) return 'dropped';

  // Existing facts on the same subject, rejected ones included so rejected claims are not resubmitted.
  const existing = await listFactsForSubject(db, ecosystem, subject);
  const claims = existing.map((e) => e.claim);
  if (claims.some((c) => normalizeClaim(c) === normalizeClaim(claim)) || (await ctx.nearDup(claim, claims))) {
    ctx.log('ecosystem-fact-propose: duplicate skipped', { ...ctx.proposedFrom, ecosystem, subject });
    return 'duplicate';
  }
  const fact = await insertEcosystemFact(db, {
    ecosystem,
    subject,
    ...(versions ? { versions } : {}),
    claim,
    ...(detail ? { detail } : {}),
    sources,
    origin: ctx.origin,
    proposedFrom: ctx.proposedFrom,
  });
  ctx.log('ecosystem fact proposed', { id: fact.id, ecosystem, subject, origin: ctx.origin });
  return 'inserted';
}

export function createEcosystemFactProposeHandler(deps: EcosystemFactProposeDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as EcosystemFactProposePayload;
    const usage = newUsage();
    // Semantic dedup (env LLM_DEDUP=embedding|llm); default is exact match after normalization.
    const cheap = deps.resolveModel('cheap');
    const nearDup = resolveProposeNearDup({ ...(cheap ? { cheapSource: cheap } : {}), usage });
    const proposedFrom = { tenantId: payload.tenantId, repositoryId: payload.repositoryId, revisionId: payload.revisionId };
    try {
      for (const f of payload.facts ?? []) {
        await proposeEcosystemFact(db, f, { origin: 'review', proposedFrom, nearDup, log });
      }
    } finally {
      await billRevision(db, payload.revisionId, usage);
    }
  };
}
