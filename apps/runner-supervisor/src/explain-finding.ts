import {
  languageInstruction,
  runAgentInvocation,
  Type,
  type Model,
  type Static,
  type StreamFn,
} from '@reviewbot/agent-pi';
import { createHash } from 'node:crypto';
import { isAtLeast, type ConfirmationLevel } from '@reviewbot/findings';
import { uuidv7 } from '@reviewbot/ids';
import { sql, type Db } from '@reviewbot/db';
import type { ChangeRequestRef } from '@reviewbot/domain';
import type { PromptBundle } from '@reviewbot/prompts';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { botMessages } from './locale.js';
import { JobExecutionError, type JobHandler } from './supervisor.js';

export interface ExplainFindingPayload {
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
  /** Comment target: PR top level or a finding's inline thread. */
  targetKind: 'change-request' | 'review-thread';
  targetNativeId: string;
  /** Explicit finding (known inside a review thread); otherwise picked by anchor/severity. */
  findingId?: string;
  /** File path of the inline comment, used to pick the most relevant finding. */
  anchorPath?: string;
  /**
   * Native id of the triggering comment (request identity in the idempotency key): asking again gets a new
   * answer, a job retry does not post twice. Without it, falls back to finding+CR.
   */
  requestId?: string;
}

const SUBMIT_EXPLANATION = Type.Object({
  explanation: Type.String({ description: 'Markdown explanation for the requester.' }),
});

interface FindingDetail {
  id: string;
  category: string;
  claim: string;
  severity: string;
  changeRelation: string;
  confirmation: string;
  revisionId: string;
  path?: string;
  line?: number;
}

/** A finding's canonical info + latest occurrence (severity/anchor/confirmation). */
async function loadDetail(
  db: Db,
  payload: ExplainFindingPayload,
  findingId: string,
): Promise<FindingDetail | null> {
  const row = await db
    .selectFrom('findings as finding')
    .innerJoin('finding_occurrences as occurrence', 'occurrence.finding_id', 'finding.id')
    .innerJoin('revisions as revision', 'revision.id', 'occurrence.revision_id')
    .select([
      'finding.id as id',
      'finding.category as category',
      'finding.canonical_claim as canonical_claim',
      'occurrence.severity as severity',
      'occurrence.change_relation as change_relation',
      'occurrence.confirmation as confirmation',
      'occurrence.anchor as anchor',
      'occurrence.revision_id as revision_id',
    ])
    .where('finding.id', '=', findingId)
    .where('finding.tenant_id', '=', payload.tenantId)
    .where('finding.repository_id', '=', payload.repositoryId)
    .where('occurrence.tenant_id', '=', payload.tenantId)
    .where('revision.tenant_id', '=', payload.tenantId)
    .where('revision.change_request_id', '=', payload.changeRequestId)
    .orderBy('occurrence.created_at', 'desc')
    .execute();
  const verified = row.find((candidate) =>
    isAtLeast(candidate.confirmation as ConfirmationLevel, 'independently-verified'),
  );
  if (!verified) return null;
  const anchor = (verified.anchor as { path?: string; line?: number } | null) ?? null;
  return {
    id: verified.id,
    category: verified.category,
    claim: verified.canonical_claim,
    severity: verified.severity,
    changeRelation: verified.change_relation,
    confirmation: verified.confirmation,
    revisionId: verified.revision_id,
    ...(anchor?.path ? { path: anchor.path } : {}),
    ...(anchor?.line !== undefined ? { line: anchor.line } : {}),
  };
}

