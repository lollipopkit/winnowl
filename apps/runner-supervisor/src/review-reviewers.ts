import type { Db } from '@reviewbot/db';
import type { Actor, ChangeRequest, RepositoryRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import type { ChangedFile, RepositoryPermission, SourceControlProvider } from '@reviewbot/provider-contracts';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import type { ReviewRevisionContext } from './review-revision.js';
import { loadRepositoryRef } from './repository-ref.js';

/** Only the most-changed files: one commits API call per file. */
const MAX_FILES = 10;
/** Recent commits fetched per file. */
const COMMITS_PER_FILE = 20;
/** Half-life of a commit's contribution. */
const HALF_LIFE_DAYS = 180;
/** Authors inactive on these files for longer are ignored. */
const MAX_AGE_DAYS = 365;
const DAY_MS = 86_400_000;
const WRITE: ReadonlySet<RepositoryPermission> = new Set(['admin', 'maintain', 'write']);

export interface SuggestReviewersInput {
  provider: SourceControlProvider;
  repo: RepositoryRef;
  changeRequest: ChangeRequest;
  files: ChangedFile[];
  /** The bot's own account: it edits files (stacked fix) but cannot be requested. */
  bot: Actor;
  max: number;
  now: number;
}

/**
 * Suggests reviewers who recently changed this PR's files, scored by changed-line share × time decay.
 * Uses the provider commits API rather than `git blame` (blame yields emails, not accounts). Candidates
 * need write permission (read-only users cannot approve). Unsupported providers (GitLab) → empty.
 */
export async function suggestReviewers(input: SuggestReviewersInput): Promise<Actor[]> {
  const repos = input.provider.repositories;
  if (!repos.listPathCommitAuthors || !repos.getActorPermission) return [];

  // New files have no history; renamed files use the old path (history on base lives there).
  const weighted = input.files
    .filter((f) => f.status !== 'added' && f.status !== 'binary')
    .map((f) => ({ path: f.oldPath ?? f.newPath, weight: f.additions + f.deletions }))
    .filter((f): f is { path: string; weight: number } => !!f.path && f.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_FILES);
  const total = weighted.reduce((sum, f) => sum + f.weight, 0);
  if (total === 0) return [];

  const excluded = new Set([input.changeRequest.author.providerUserId, input.bot.providerUserId]);
  const scores = new Map<string, { actor: Actor; score: number }>();
  const histories = await Promise.all(
    weighted.map((f) =>
      repos.listPathCommitAuthors!(input.repo, f.path, { gitRef: input.changeRequest.revision.baseSha, limit: COMMITS_PER_FILE }),
    ),
  );
  weighted.forEach((f, i) => {
    for (const { actor, committedAt } of histories[i]!) {
      const ageDays = (input.now - Date.parse(committedAt)) / DAY_MS;
      if (actor.type !== 'user' || excluded.has(actor.providerUserId) || !(ageDays <= MAX_AGE_DAYS)) continue;
      const entry = scores.get(actor.providerUserId) ?? { actor, score: 0 };
      entry.score += (f.weight / total) * 0.5 ** (Math.max(ageDays, 0) / HALF_LIFE_DAYS);
      scores.set(actor.providerUserId, entry);
    }
  });

  const picked: Actor[] = [];
  for (const { actor } of [...scores.values()].sort((a, b) => b.score - a.score)) {
    if (picked.length >= input.max) break;
    if (WRITE.has(await repos.getActorPermission(input.repo, actor))) picked.push(actor);
  }
  return picked;
}

const KIND = 'reviewer-request';

/**
 * Requests suggested reviewers at most once per PR, and only when it has none: no pending requests and
 * no submitted review besides the author and bot (submitters leave the requested list). Recorded in
 * publication_records so an author's removal is respected.
 */
export async function requestReviewersOnce(input: {
  db: Db;
  provider: SourceControlProvider;
  changeRequest: ChangeRequest;
  reviewers: Actor[];
  bot: Actor;
  tenantId: string;
  providerHostId: string;
}): Promise<boolean> {
  const { changeRequest: cr } = input;
  const request = input.provider.changes.requestReviewers;
  if (!request || input.reviewers.length === 0 || cr.state !== 'open' || cr.draft || cr.reviewers.length > 0) return false;

  const key = `${KIND}:${cr.ref.id}`;
  const done = await input.db
    .selectFrom('publication_records')
    .select('id')
    .where('provider_host_id', '=', input.providerHostId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
  if (done) return false;

  const reviews = await input.provider.changes.listReviews(cr.ref);
  const skip = new Set([cr.author.providerUserId, input.bot.providerUserId]);
  if (reviews.some((r) => r.author.type === 'user' && !skip.has(r.author.providerUserId))) return false;

  await request(cr.ref, input.reviewers);
  const now = new Date();
  await input.db
    .insertInto('publication_records')
    .values({
      id: uuidv7(now.getTime()),
      tenant_id: input.tenantId,
      repository_id: cr.ref.repositoryId,
      change_request_id: cr.ref.id,
      finding_id: null,
      revision_id: null,
      provider_host_id: input.providerHostId,
      kind: KIND,
      idempotency_key: key,
      provider_native_id: null,
      provider_url: null,
      state: 'published',
      request_digest: input.reviewers.map((r) => r.login).join(','),
      response: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['provider_host_id', 'idempotency_key']).doNothing())
    .execute();
  return true;
}

export interface ReviewerSuggestion {
  logins: string[];
  /** Requested on the PR this round. */
  requested: boolean;
}

/** Suggests / requests reviewers per `reviews.reviewers` after a review; the status comment shows the result. */
export function createReviewerSuggester(deps: {
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
  now?: () => number;
}): (ctx: ReviewRevisionContext) => Promise<ReviewerSuggestion | undefined> {
  return async (ctx) => {
    const cfg = (await loadEffectiveConfig(ctx.db, ctx.payload.tenantId, ctx.payload.repositoryId)).reviews.reviewers;
    if (cfg.mode === 'off') return undefined;
    const provider = await deps.buildProvider(ctx.payload.repositoryId);
    const [repo, changeRequest, files, bot] = await Promise.all([
      loadRepositoryRef(ctx.db, ctx.payload.repositoryId),
      provider.changes.get(ctx.changeRequest),
      provider.changes.listChangedFiles(ctx.changeRequest),
      provider.identity.botActor(),
    ]);
    const reviewers = await suggestReviewers({ provider, repo, changeRequest, files, bot, max: cfg.max, now: deps.now?.() ?? Date.now() });
    if (reviewers.length === 0) return undefined;
    const requested =
      cfg.mode === 'request' &&
      (await requestReviewersOnce({
        db: ctx.db,
        provider,
        changeRequest,
        reviewers,
        bot,
        tenantId: ctx.payload.tenantId,
        providerHostId: ctx.providerHostId,
      }));
    return { logins: reviewers.map((r) => r.login), requested };
  };
}
