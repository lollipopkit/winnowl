import type { Db } from '@reviewbot/db';
import {
  enqueueJob,
  REVIEW_JOB_MAX_ATTEMPTS,
  reviewDedupeKey,
  supersedeOlderReviewJobs,
} from '@reviewbot/queue';

export type ScheduleHint =
  | {
      kind: 'review_revision';
      tenantId: string;
      repositoryId: string;
      changeRequestId: string;
      revisionId: string;
      headSha: string;
      /** Provider-reported predecessor, used to reject out-of-order head transitions. */
      previousHeadSha?: string;
    }
  | {
      kind: 'sync_installation';
      tenantId: string;
      providerHostId: string;
      installationNativeId: string;
      internalInstallationId: string;
    }
  | {
      kind: 'installation_erasure';
      tenantId: string;
      installationId: string;
    }
  | {
      kind: 'conversation_turn';
      tenantId: string;
      target: { kind: 'change-request' | 'issue' | 'review-thread'; nativeId: string };
      actorLogin: string;
      /** Forge actor id; must match the confirm endpoint's auth.actorId for ActionPlan ownership. */
      actorId?: string;
      /** Author is a third-party bot: the runner allows read-only intents only. */
      actorIsBot?: boolean;
      body: string;
      /** Tagged on LLM spans so uninstall erasure can delete the Langfuse traces. */
      installationId?: string;
      repositoryId?: string;
      changeRequestId?: string;
      /**
       * A comment on a change request this platform has not registered yet (its opened event can
       * arrive after the comment): number and kind, for the runner to resolve it once it is there.
       */
      pendingChange?: { number: number; kind: string };
      issueNumber?: number;
      /** File of an inline review-thread comment, used by explain-finding to pick the finding. */
      anchorPath?: string;
      /** Part of the publish idempotency key: asking again gets a new answer, a job retry does not post twice. */
      commentNativeId?: string;
      /** Command from a ticked checkbox in our comment; `body` is empty. */
      command?: { kind: 'review-checkbox' | 'fix-checkbox'; commentNativeId: string };
    }
  | {
      kind: 'post_merge_action';
      tenantId: string;
      repositoryId: string;
      changeRequestId: string;
    }
  | {
      kind: 'pipeline_analyze';
      tenantId: string;
      repositoryId: string;
      changeRequestId: string;
      revisionId: string;
      headSha: string;
    }
  | {
      kind: 'issue_enrich';
      tenantId: string;
      repositoryId: string;
      issueNativeId: string;
      issueNumber: number;
      mode: 'enrich' | 'plan';
    };

/** Attempts of a comment whose change request is not registered yet (see `pendingChange`). */
const PENDING_CHANGE_MAX_ATTEMPTS = 6;

