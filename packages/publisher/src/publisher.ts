import { createHash } from 'node:crypto';
import type { ChangeRequestRef } from '@reviewbot/domain';
import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import {
  ProviderError,
  type DiscussionApi,
  type ProviderAnchor,
} from '@reviewbot/provider-contracts';
import { hasTopLevelMarker, parsePublicationMarker, publicationMarker, topLevelMarker } from './markers.js';

export interface PublishContext {
  db: Db;
  discussions: Pick<DiscussionApi, 'createInlineComment' | 'listThreads' | 'createTopLevelComment'> &
    Partial<Pick<DiscussionApi, 'createReviewBatch' | 'editComment' | 'listTopLevelComments'>>;
  fetchCurrentHeadSha: () => Promise<string>;
  now?: () => number;
}

export interface PublishInlineInput {
  tenantId: string;
  repositoryId: string;
  changeRequest: ChangeRequestRef;
  changeRequestId: string;
  revisionId: string;
  revisionSha: string;
  providerHostId: string;
  findingId: string;
  anchor: ProviderAnchor;
  bodyMarkdown: string;
  /** Publishing is refused when the current head differs. */
  expectedHeadSha: string;
  /** See `PublishReviewBatchInput.idempotencyScope`. */
  idempotencyScope?: string;
}

export type PublishResult =
  | { status: 'published'; publicationId: string; nativeId: string; url?: string; recovered?: boolean }
  | { status: 'duplicate'; publicationId: string }
  | { status: 'superseded' }
  | { status: 'degraded'; reason: string; publicationId: string };

function requestDigest(input: PublishInlineInput): string {
  return createHash('sha256')
    .update(input.bodyMarkdown + JSON.stringify(input.anchor), 'utf8')
    .digest('hex');
}

/** Idempotency key plus optional scope (see `PublishReviewBatchInput.idempotencyScope`). */
function scopedKey(key: string, scope?: string): string {
  return scope ? `${key}#${scope}` : key;
}

function idempotencyKeyFor(input: PublishInlineInput): string {
  return `inline:${input.findingId}:${input.revisionId}`;
}

/** Finds the comment in a thread carrying the given publicationId marker. */
async function findPublishedMarker(
  ctx: PublishContext,
  ref: ChangeRequestRef,
  publicationId: string,
): Promise<{ nativeId: string } | null> {
  const threads = await ctx.discussions.listThreads({ kind: 'change-request', ref });
  for (const thread of threads) {
    for (const comment of thread.comments) {
      const marker = parsePublicationMarker(comment.body);
      if (marker?.publicationId === publicationId) {
        return { nativeId: comment.nativeId };
      }
    }
  }
  return null;
}

