import type { Db } from '@reviewbot/db';
import { isFactEcosystem, type FactEcosystem } from './fact-ecosystems.js';
import { resolvedVersion, satisfies } from './versions.js';
import { uuidv7 } from '@reviewbot/ids';

/**
 * Platform-wide public facts about languages, SDKs, frameworks and packages (versions, deprecations,
 * breaking changes, migrations). Review-submitted facts need operator approval before injection, to keep
 * private content out of cross-tenant knowledge. Injected as dated, sourced reference facts, not instructions.
 */

export { ECOSYSTEM_FACT_ECOSYSTEMS, isFactEcosystem } from './fact-ecosystems.js';
export type { FactEcosystem } from './fact-ecosystems.js';
export type EcosystemFactStatus = 'proposed' | 'approved' | 'rejected';

/** Field limits; review-submitted facts are truncated to these, manual entries are bounded too. */
export const FACT_LIMITS = { subject: 120, versions: 80, claim: 400, detail: 2000, sources: 5, sourceUrl: 500 } as const;
/** Default expiry from the observation date; ecosystem facts change and need re-verification. */
export const DEFAULT_FACT_TTL_DAYS = 180;

/** Where a proposed fact came from: the review that looked it up, or a release-notes feed. */
export type EcosystemFactOrigin =
  | { tenantId: string; repositoryId: string; revisionId: string }
  | { feedId: string; url: string };

export interface EcosystemFact {
  id: string;
  ecosystem: FactEcosystem;
  subject: string;
  versions?: string;
  claim: string;
  detail?: string;
  sources: string[];
  status: EcosystemFactStatus;
  origin: 'review' | 'operator' | 'feed';
  /** Operator-only. */
  proposedFrom?: EcosystemFactOrigin;
  observedAt: Date;
  expiresAt?: Date;
  reviewedBy?: string;
  createdAt: Date;
}

type FactRow = {
  id: string;
  ecosystem: string;
  subject: string;
  versions: string | null;
  claim: string;
  detail: string | null;
  sources: unknown;
  status: string;
  origin: string;
  proposed_from: unknown;
  observed_at: Date;
  expires_at: Date | null;
  reviewed_by: string | null;
  created_at: Date;
};

function rowToFact(row: FactRow): EcosystemFact {
  return {
    id: row.id,
    ecosystem: isFactEcosystem(row.ecosystem) ? row.ecosystem : 'other',
    subject: row.subject,
    ...(row.versions !== null ? { versions: row.versions } : {}),
    claim: row.claim,
    ...(row.detail !== null ? { detail: row.detail } : {}),
    sources: Array.isArray(row.sources) ? row.sources.filter((s): s is string => typeof s === 'string') : [],
    status: row.status as EcosystemFactStatus,
    origin: row.origin === 'review' ? 'review' : row.origin === 'feed' ? 'feed' : 'operator',
    ...(row.proposed_from ? { proposedFrom: row.proposed_from as EcosystemFactOrigin } : {}),
    observedAt: row.observed_at,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(row.reviewed_by !== null ? { reviewedBy: row.reviewed_by } : {}),
    createdAt: row.created_at,
  };
}

/** Keeps only public http(s) URLs; dedups, bounds length and count. */
export function normalizeFactSources(sources: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of sources) {
    const s = raw.trim();
    if (!/^https?:\/\/[^\s]+$/i.test(s) || s.length > FACT_LIMITS.sourceUrl || out.includes(s)) continue;
    out.push(s);
    if (out.length >= FACT_LIMITS.sources) break;
  }
  return out;
}

export interface NewEcosystemFactInput {
  ecosystem: FactEcosystem;
  subject: string;
  versions?: string;
  claim: string;
  detail?: string;
  sources: string[];
  origin: 'review' | 'operator' | 'feed';
  proposedFrom?: EcosystemFactOrigin;
  /** Manual entries may be approved directly (the operator is the reviewer). */
  approvedBy?: string;
  observedAt?: Date;
  expiresAt?: Date;
}