export async function scheduleFromHints(db: Db, hints: ScheduleHint[]): Promise<string[]> {
  const jobIds: string[] = [];
  for (const hint of hints) {
    if (hint.kind === 'review_revision') {
      // Ingestor wraps provider event, domain state, and every scheduled job in one transaction.
      // Lock the CR row here to serialize concurrent head transitions inside that transaction.
      const cr = await db
        .selectFrom('change_requests')
        .select('id')
        .where('id', '=', hint.changeRequestId)
        .where('tenant_id', '=', hint.tenantId)
        .where('repository_id', '=', hint.repositoryId)
        .forUpdate()
        .executeTakeFirst();
      if (!cr) continue;

      const successor = await db
        .selectFrom('domain_events')
        .select('id')
        .where('tenant_id', '=', hint.tenantId)
        .where('repository_id', '=', hint.repositoryId)
        .where('change_request_id', '=', hint.changeRequestId)
        .where('type', '=', 'change-request.updated')
        .where(
          'payload',
          '@>',
          JSON.stringify({ previousHeadSha: hint.headSha }) as unknown as Record<string, unknown>,
        )
        .executeTakeFirst();
      if (successor) continue;

      await supersedeOlderReviewJobs(db, {
        tenantId: hint.tenantId,
        changeRequestId: hint.changeRequestId,
        headSha: hint.headSha,
      });
      const jobId = (
        await enqueueJob(db, {
          tenantId: hint.tenantId,
          type: 'review_revision',
          payload: {
            tenantId: hint.tenantId,
            repositoryId: hint.repositoryId,
            changeRequestId: hint.changeRequestId,
            revisionId: hint.revisionId,
            headSha: hint.headSha,
            configDigest: '',
          },
          // configDigest is resolved by the review handler; dedupe relies on headSha.
          dedupeKey: reviewDedupeKey({
            repositoryId: hint.repositoryId,
            changeRequestId: hint.changeRequestId,
            headSha: hint.headSha,
            configDigest: '',
          }),
          maxAttempts: REVIEW_JOB_MAX_ATTEMPTS,
        })
      ).jobId;
      jobIds.push(jobId);
    } else if (hint.kind === 'installation_erasure') {
      const { jobId } = await enqueueJob(db, {
        tenantId: hint.tenantId,
        type: 'installation_erasure',
        payload: { tenantId: hint.tenantId, installationId: hint.installationId },
        dedupeKey: `erasure:${hint.installationId}`,
      });
      jobIds.push(jobId);
    } else if (hint.kind === 'sync_installation') {
      const { jobId } = await enqueueJob(db, {
        tenantId: hint.tenantId,
        type: 'sync_installation',
        payload: {
          tenantId: hint.tenantId,
          providerHostId: hint.providerHostId,
          installationNativeId: hint.installationNativeId,
          internalInstallationId: hint.internalInstallationId,
        },
        dedupeKey: `sync:${hint.providerHostId}:${hint.installationNativeId}`,
      });
      jobIds.push(jobId);
    } else if (hint.kind === 'conversation_turn') {
      // One job per comment, no dedupe.
      const { jobId } = await enqueueJob(db, {
        tenantId: hint.tenantId,
        type: 'conversation_turn',
        // Waiting for a change request to be registered: retries back off 10 s → 2 min, ~4.5 min in all.
        ...(hint.pendingChange ? { maxAttempts: PENDING_CHANGE_MAX_ATTEMPTS } : {}),
        payload: {
          tenantId: hint.tenantId,
          target: hint.target,
          actorLogin: hint.actorLogin,
          ...(hint.actorId ? { actorId: hint.actorId } : {}),
          ...(hint.actorIsBot ? { actorIsBot: true } : {}),
          body: hint.body,
          ...(hint.installationId ? { installationId: hint.installationId } : {}),
          ...(hint.repositoryId ? { repositoryId: hint.repositoryId } : {}),
          ...(hint.changeRequestId ? { changeRequestId: hint.changeRequestId } : {}),
          ...(hint.pendingChange ? { pendingChange: hint.pendingChange } : {}),
          ...(hint.issueNumber !== undefined ? { issueNumber: hint.issueNumber } : {}),
          ...(hint.anchorPath ? { anchorPath: hint.anchorPath } : {}),
          ...(hint.commentNativeId ? { commentNativeId: hint.commentNativeId } : {}),
          ...(hint.command ? { command: hint.command } : {}),
        },
      });
      jobIds.push(jobId);
    } else if (hint.kind === 'issue_enrich') {
      const { jobId } = await enqueueJob(db, {
        tenantId: hint.tenantId,
        type: 'issue_enrich',
        payload: {
          tenantId: hint.tenantId,
          repositoryId: hint.repositoryId,
          issueNativeId: hint.issueNativeId,
          issueNumber: hint.issueNumber,
          mode: hint.mode,
        },
        dedupeKey: `issue-${hint.mode}:${hint.repositoryId}:${hint.issueNumber}`,
      });
      jobIds.push(jobId);
    } else if (hint.kind === 'post_merge_action') {
      const { jobId } = await enqueueJob(db, {
        tenantId: hint.tenantId,
        type: 'post_merge_action',
        payload: {
          tenantId: hint.tenantId,
          repositoryId: hint.repositoryId,
          changeRequestId: hint.changeRequestId,
        },
        dedupeKey: `post-merge:${hint.changeRequestId}`,
      });
      jobIds.push(jobId);
    } else if (hint.kind === 'pipeline_analyze') {
      const { jobId } = await enqueueJob(db, {
        tenantId: hint.tenantId,
        type: 'pipeline_analyze',
        payload: {
          tenantId: hint.tenantId,
          repositoryId: hint.repositoryId,
          changeRequestId: hint.changeRequestId,
          revisionId: hint.revisionId,
          headSha: hint.headSha,
        },
        dedupeKey: `pipeline:${hint.changeRequestId}:${hint.headSha}`,
      });
      jobIds.push(jobId);
    } else {
      // Exhaustiveness guard.
      throw new Error(`unknown schedule hint kind: ${(hint as { kind: string }).kind}`);
    }
  }
  return jobIds;
}
