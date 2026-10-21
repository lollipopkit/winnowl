import type { Db } from '@reviewbot/db';
import { isBotActor, isOwnBotLogin, triggerTicked } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import { insertRevision, upsertChangeRequest, type ChangeRequestSnapshot } from '@reviewbot/provider-sync';
import { cancelReviewJobsForChangeRequest } from '@reviewbot/queue';
import type {
  ProviderChangeCoordinates,
  ProviderRepoCoordinates,
  ProviderWebhookEvent,
} from '@reviewbot/provider-contracts';
import type { ScheduleHint } from './schedule.js';
import type { IngestContext } from './types.js';

function repoOf(event: ProviderWebhookEvent): ProviderRepoCoordinates | null {
  switch (event.type) {
    case 'change-request.opened':
    case 'change-request.updated':
    case 'change-request.reopened':
    case 'change-request.ready':
    case 'change-request.closed':
    case 'change-request.merged':
      return event.change.repo;
    case 'comment.created':
      return event.target.kind === 'change-request' ? event.target.change.repo : event.target.repo;
    case 'comment.edited':
      return event.change.repo;
    case 'push.received':
    case 'pipeline.completed':
    case 'issue.opened':
      return event.repo;
    default:
      return null;
  }
}

const CI_FAILURE_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'startup_failure',
  'action_required',
]);

function changeOf(event: ProviderWebhookEvent): ProviderChangeCoordinates | null {
  switch (event.type) {
    case 'change-request.opened':
    case 'change-request.updated':
    case 'change-request.reopened':
    case 'change-request.ready':
    case 'change-request.closed':
    case 'change-request.merged':
      return event.change;
    case 'comment.created':
      return event.target.kind === 'change-request' ? event.target.change : null;
    case 'comment.edited':
      return event.change;
    default:
      return null;
  }
}

function stateOf(event: ProviderWebhookEvent): ChangeRequestSnapshot['state'] {
  switch (event.type) {
    case 'change-request.opened':
    case 'change-request.reopened':
    case 'change-request.ready':
      return 'open';
    case 'change-request.closed':
      return 'closed';
    case 'change-request.merged':
      return 'merged';
    default:
      return undefined;
  }
}

/** Read-only lookup by (repository, number, kind) for comment events; never creates a row. */
async function resolveChangeRequestByNumber(
  db: Db,
  repositoryId: string,
  number: number,
  kind: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('change_requests')
    .select('id')
    .where('repository_id', '=', repositoryId)
    .where('number', '=', number)
    .where('kind', '=', kind)
    .executeTakeFirst();
  return row?.id ?? null;
}

/** The change request as this event reports it. */
function snapshotOf(event: ProviderWebhookEvent, change: ProviderChangeCoordinates, now: Date): ChangeRequestSnapshot {
  const rawOccurredAt = 'occurredAt' in event ? event.occurredAt : undefined;
  const parsedOccurredAt = rawOccurredAt ? new Date(rawOccurredAt) : now;
  const observedAt = Number.isNaN(parsedOccurredAt.getTime()) ? now : parsedOccurredAt;
  const detailed = event.type === 'change-request.opened' || event.type === 'change-request.updated';
  // Refresh draft on every event that carries it, not only opened.
  const draft =
    event.type === 'change-request.opened' || event.type === 'change-request.updated'
      ? event.draft
      : event.type === 'change-request.ready'
        ? false
        : undefined;
  /*
   * Written from every payload with an author because opened can arrive late. Uses the event's `author`
   * field: on metadata events the actor is whoever labeled/pushed, not the author.
   */
  const author =
    event.type === 'change-request.updated'
      ? event.author
      : event.type === 'change-request.opened'
        ? event.actor
        : undefined;
  const state = stateOf(event);
  return {
    nativeId: change.nativeId,
    number: change.number,
    kind: change.kind,
    observedAt,
    ...(state !== undefined ? { state } : {}),
    ...(event.type === 'change-request.reopened' ? { reopened: true } : {}),
    ...(draft !== undefined ? { draft } : {}),
    // Backfilled from updated events too, for rows created before opened arrived.
    ...(detailed && event.sourceBranch ? { sourceBranch: event.sourceBranch } : {}),
    ...(detailed && event.targetBranch ? { targetBranch: event.targetBranch } : {}),
    ...(detailed && event.sourceIsFork !== undefined ? { sourceIsFork: event.sourceIsFork } : {}),
    ...(detailed && event.title !== undefined ? { title: event.title } : {}),
    ...(author ? { author: { login: author.login, ...(author.providerUserId ? { providerUserId: author.providerUserId } : {}), type: author.type } } : {}),
    ...(detailed && event.reviewers !== undefined
      ? { reviewers: event.reviewers.map((r) => ({ providerUserId: r.providerUserId, login: r.login })) }
      : {}),
    ...(detailed && event.labels !== undefined ? { labels: event.labels } : {}),
    ...(detailed && event.stack ? { stack: event.stack } : {}),
  };
}