export async function insertEcosystemFact(db: Db, input: NewEcosystemFactInput): Promise<EcosystemFact> {
  const now = new Date();
  const observedAt = input.observedAt ?? now;
  const approved = input.approvedBy !== undefined;
  const row = await db
    .insertInto('ecosystem_facts')
    .values({
      id: uuidv7(),
      ecosystem: input.ecosystem,
      subject: input.subject.trim().slice(0, FACT_LIMITS.subject),
      versions: input.versions?.trim().slice(0, FACT_LIMITS.versions) || null,
      claim: input.claim.trim().slice(0, FACT_LIMITS.claim),
      detail: input.detail?.trim().slice(0, FACT_LIMITS.detail) || null,
      // node-pg encodes JS arrays as PG array literals; jsonb needs a JSON string.
      sources: JSON.stringify(normalizeFactSources(input.sources)) as unknown as string[],
      status: approved ? 'approved' : 'proposed',
      origin: input.origin,
      proposed_from: (input.proposedFrom ?? null) as Record<string, unknown> | null,
      observed_at: observedAt,
      expires_at: input.expiresAt ?? (approved ? defaultFactExpiry(observedAt) : null),
      reviewed_by: input.approvedBy ?? null,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return rowToFact(row);
}

export function defaultFactExpiry(observedAt: Date): Date {
  return new Date(observedAt.getTime() + DEFAULT_FACT_TTL_DAYS * 86_400_000);
}

export async function loadEcosystemFact(db: Db, id: string): Promise<EcosystemFact | null> {
  const row = await db.selectFrom('ecosystem_facts').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToFact(row) : null;
}

/** Includes rejected entries, so rejected facts are not resubmitted. */
export async function listFactsForSubject(db: Db, ecosystem: FactEcosystem, subject: string): Promise<EcosystemFact[]> {
  const rows = await db
    .selectFrom('ecosystem_facts')
    .selectAll()
    .where('ecosystem', '=', ecosystem)
    .where((eb) => eb(eb.fn('lower', ['subject']), '=', subject.trim().toLowerCase()))
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();
  return rows.map(rowToFact);
}

export async function listEcosystemFactsPage(
  db: Db,
  opts: { limit: number; offset: number; dir: 'asc' | 'desc'; status?: string | undefined; q?: string | undefined },
): Promise<{ items: EcosystemFact[]; total: number }> {
  let base = db.selectFrom('ecosystem_facts');
  if (opts.status) base = base.where('status', '=', opts.status);
  if (opts.q) {
    const like = `%${opts.q}%`;
    base = base.where((eb) => eb.or([eb('subject', 'ilike', like), eb('claim', 'ilike', like)]));
  }
  const totalRow = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
  const rows = await base.selectAll().orderBy('created_at', opts.dir).orderBy('id', 'desc').limit(opts.limit).offset(opts.offset).execute();
  return { items: rows.map(rowToFact), total: Number(totalRow?.n ?? 0) };
}

export interface FactReviewInput {
  action: 'approve' | 'reject';
  reviewer: string;
  /** Optional corrections applied on approval. */
  edits?: { subject?: string; versions?: string | null; claim?: string; detail?: string | null; expiresAt?: Date };
}

/** proposed -> approved|rejected; approved facts can still be rejected (withdrawn). */
export async function reviewEcosystemFact(db: Db, id: string, input: FactReviewInput): Promise<EcosystemFact | null> {
  const current = await loadEcosystemFact(db, id);
  if (!current) return null;
  if (input.action === 'approve' && current.status !== 'proposed') return null;
  if (input.action === 'reject' && current.status === 'rejected') return null;
  const e = input.edits ?? {};
  const row = await db
    .updateTable('ecosystem_facts')
    .set({
      status: input.action === 'approve' ? 'approved' : 'rejected',
      reviewed_by: input.reviewer,
      updated_at: new Date(),
      ...(input.action === 'approve'
        ? {
            ...(e.subject?.trim() ? { subject: e.subject.trim().slice(0, FACT_LIMITS.subject) } : {}),
            ...(e.versions !== undefined ? { versions: e.versions?.trim().slice(0, FACT_LIMITS.versions) || null } : {}),
            ...(e.claim?.trim() ? { claim: e.claim.trim().slice(0, FACT_LIMITS.claim) } : {}),
            ...(e.detail !== undefined ? { detail: e.detail?.trim().slice(0, FACT_LIMITS.detail) || null } : {}),
            expires_at: e.expiresAt ?? defaultFactExpiry(current.observedAt),
          }
        : {}),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
  return row ? rowToFact(row) : null;
}

export async function loadActiveEcosystemFacts(db: Db, now: Date = new Date()): Promise<EcosystemFact[]> {
  const rows = await db
    .selectFrom('ecosystem_facts')
    .selectAll()
    .where('status', '=', 'approved')
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .orderBy('observed_at', 'desc')
    .limit(500)
    .execute();
  return rows.map(rowToFact);
}

/** Manifest names per ecosystem (`*` suffix = prefix match, leading `.` = suffix match). */
const MANIFESTS: Record<Exclude<FactEcosystem, 'other'>, readonly string[]> = {
  npm: ['package.json'],
  pypi: ['requirements*', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile'],
  cargo: ['Cargo.toml'],
  go: ['go.mod'],
  pub: ['pubspec.yaml'],
  maven: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  rubygems: ['Gemfile', '.gemspec'],
  nuget: ['.csproj', '.fsproj', 'Directory.Packages.props', 'packages.config'],
  composer: ['composer.json'],
  hex: ['mix.exs'],
};

export function manifestEcosystem(fileName: string): Exclude<FactEcosystem, 'other'> | undefined {
  for (const [eco, names] of Object.entries(MANIFESTS) as [Exclude<FactEcosystem, 'other'>, readonly string[]][]) {
    for (const n of names) {
      if (n.endsWith('*') ? fileName.startsWith(n.slice(0, -1)) : n.startsWith('.') ? fileName.endsWith(n) : fileName === n) return eco;
    }
  }
  return undefined;
}

export interface ManifestText {
  path: string;
  text: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A selected fact plus the version of its subject the repository resolves to (when known). */
export type SelectedEcosystemFact = EcosystemFact & { repoVersion?: string };

/**
 * Facts whose `subject` appears by full name in a same-ecosystem manifest (`other` checks all;
 * maven also matches the artifact of `group:artifact`). A fact is dropped only when the repo's
 * resolved version is known, the fact's range parses, and they don't overlap. Lockfiles are used
 * for versions only, never for name matching, so transitive deps don't count as direct ones.
 */
export function selectFactsForManifests(
  facts: readonly EcosystemFact[],
  manifests: readonly ManifestText[],
  max = 15,
): SelectedEcosystemFact[] {
  const byEco = new Map<string, string[]>();
  for (const m of manifests) {
    const eco = manifestEcosystem(m.path.split('/').pop() ?? '');
    if (!eco) continue;
    byEco.set(eco, [...(byEco.get(eco) ?? []), m.text]);
  }
  const all = [...byEco.values()].flat();
  const out: SelectedEcosystemFact[] = [];
  for (const f of facts) {
    const texts = f.ecosystem === 'other' ? all : (byEco.get(f.ecosystem) ?? []);
    if (texts.length === 0) continue;
    const names = [f.subject, ...(f.ecosystem === 'maven' && f.subject.includes(':') ? [f.subject.split(':').pop()!] : [])];
    const hit = names.some((n) => {
      const re = new RegExp(`(?<![\\w.-])${escapeRegExp(n)}(?![\\w-])`, 'i');
      return texts.some((t) => re.test(t));
    });
    if (!hit) continue;
    const repoVersion = resolvedVersion(f.ecosystem, f.subject, manifests);
    if (repoVersion && f.versions && satisfies(repoVersion, f.versions) === false) continue;
    out.push(repoVersion ? { ...f, repoVersion } : f);
    if (out.length >= max) break;
  }
  return out;
}

/** Details longer than this are not inlined; the line points at `knowledge_read <id>` instead. */
export const FACT_DETAIL_INLINE_MAX = 300;

/** Facts whose detail is only reachable through `knowledge_read` (see formatEcosystemFacts). */
export function factsWithLongDetail(facts: readonly SelectedEcosystemFact[]): SelectedEcosystemFact[] {
  return facts.filter((f) => (f.detail?.length ?? 0) > FACT_DETAIL_INLINE_MAX);
}

/** Prompt text: one-line claim, indented detail (or a knowledge_read pointer), sources and observation date. */
export function formatEcosystemFacts(facts: readonly SelectedEcosystemFact[]): string | undefined {
  if (facts.length === 0) return undefined;
  return facts
    .map((f) => {
      // The repo's own version next to the fact's range, so the model need not look it up.
      const used = f.repoVersion ? `; repo uses ${f.repoVersion}` : f.versions ? '; repo version unknown' : '';
      const head = `- [${f.ecosystem}] ${f.subject}${f.versions ? ` (${f.versions}${used})` : f.repoVersion ? ` (repo uses ${f.repoVersion})` : ''}: ${f.claim}`;
      const detail = !f.detail
        ? ''
        : f.detail.length > FACT_DETAIL_INLINE_MAX
          ? `\n  details: [read: knowledge_read ${f.id}]`
          : `\n  ${f.detail.replace(/\n/g, '\n  ')}`;
      const src = `\n  sources: ${f.sources.join(' ')} (as of ${f.observedAt.toISOString().slice(0, 10)})`;
      return `${head}${detail}${src}`;
    })
    .join('\n');
}