/** Idempotent inline publish: head recheck, insert pending, reconcile after a crash, publish, mark published. */
export async function publishInlineComment(
  ctx: PublishContext,
  input: PublishInlineInput,
): Promise<PublishResult> {
  // Head moved: refuse to publish a stale result.
  const currentHead = await ctx.fetchCurrentHeadSha();
  if (currentHead !== input.expectedHeadSha) {
    return { status: 'superseded' };
  }

  const now = new Date(ctx.now?.() ?? Date.now());
  const idempotencyKey = idempotencyKeyFor(input);
  const digest = requestDigest(input);

  // A unique-key conflict means it already exists.
  const inserted = await ctx.db
    .insertInto('publication_records')
    .values({
      id: uuidv7(now.getTime()),
      tenant_id: input.tenantId,
      repository_id: input.repositoryId,
      change_request_id: input.changeRequestId,
      finding_id: input.findingId,
      revision_id: input.revisionId,
      provider_host_id: input.providerHostId,
      kind: 'inline',
      idempotency_key: idempotencyKey,
      provider_native_id: null,
      provider_url: null,
      state: 'pending',
      request_digest: digest,
      response: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['provider_host_id', 'idempotency_key']).doNothing())
    .returning('id')
    .executeTakeFirst();

  let publicationId: string;
  if (inserted) {
    publicationId = inserted.id;
  } else {
    const existing = await ctx.db
      .selectFrom('publication_records')
      .select(['id', 'state'])
      .where('provider_host_id', '=', input.providerHostId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow();
    if (existing.state === 'published') {
      return { status: 'duplicate', publicationId: existing.id };
    }
    // Pending from a crashed run: reconcile with the provider first to avoid duplicates.
    publicationId = existing.id;
    const found = await findPublishedMarker(ctx, input.changeRequest, publicationId);
    if (found) {
      await markPublished(ctx, publicationId, found.nativeId, undefined, now);
      return { status: 'published', publicationId, nativeId: found.nativeId, recovered: true };
    }
  }

  const marker = publicationMarker({
    findingId: input.findingId,
    revision: input.revisionSha,
    publicationId,
  });
  const body = `${input.bodyMarkdown}\n\n${marker}`;

  try {
    const receipt = await ctx.discussions.createInlineComment(
      input.changeRequest,
      input.anchor,
      { markdown: body },
      { key: idempotencyKey },
    );
    await markPublished(ctx, publicationId, receipt.nativeId, receipt.url, now);
    return { status: 'published', publicationId, nativeId: receipt.nativeId, ...(receipt.url ? { url: receipt.url } : {}) };
  } catch (error) {
    if (error instanceof ProviderError && error.status !== undefined && error.status >= 400 && error.status < 500) {
      // Provider 4xx: degrade to the summary instead of retrying inline; always record the error response.
      await ctx.db
        .updateTable('publication_records')
        .set({
          state: 'failed',
          response: { status: error.status, message: String((error as Error).message).slice(0, 1000) },
          updated_at: now,
        })
        .where('id', '=', publicationId)
        .execute();
      return { status: 'degraded', reason: `provider_${error.status}`, publicationId };
    }
    throw error;
  }
}

export interface PublishSummaryInput {
  tenantId: string;
  repositoryId: string;
  changeRequest: ChangeRequestRef;
  changeRequestId: string;
  revisionId: string;
  revisionSha: string;
  providerHostId: string;
  bodyMarkdown: string;
  /** Publishing is refused when the current head differs. */
  expectedHeadSha: string;
  /** See `PublishReviewBatchInput.idempotencyScope`. */
  idempotencyScope?: string;
}

/** Idempotent top-level summary comment, one per revision (`summary:{revisionId}`). */
export async function publishSummaryComment(
  ctx: PublishContext,
  input: PublishSummaryInput,
): Promise<PublishResult> {
  const currentHead = await ctx.fetchCurrentHeadSha();
  if (currentHead !== input.expectedHeadSha) {
    return { status: 'superseded' };
  }

  const now = new Date(ctx.now?.() ?? Date.now());
  const idempotencyKey = scopedKey(`summary:${input.revisionId}`, input.idempotencyScope);
  const digest = createHash('sha256').update(input.bodyMarkdown, 'utf8').digest('hex');

  const inserted = await ctx.db
    .insertInto('publication_records')
    .values({
      id: uuidv7(now.getTime()),
      tenant_id: input.tenantId,
      repository_id: input.repositoryId,
      change_request_id: input.changeRequestId,
      finding_id: null, // a summary covers many findings
      revision_id: input.revisionId,
      provider_host_id: input.providerHostId,
      kind: 'summary',
      idempotency_key: idempotencyKey,
      provider_native_id: null,
      provider_url: null,
      state: 'pending',
      request_digest: digest,
      response: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['provider_host_id', 'idempotency_key']).doNothing())
    .returning('id')
    .executeTakeFirst();

  let publicationId: string;
  if (inserted) {
    publicationId = inserted.id;
  } else {
    const existing = await ctx.db
      .selectFrom('publication_records')
      .select(['id', 'state'])
      .where('provider_host_id', '=', input.providerHostId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow();
    if (existing.state === 'published') {
      return { status: 'duplicate', publicationId: existing.id };
    }
    publicationId = existing.id;
    const found = await findPublishedMarker(ctx, input.changeRequest, publicationId);
    if (found) {
      await markPublished(ctx, publicationId, found.nativeId, undefined, now);
      return { status: 'published', publicationId, nativeId: found.nativeId, recovered: true };
    }
  }

  const marker = publicationMarker({ findingId: 'summary', revision: input.revisionSha, publicationId });
  const body = `${input.bodyMarkdown}\n\n${marker}`;

  try {
    const receipt = await ctx.discussions.createTopLevelComment(
      { kind: 'change-request', ref: input.changeRequest },
      { markdown: body },
      { key: idempotencyKey },
    );
    await markPublished(ctx, publicationId, receipt.nativeId, receipt.url, now);
    return { status: 'published', publicationId, nativeId: receipt.nativeId, ...(receipt.url ? { url: receipt.url } : {}) };
  } catch (error) {
    if (error instanceof ProviderError && error.status !== undefined && error.status >= 400 && error.status < 500) {
      // Always record the error response on a 4xx.
      await ctx.db
        .updateTable('publication_records')
        .set({
          state: 'failed',
          response: { status: error.status, message: String((error as Error).message).slice(0, 1000) },
          updated_at: now,
        })
        .where('id', '=', publicationId)
        .execute();
      return { status: 'degraded', reason: `provider_${error.status}`, publicationId };
    }
    throw error;
  }
}

export interface PublishReviewBatchInput {
  tenantId: string;
  repositoryId: string;
  changeRequest: ChangeRequestRef;
  changeRequestId: string;
  revisionId: string;
  revisionSha: string;
  providerHostId: string;
  /** Default `comment`; `approve` without blocking findings; `request-changes` only with merge gate + blocking. */
  event: 'comment' | 'approve' | 'request-changes';
  summaryMarkdown: string;
  comments: { findingId: string; anchor: ProviderAnchor; bodyMarkdown: string }[];
  expectedHeadSha: string;
  /**
   * Default: one review per revision, so job retries do not spam. A manual `@bot review` passes its job
   * id so its retries stay idempotent while a new command posts a new review.
   */
  idempotencyScope?: string;
}

export type PublishBatchResult = PublishResult & { publishedComments?: number };

/**
 * Records a finding <-> comment row per inline comment after a batch publish, since the provider
 * returns only one review id; replies that look up the finding by comment depend on it. Same keys as
 * the per-comment path (`inline:<findingId>:<revisionId>`). Failures never affect the published review.
 */
async function backfillInlinePublications(
  ctx: PublishContext,
  input: PublishReviewBatchInput,
  publicationId: string,
  now: Date,
): Promise<number> {
  const threads = await ctx.discussions.listThreads({ kind: 'change-request', ref: input.changeRequest });
  let filled = 0;
  for (const thread of threads) {
    for (const comment of thread.comments) {
      const marker = parsePublicationMarker(comment.body);
      // Only inline comments from this publish; the summary uses the placeholder findingId 'review'.
      if (!marker || marker.publicationId !== publicationId || marker.findingId === 'review') continue;
      await ctx.db
        .insertInto('publication_records')
        .values({
          id: uuidv7(now.getTime()),
          tenant_id: input.tenantId,
          repository_id: input.repositoryId,
          change_request_id: input.changeRequestId,
          finding_id: marker.findingId,
          revision_id: input.revisionId,
          provider_host_id: input.providerHostId,
          kind: 'inline',
          idempotency_key: scopedKey(`inline:${marker.findingId}:${input.revisionId}`, input.idempotencyScope),
          provider_native_id: comment.nativeId,
          provider_url: null,
          state: 'published',
          request_digest: '',
          response: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['provider_host_id', 'idempotency_key']).doUpdateSet({
            provider_native_id: comment.nativeId,
            state: 'published',
            updated_at: now,
          }),
        )
        .execute();
      filled += 1;
    }
  }
  return filled;
}

/**
 * Idempotently publishes one PR review combining the summary and inline comments (`review:{revisionId}`).
 * A review cannot be updated, so a leftover pending record is never republished. Without
 * `createReviewBatch` returns degraded (`provider_no_batch`) for the caller to fall back.
 */
export async function publishReviewBatch(
  ctx: PublishContext,
  input: PublishReviewBatchInput,
): Promise<PublishBatchResult> {
  const currentHead = await ctx.fetchCurrentHeadSha();
  if (currentHead !== input.expectedHeadSha) {
    return { status: 'superseded' };
  }
  if (!ctx.discussions.createReviewBatch) {
    return { status: 'degraded', reason: 'provider_no_batch', publicationId: '' };
  }

  const now = new Date(ctx.now?.() ?? Date.now());
  const idempotencyKey = scopedKey(`review:${input.revisionId}`, input.idempotencyScope);
  const digest = createHash('sha256')
    .update(input.summaryMarkdown + JSON.stringify(input.comments), 'utf8')
    .digest('hex');

  const inserted = await ctx.db
    .insertInto('publication_records')
    .values({
      id: uuidv7(now.getTime()),
      tenant_id: input.tenantId,
      repository_id: input.repositoryId,
      change_request_id: input.changeRequestId,
      finding_id: null,
      revision_id: input.revisionId,
      provider_host_id: input.providerHostId,
      kind: 'review',
      idempotency_key: idempotencyKey,
      provider_native_id: null,
      provider_url: null,
      state: 'pending',
      request_digest: digest,
      response: null,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['provider_host_id', 'idempotency_key']).doNothing())
    .returning('id')
    .executeTakeFirst();

  let publicationId: string;
  if (inserted) {
    publicationId = inserted.id;
  } else {
    const existing = await ctx.db
      .selectFrom('publication_records')
      .select(['id', 'state'])
      .where('provider_host_id', '=', input.providerHostId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirstOrThrow();
    if (existing.state === 'published') {
      return { status: 'duplicate', publicationId: existing.id };
    }
    // failed = the provider rejected it with a 4xx, so nothing was posted: reset to pending and retry.
    if (existing.state !== 'pending') {
      publicationId = existing.id;
      await ctx.db
        .updateTable('publication_records')
        .set({ state: 'pending', request_digest: digest, response: null, updated_at: now })
        .where('id', '=', existing.id)
        .execute();
    } else {
      // pending = a crash mid-publish may have posted it: do not republish.
      return { status: 'degraded', reason: 'pending_no_retry', publicationId: existing.id };
    }
  }

  const marker = publicationMarker({ findingId: 'review', revision: input.revisionSha, publicationId });
  const summary = { markdown: `${input.summaryMarkdown}\n\n${marker}` };
  const comments = input.comments.map((c) => ({
    anchor: c.anchor,
    body: {
      markdown: `${c.bodyMarkdown}\n\n${publicationMarker({ findingId: c.findingId, revision: input.revisionSha, publicationId })}`,
    },
  }));

  try {
    const receipt = await ctx.discussions.createReviewBatch(
      input.changeRequest,
      { event: input.event, summary, comments },
      { key: idempotencyKey },
    );
    await markPublished(ctx, publicationId, receipt.nativeId, receipt.url, now);
    // Backfill failure must not undo the published review: record it; the next review backfills again.
    if (comments.length > 0) {
      await backfillInlinePublications(ctx, input, publicationId, now).catch(async (err: unknown) => {
        await ctx.db
          .updateTable('publication_records')
          .set({ response: { backfill_failed: String((err as Error)?.message ?? err).slice(0, 500) }, updated_at: now })
          .where('id', '=', publicationId)
          .execute()
          .catch(() => undefined);
        return 0;
      });
    }
    return {
      status: 'published',
      publicationId,
      nativeId: receipt.nativeId,
      publishedComments: comments.length,
      ...(receipt.url ? { url: receipt.url } : {}),
    };
  } catch (error) {
    if (error instanceof ProviderError && error.status !== undefined && error.status >= 400 && error.status < 500) {
      // A 4xx on the whole batch (e.g. 422 for one unresolvable anchor) drops the summary and event too,
      // so retry with the summary/event only. Findings are already in the DB.
      if (comments.length > 0) {
        try {
          const receipt = await ctx.discussions.createReviewBatch(
            input.changeRequest,
            { event: input.event, summary, comments: [] },
            { key: idempotencyKey },
          );
          await markPublished(ctx, publicationId, receipt.nativeId, receipt.url, now);
          // Record which 4xx stripped the inline comments.
          await ctx.db
            .updateTable('publication_records')
            .set({
              response: { degraded: 'comments_dropped', status: error.status, message: String((error as Error).message).slice(0, 1000) },
              updated_at: now,
            })
            .where('id', '=', publicationId)
            .execute();
          return {
            status: 'published',
            publicationId,
            nativeId: receipt.nativeId,
            publishedComments: 0,
            ...(receipt.url ? { url: receipt.url } : {}),
          };
        } catch {
          // Still failing: fall through to the failed record below with the original error.
        }
      }
      // Always record the error response on a 4xx.
      await ctx.db
        .updateTable('publication_records')
        .set({
          state: 'failed',
          response: { status: error.status, message: String((error as Error).message).slice(0, 1000) },
          updated_at: now,
        })
        .where('id', '=', publicationId)
        .execute();
      return { status: 'degraded', reason: `provider_${error.status}`, publicationId };
    }
    throw error;
  }
}

async function markPublished(
  ctx: PublishContext,
  publicationId: string,
  nativeId: string,
  url: string | undefined,
  now: Date,
): Promise<void> {
  await ctx.db
    .updateTable('publication_records')
    .set({
      state: 'published',
      provider_native_id: nativeId,
      provider_url: url ?? null,
      updated_at: now,
    })
    .where('id', '=', publicationId)
    .execute();
}

/** Reconciles pending records for a change request via hidden markers; unmatched ones stay pending for retry. */
export async function reconcilePublications(
  ctx: PublishContext,
  input: { changeRequest: ChangeRequestRef; providerHostId: string; changeRequestId: string },
): Promise<{ recovered: number }> {
  const pending = await ctx.db
    .selectFrom('publication_records')
    .select(['id'])
    .where('provider_host_id', '=', input.providerHostId)
    .where('change_request_id', '=', input.changeRequestId)
    .where('state', '=', 'pending')
    .execute();
  if (pending.length === 0) return { recovered: 0 };

  const threads = await ctx.discussions.listThreads({ kind: 'change-request', ref: input.changeRequest });
  const byPublication = new Map<string, string>();
  for (const thread of threads) {
    for (const comment of thread.comments) {
      const marker = parsePublicationMarker(comment.body);
      if (marker) byPublication.set(marker.publicationId, comment.nativeId);
    }
  }

  const now = new Date(ctx.now?.() ?? Date.now());
  let recovered = 0;
  for (const record of pending) {
    const nativeId = byPublication.get(record.id);
    if (nativeId) {
      await markPublished(ctx, record.id, nativeId, undefined, now);
      recovered += 1;
    }
  }
  return { recovered };
}

export interface PublishTopLevelInput {
  tenantId: string;
  repositoryId: string;
  changeRequest: ChangeRequestRef;
  changeRequestId: string;
  providerHostId: string;
  /** Marker kind (e.g. `ci-analysis`); one rolling comment per (CR, kind). */
  kind: string;
  bodyMarkdown: string;
  /** Logins allowed to be pinged (see RichComment.mentions). */
  mentions?: readonly string[];
  /** Content fingerprint; unchanged from the last published record = skip. Omit to always upsert. */
  fingerprint?: string;
}

export type PublishTopLevelResult =
  | { status: 'published'; publicationId: string; nativeId: string; url?: string; created: boolean }
  | { status: 'unchanged'; publicationId: string }
  | { status: 'degraded'; reason: string; publicationId: string };

/**
 * Upserts one top-level comment per (CR, kind): edits in place on new heads, skips unchanged content.
 * Finds the comment by stored native_id, else by marker via listTopLevelComments, else creates one.
 */
export async function publishTopLevelComment(
  ctx: PublishContext,
  input: PublishTopLevelInput,
): Promise<PublishTopLevelResult> {
  const now = new Date(ctx.now?.() ?? Date.now());
  const idempotencyKey = `${input.kind}:${input.changeRequestId}`;
  const digest = input.fingerprint ?? createHash('sha256').update(input.bodyMarkdown, 'utf8').digest('hex');
  const marker = topLevelMarker(input.kind, input.changeRequestId);
  const body = `${input.bodyMarkdown}\n\n${marker}`;

  const existing = await ctx.db
    .selectFrom('publication_records')
    .select(['id', 'state', 'request_digest', 'provider_native_id'])
    .where('provider_host_id', '=', input.providerHostId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();

  if (existing && existing.state === 'published' && existing.request_digest === digest) {
    return { status: 'unchanged', publicationId: existing.id };
  }

  const publicationId = existing?.id ?? uuidv7(now.getTime());
  if (!existing) {
    await ctx.db
      .insertInto('publication_records')
      .values({
        id: publicationId,
        tenant_id: input.tenantId,
        repository_id: input.repositoryId,
        change_request_id: input.changeRequestId,
        finding_id: null,
        revision_id: null,
        provider_host_id: input.providerHostId,
        kind: input.kind,
        idempotency_key: idempotencyKey,
        provider_native_id: null,
        provider_url: null,
        state: 'pending',
        request_digest: digest,
        response: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['provider_host_id', 'idempotency_key']).doNothing())
      .execute();
  }

  // Stored native_id first, then list by marker (covers lost records and older comments).
  let targetNativeId = existing?.provider_native_id ?? null;
  if (!targetNativeId && ctx.discussions.listTopLevelComments) {
    try {
      const comments = await ctx.discussions.listTopLevelComments({ kind: 'change-request', ref: input.changeRequest });
      const found = comments.find((c) => c.isBot && hasTopLevelMarker(c.body, input.kind, input.changeRequestId));
      if (found) targetNativeId = found.nativeId;
    } catch {
      // A failed list falls back to creating a new comment.
    }
  }

  try {
    if (targetNativeId && ctx.discussions.editComment) {
      await ctx.discussions.editComment(
        { nativeId: targetNativeId, changeRequest: input.changeRequest, scope: 'conversation' },
        { markdown: body, ...(input.mentions ? { mentions: input.mentions } : {}) },
      );
      await ctx.db
        .updateTable('publication_records')
        .set({ state: 'published', provider_native_id: targetNativeId, request_digest: digest, updated_at: now })
        .where('id', '=', publicationId)
        .execute();
      return { status: 'published', publicationId, nativeId: targetNativeId, created: false };
    }
    const receipt = await ctx.discussions.createTopLevelComment(
      { kind: 'change-request', ref: input.changeRequest },
      { markdown: body, ...(input.mentions ? { mentions: input.mentions } : {}) },
      { key: idempotencyKey },
    );
    await ctx.db
      .updateTable('publication_records')
      .set({ state: 'published', provider_native_id: receipt.nativeId, provider_url: receipt.url ?? null, request_digest: digest, updated_at: now })
      .where('id', '=', publicationId)
      .execute();
    return { status: 'published', publicationId, nativeId: receipt.nativeId, created: true, ...(receipt.url ? { url: receipt.url } : {}) };
  } catch (error) {
    if (error instanceof ProviderError && error.status !== undefined && error.status >= 400 && error.status < 500) {
      await ctx.db
        .updateTable('publication_records')
        .set({ state: 'failed', response: { status: error.status, message: String((error as Error).message).slice(0, 1000) }, updated_at: now })
        .where('id', '=', publicationId)
        .execute();
      return { status: 'degraded', reason: `provider_${error.status}`, publicationId };
    }
    throw error;
  }
}