/** Picks the finding: explicit findingId → highest-severity active finding at the inline path → highest overall. */
async function selectFinding(
  db: Db,
  payload: ExplainFindingPayload,
): Promise<FindingDetail | null> {
  if (payload.findingId) return loadDetail(db, payload, payload.findingId);
  let query = db
    .selectFrom('findings as finding')
    .innerJoin('finding_occurrences as occurrence', (join) =>
      join
        .onRef('occurrence.finding_id', '=', 'finding.id')
        .onRef('occurrence.tenant_id', '=', 'finding.tenant_id'),
    )
    .innerJoin('revisions as revision', (join) =>
      join
        .onRef('revision.id', '=', 'occurrence.revision_id')
        .onRef('revision.tenant_id', '=', 'occurrence.tenant_id'),
    )
    .select([
      'finding.id as id',
      'finding.category as category',
      'finding.canonical_claim as canonical_claim',
      'occurrence.severity as severity',
      'occurrence.change_relation as change_relation',
      'occurrence.confirmation as confirmation',
      'occurrence.anchor as anchor',
      'occurrence.revision_id as revision_id',
    ])
    .where('finding.tenant_id', '=', payload.tenantId)
    .where('finding.repository_id', '=', payload.repositoryId)
    .where('finding.lifecycle', 'in', ['new', 'published', 'persisted', 'moved', 'modified'])
    .where('occurrence.tenant_id', '=', payload.tenantId)
    .where('occurrence.confirmation', 'in', ['independently-verified', 'tool-confirmed'])
    .where('revision.tenant_id', '=', payload.tenantId)
    .where('revision.change_request_id', '=', payload.changeRequestId);
  if (payload.anchorPath) {
    query = query.orderBy(
      sql`case when occurrence.anchor->>'path' = ${payload.anchorPath} then 0 else 1 end`,
    );
  }
  const row = await query
    .orderBy(
      sql`case occurrence.severity when 'critical' then 5 when 'high' then 4 when 'medium' then 3 when 'low' then 2 else 1 end`,
      'desc',
    )
    .orderBy('occurrence.created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const anchor = (row.anchor as { path?: string; line?: number } | null) ?? null;
  return {
    id: row.id,
    category: row.category,
    claim: row.canonical_claim,
    severity: row.severity,
    changeRelation: row.change_relation,
    confirmation: row.confirmation,
    revisionId: row.revision_id,
    ...(anchor?.path ? { path: anchor.path } : {}),
    ...(anchor?.line !== undefined ? { line: anchor.line } : {}),
  };
}

function findingPrompt(d: FindingDetail): string {
  return [
    `Finding ${d.id}`,
    `Claim: ${d.claim}`,
    `Category: ${d.category}`,
    `Severity: ${d.severity}`,
    `Change relation: ${d.changeRelation}`,
    `Confirmation level: ${d.confirmation}`,
    d.path ? `Anchor: ${d.path}${d.line !== undefined ? `:${d.line}` : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface ExplainFindingDeps {
  bundle: PromptBundle;
  /** Model source (production: resolveModelSourceFromEnv; tests: faux). */
  modelSource: () =>
    | { model: Model<string>; streamFn: StreamFn }
    | Promise<{ model: Model<string>; streamFn: StreamFn }>;
  /** Builds an authed Provider for a repositoryId. */
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
}

/**
 * Publish idempotency key ('none' when no finding). Must include the triggering request, or a second
 * `@winnowl explain` hits the earlier published record and is skipped; retries reuse the same key.
 */
function explainKey(findingId: string, changeRequestId: string, requestId?: string): string {
  return `explain:${findingId}:${changeRequestId}${requestId ? `:${requestId}` : ''}`;
}

async function publishExplanation(
  db: Db,
  provider: SourceControlProvider,
  payload: ExplainFindingPayload,
  ref: ChangeRequestRef,
  providerHostId: string,
  finding: FindingDetail | null,
  markdown: string,
  key: string,
): Promise<void> {
  const idempotencyKey =
    payload.targetKind === 'review-thread' ? `${key}:thread:${payload.targetNativeId}` : key;
  const now = new Date();
  const digest = createHash('sha256').update(markdown).digest('hex');
  const inserted = await db
    .insertInto('publication_records')
    .values({
      id: uuidv7(now.getTime()),
      tenant_id: payload.tenantId,
      repository_id: payload.repositoryId,
      change_request_id: payload.changeRequestId,
      finding_id: finding?.id ?? null,
      revision_id: finding?.revisionId ?? null,
      provider_host_id: providerHostId,
      kind: 'explanation',
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
  const publication = inserted
    ? { id: inserted.id, state: 'pending', provider_native_id: null }
    : await db
        .selectFrom('publication_records')
        .select(['id', 'state', 'provider_native_id'])
        .where('provider_host_id', '=', providerHostId)
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirstOrThrow();
  if (publication.state === 'published') return;

  const marker = `<!-- winnowl:explanation=${publication.id} -->`;
  if (!inserted) {
    const existing =
      payload.targetKind === 'review-thread'
        ? (await provider.discussions.listThreads({ kind: 'change-request', ref }))
            .find((thread) => thread.ref.nativeId === payload.targetNativeId)
            ?.comments.find((comment) => comment.isBot && comment.body.includes(marker))
        : provider.discussions.listTopLevelComments
          ? (await provider.discussions.listTopLevelComments({ kind: 'change-request', ref })).find(
              (comment) => comment.isBot && comment.body.includes(marker),
            )
          : (() => {
              throw new JobExecutionError(
                'cannot reconcile a pending explanation without comment listing support',
                'retryable_provider',
                true,
              );
            })();
    if (existing) {
      await db
        .updateTable('publication_records')
        .set({ state: 'published', provider_native_id: existing.nativeId, updated_at: now })
        .where('id', '=', publication.id)
        .execute();
      return;
    }
  }

  const body = `${markdown}\n\n${marker}`;
  let receipt: { nativeId: string; url?: string };
  if (payload.targetKind === 'review-thread') {
    receipt = await provider.discussions.reply(
      { nativeId: payload.targetNativeId, changeRequest: ref },
      { markdown: body },
      { key: idempotencyKey },
    );
  } else {
    receipt = await provider.discussions.createTopLevelComment(
      { kind: 'change-request', ref },
      { markdown: body },
      { key: idempotencyKey },
    );
  }
  await db
    .updateTable('publication_records')
    .set({
      state: 'published',
      provider_native_id: receipt.nativeId,
      provider_url: receipt.url ?? null,
      updated_at: now,
    })
    .where('id', '=', publication.id)
    .execute();
}

/**
 * explain_finding: explains an already-verified finding without reopening the investigation; a fresh
 * explainer invocation (no source tools) posts to the comment thread. Comment-only, no side effects.
 */
export function createExplainFindingHandler(deps: ExplainFindingDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as ExplainFindingPayload;
    if (payload.tenantId !== job.tenantId) throw new Error('explain_finding tenantId mismatch');

    const cr = await db
      .selectFrom('change_requests')
      .select(['id', 'repository_id', 'native_id', 'number', 'kind'])
      .where('id', '=', payload.changeRequestId)
      .where('tenant_id', '=', payload.tenantId)
      .where('repository_id', '=', payload.repositoryId)
      .executeTakeFirst();
    if (!cr) return;

    const repository = await db
      .selectFrom('repositories')
      .select('provider_host_id')
      .where('id', '=', payload.repositoryId)
      .where('tenant_id', '=', payload.tenantId)
      .executeTakeFirst();
    if (!repository) return;

    const provider = await deps.buildProvider(payload.repositoryId);
    const ref: ChangeRequestRef = {
      id: cr.id,
      repositoryId: cr.repository_id,
      nativeId: cr.native_id,
      number: cr.number,
      kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
    };

    // Output language follows repository config; omitted means English.
    const language = (await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId))
      .language;
    const em = botMessages(language).explain;

    const detail = await selectFinding(db, payload);
    if (!detail) {
      await publishExplanation(
        db,
        provider,
        payload,
        ref,
        repository.provider_host_id,
        null,
        em.noFinding(),
        explainKey('none', cr.id, payload.requestId),
      );
      return;
    }

    const model = await deps.modelSource();
    const result = await runAgentInvocation({
      systemPrompt: deps.bundle.system + languageInstruction(language, 'the explanation'),
      task: `${deps.bundle.task}\n\n${findingPrompt(detail)}`,
      model: model.model,
      streamFn: model.streamFn,
      readTools: [],
      finalization: {
        name: 'submit_explanation',
        description: 'Submit the explanation for the requester.',
        label: 'Submit explanation',
        schema: SUBMIT_EXPLANATION,
      },
      budget: { maxTurns: 3, maxToolCalls: 2 },
    });

    const explanation =
      result.status === 'complete' && result.finalization
        ? (result.finalization as Static<typeof SUBMIT_EXPLANATION>).explanation
        : em.cannotGenerate({ claim: detail.claim });

    await publishExplanation(
      db,
      provider,
      payload,
      ref,
      repository.provider_host_id,
      detail,
      explanation,
      explainKey(detail.id, cr.id, payload.requestId),
    );
    log('explain_finding published', { changeRequestId: cr.id, findingId: detail.id });
  };
}