function shouldSyncInstallation(action: string): boolean {
  return action === 'created' || action === 'repositories-changed' || action === 'unsuspended';
}

/** Persists a domain event, resolving repository/CR when already synced (otherwise repository_id = null). */
export async function persistDomainEvent(
  db: Db,
  ctx: IngestContext,
  providerEventId: string,
  event: ProviderWebhookEvent,
  now: Date,
): Promise<{ domainEventId: string; schedules: ScheduleHint[] }> {
  let repositoryId: string | null = null;
  let changeRequestId: string | null = null;
  let changeLifecycleApplied = true;
  const schedules: ScheduleHint[] = [];

  const repoCoords = repoOf(event);
  if (repoCoords) {
    const repo = await db
      .selectFrom('repositories')
      .where('provider_host_id', '=', ctx.providerHostId)
      .where('tenant_id', '=', ctx.tenantId)
      .where('native_id', '=', repoCoords.repoNativeId)
      .select(['id', 'default_branch'])
      .executeTakeFirst();
    if (repo) {
      repositoryId = repo.id;
      // Track default-branch renames after installation sync.
      if (repoCoords.defaultBranch && repoCoords.defaultBranch !== repo.default_branch) {
        await db
          .updateTable('repositories')
          .set({ default_branch: repoCoords.defaultBranch })
          .where('id', '=', repo.id)
          .execute();
      }
      const change = changeOf(event);
      if (change && (event.type === 'comment.created' || event.type === 'comment.edited')) {
        // Comments never upsert a CR: issue_comment carries issue.id, not pull_request.id, so upserting by
        // native_id would split one PR into two rows. Look it up by (repository, number, kind) instead.
        changeRequestId = await resolveChangeRequestByNumber(
          db,
          repositoryId,
          change.number,
          change.kind,
        );
      } else if (change) {
        const upserted = await upsertChangeRequest(
          db,
          { tenantId: ctx.tenantId, repositoryId },
          snapshotOf(event, change, now),
          now,
        );
        changeRequestId = upserted.id;
        changeLifecycleApplied = upserted.applied;
        const revision =
          changeLifecycleApplied &&
          (event.type === 'change-request.opened' || event.type === 'change-request.updated') &&
          event.headSha
            ? await insertRevision(
                db,
                { tenantId: ctx.tenantId, changeRequestId },
                {
                  baseSha: event.baseSha,
                  headSha: event.headSha,
                  ...(event.sourceBranch ? { sourceBranch: event.sourceBranch } : {}),
                  ...(event.targetBranch ? { targetBranch: event.targetBranch } : {}),
                },
                now,
              )
            : null;
        if (
          revision?.inserted &&
          (event.type === 'change-request.opened' || event.type === 'change-request.updated') &&
          event.headSha
        ) {
          schedules.push({
            kind: 'review_revision',
            tenantId: ctx.tenantId,
            repositoryId,
            changeRequestId,
            revisionId: revision.id,
            headSha: event.headSha,
            ...(event.type === 'change-request.updated' && event.previousHeadSha
              ? { previousHeadSha: event.previousHeadSha }
              : {}),
          });
        }
        // Ready for review: auto reviews were skipped while draft, so review the current head
        // (the handler skips it if already reviewed).
        if (event.type === 'change-request.ready' && changeLifecycleApplied) {
          const latest = await db
            .selectFrom('revisions')
            .select(['id', 'head_sha'])
            .where('change_request_id', '=', changeRequestId)
            .orderBy('created_at', 'desc')
            .executeTakeFirst();
          if (latest) {
            schedules.push({
              kind: 'review_revision',
              tenantId: ctx.tenantId,
              repositoryId,
              changeRequestId,
              revisionId: latest.id,
              headSha: latest.head_sha,
            });
          }
        }
      }
    }
  }

  // Push to an open CR's source branch triggers a review, for forges without synchronize (deduped by headSha on GitHub).
  // Only same-repo CRs match: a fork PR's same-named branch is a different branch.
  if (
    event.type === 'push.received' &&
    repositoryId &&
    event.ref.startsWith('refs/heads/') &&
    event.afterSha
  ) {
    const branch = event.ref.slice('refs/heads/'.length);
    const cr = await db
      .selectFrom('change_requests')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .where('source_branch', '=', branch)
      .where('state', '=', 'open')
      .where('source_is_fork', '=', false)
      .executeTakeFirst();
    if (cr) {
      // Approximation; the review handler recomputes merge-base.
      const lastRev = await db
        .selectFrom('revisions')
        .select(['base_sha', 'head_sha'])
        .where('change_request_id', '=', cr.id)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      // Push events are ordered by their before/after chain. If the current head is neither end of
      // this delivery, it is a delayed branch update and must not supersede a newer review.
      if (lastRev && lastRev.head_sha !== event.beforeSha && lastRev.head_sha !== event.afterSha) {
        changeRequestId = cr.id;
      } else {
        const baseSha = lastRev?.base_sha ?? event.beforeSha;
        const insertedRev = await db
          .insertInto('revisions')
          .values({
            id: uuidv7(now.getTime()),
            tenant_id: ctx.tenantId,
            change_request_id: cr.id,
            base_sha: baseSha,
            head_sha: event.afterSha,
            merge_base_sha: null,
            source_branch: branch,
            target_branch: null,
            created_at: now,
          })
          .onConflict((oc) => oc.columns(['change_request_id', 'head_sha']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (insertedRev) {
          changeRequestId = cr.id;
          schedules.push({
            kind: 'review_revision',
            tenantId: ctx.tenantId,
            repositoryId,
            changeRequestId: cr.id,
            revisionId: insertedRev.id,
            headSha: event.afterSha,
            ...(event.beforeSha ? { previousHeadSha: event.beforeSha } : {}),
          });
        }
      }
    }
  }

  // Uninstall: erase installation data asynchronously; audit rows are kept.
  if (
    event.type === 'installation.changed' &&
    event.action === 'deleted' &&
    ctx.tenantId &&
    ctx.installationId
  ) {
    schedules.push({
      kind: 'installation_erasure',
      tenantId: ctx.tenantId,
      installationId: ctx.installationId,
    });
  }

  if (event.type === 'installation.changed' && shouldSyncInstallation(event.action)) {
    schedules.push({
      kind: 'sync_installation',
      tenantId: ctx.tenantId,
      providerHostId: ctx.providerHostId,
      installationNativeId: event.installationNativeId,
      internalInstallationId: ctx.installationId,
    });
  }

  // Closed/merged: cancel all in-flight reviews of the CR.
  if (
    (event.type === 'change-request.closed' || event.type === 'change-request.merged') &&
    changeRequestId &&
    changeLifecycleApplied
  ) {
    await cancelReviewJobsForChangeRequest(db, ctx.tenantId, changeRequestId);
  }

  // The handler checks whether the merge targeted the default branch.
  if (
    event.type === 'change-request.merged' &&
    repositoryId &&
    changeRequestId &&
    changeLifecycleApplied
  ) {
    schedules.push({
      kind: 'post_merge_action',
      tenantId: ctx.tenantId,
      repositoryId,
      changeRequestId,
    });
  }

  // CI failure: look up the CR/revision by headSha (known CRs only).
  if (
    event.type === 'pipeline.completed' &&
    repositoryId &&
    CI_FAILURE_CONCLUSIONS.has(event.conclusion)
  ) {
    const revisions = await db
      .selectFrom('revisions as rev')
      .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
      .select(['rev.id as revisionId', 'cr.id as changeRequestId'])
      .where('cr.tenant_id', '=', ctx.tenantId)
      .where('cr.repository_id', '=', repositoryId)
      .where('cr.state', '=', 'open')
      .where('rev.head_sha', '=', event.headSha)
      .orderBy('rev.created_at', 'desc')
      .execute();
    if (revisions.length === 1) changeRequestId = revisions[0]!.changeRequestId;
    for (const revision of revisions) {
      schedules.push({
        kind: 'pipeline_analyze',
        tenantId: ctx.tenantId,
        repositoryId,
        changeRequestId: revision.changeRequestId,
        revisionId: revision.revisionId,
        headSha: event.headSha,
      });
    }
  }

  // Bot-opened issues (including our own) are not triaged: triage is for human reporters.
  if (event.type === 'issue.opened' && repositoryId && !isBotActor(event.actor)) {
    schedules.push({
      kind: 'issue_enrich',
      tenantId: ctx.tenantId,
      repositoryId,
      issueNativeId: event.nativeId,
      issueNumber: event.number,
      mode: 'enrich',
    });
  }

  // Comments with an @mention, and any reply in a review thread (no @ needed); the runner drops threads that
  // are not ours. Our own comments are skipped: they contain the `@winnowl fix` hint, which is a valid command,
  // and forges deliver an App's own comment events back.
  if (
    event.type === 'comment.created' &&
    (event.body.includes('@') ||
      (event.target.kind === 'change-request' && event.reviewThread?.threadNativeId !== undefined)) &&
    !isOwnBotLogin(event.actor.login)
  ) {
    // Inline thread comments target the thread but still carry repo/CR for intent routing.
    const reviewThread = event.target.kind === 'change-request' ? event.reviewThread : undefined;
    const target = reviewThread?.threadNativeId
      ? { kind: 'review-thread' as const, nativeId: reviewThread.threadNativeId }
      : event.target.kind === 'change-request'
        ? { kind: 'change-request' as const, nativeId: event.target.change.nativeId }
        : { kind: 'issue' as const, nativeId: event.target.nativeId };
    schedules.push({
      kind: 'conversation_turn',
      tenantId: ctx.tenantId,
      target,
      actorLogin: event.actor.login,
      // Must share the identity space of the confirm endpoint's auth.actorId.
      actorId: event.actor.providerUserId,
      // Third-party bots get read-only intents, so automation cannot make us open PRs via `@winnowl fix`.
      ...(isBotActor(event.actor) ? { actorIsBot: true } : {}),
      body: event.body,
      // Lets uninstall erasure find the Langfuse traces.
      ...(ctx.installationId ? { installationId: ctx.installationId } : {}),
      ...(repositoryId ? { repositoryId } : {}),
      ...(changeRequestId ? { changeRequestId } : {}),
      // Not registered yet (the opened event may come after the comment): the runner resolves it later.
      ...(repositoryId && !changeRequestId && event.target.kind === 'change-request'
        ? { pendingChange: { number: event.target.change.number, kind: event.target.change.kind } }
        : {}),
      ...(event.target.kind === 'issue' ? { issueNumber: event.target.number } : {}),
      ...(reviewThread?.path ? { anchorPath: reviewThread.path } : {}),
      commentNativeId: event.commentNativeId,
    });
  }

  /*
   * A ticked checkbox in our comment is a command (status comment -> `review`, review body -> `fix`; the runner checks permissions).
   * Requires: the comment is ours (GitLab gives no author; runner permission check covers it), the editor is not a bot,
   * and the checkbox actually changed to ticked.
   */
  const tickedKind =
    event.type === 'comment.edited'
      ? triggerTicked('review', event.previousBody, event.body)
        ? ('review-checkbox' as const)
        : triggerTicked('fix', event.previousBody, event.body)
          ? ('fix-checkbox' as const)
          : undefined
      : undefined;
  if (
    event.type === 'comment.edited' &&
    tickedKind &&
    repositoryId &&
    changeRequestId &&
    (event.author === undefined || isOwnBotLogin(event.author.login)) &&
    !isOwnBotLogin(event.actor.login) &&
    !isBotActor(event.actor)
  ) {
    schedules.push({
      kind: 'conversation_turn',
      tenantId: ctx.tenantId,
      target: { kind: 'change-request', nativeId: event.change.nativeId },
      actorLogin: event.actor.login,
      actorId: event.actor.providerUserId,
      body: '',
      command: { kind: tickedKind, commentNativeId: event.commentNativeId },
      ...(ctx.installationId ? { installationId: ctx.installationId } : {}),
      repositoryId,
      changeRequestId,
    });
  }

  const id = uuidv7(now.getTime());
  await db
    .insertInto('domain_events')
    .values({
      id,
      tenant_id: ctx.tenantId,
      provider_event_id: providerEventId,
      type: event.type,
      repository_id: repositoryId,
      change_request_id: changeRequestId,
      payload: event as unknown as Record<string, unknown>,
      status: 'pending',
      created_at: now,
    })
    .execute();
  return { domainEventId: id, schedules };
}
