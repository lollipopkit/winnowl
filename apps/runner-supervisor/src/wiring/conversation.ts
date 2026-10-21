import { botName, changeRequestHeadRef, isProviderKind } from '@reviewbot/domain';
import { enqueueJob } from '@reviewbot/queue';
import { CodePlaneReader } from '@reviewbot/review-runtime';
import { botMessages } from '../locale.js';
import type { Db } from '@reviewbot/db';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { createActionExecutor } from '../action-executor.js';
import { validateActionPlanExecution } from '../action-validation.js';
import { createActionExecuteHandler } from '../action-execute.js';
import { createChangeRequestRegistrar } from '../change-request-registry.js';
import { createConversationAgentHandler, type ConversationAgentPayload } from '../conversation-agent.js';
import { createConversationMemoryProposer } from '../conversation-memory.js';
import { createRunCommandHandler } from '../run-command.js';
import { createConversationTurnHandler } from '../conversation-turn.js';
import { createConversationRoute } from '../conversation-route.js';
import { recomputeGateForChangeRequest } from '../review-checks.js';
import { createConversationAcknowledger } from '../review-ack.js';
import { createStackedFixDeliverer } from '../stacked-fix.js';
import { createIssueCrDeliverer } from '../create-issue-cr.js';
import type { JobHandler } from '../supervisor.js';
import type { RunnerRuntime } from './runtime.js';

/** Comment commands (conversation_turn) and the approved actions they lead to (action_execute). */
export function conversationHandlers(rt: RunnerRuntime): Record<string, JobHandler> {
  const {
    db,
    logger,
    sandbox,
    platformModels,
    validationSandboxEnv,
    credKek,
    artifactStore,
    buildProviderForRepository,
    resolveActorPermissionForRepository,
    resolveChangeRequestAuthorFromProvider,
    openCodePlane,
    openDefaultBranch,
    repositoryReadToken,
    statusComment,
    conversationReply,
  } = rt;

  const route = createConversationRoute({
    reply: conversationReply,
    // `ignore` of a blocking finding flips the gate immediately (same path as reverify).
    recomputeGate: (input) => recomputeGateForChangeRequest({ db, buildProvider: buildProviderForRepository }, input),
    // `ignore`/`pause` are allowed for the CR author and anyone with write access or above.
    resolveActorPermission: resolveActorPermissionForRepository,
    // Old CRs have no stored author; fetch it so fork contributors are not locked out of their own PR.
    resolveChangeRequestAuthor: resolveChangeRequestAuthorFromProvider,
    statusComment,
  });

  return {
    action_execute: createActionExecuteHandler({
      validatePlan: (plan, ctx) =>
        validateActionPlanExecution(ctx.db as Db, ctx.tenantId, plan, {
          resolveActorPermission: resolveActorPermissionForRepository,
        }),
      // merge is not supported and fails explicitly.
      executeAction: createActionExecutor({
        buildProvider: buildProviderForRepository,
        deliverStackedFix: createStackedFixDeliverer({
          db,
          buildProvider: buildProviderForRepository,
          // The approved head as a tree workspace; the commit is made here through the provider API.
          openRepository: async (repo, at) =>
            openCodePlane({
              cloneUrl: repo.cloneUrl,
              token: await repositoryReadToken(repo.installationId, repo.nativeId),
              headSha: at.headSha,
              ...(at.headRef ? { headRef: at.headRef } : {}),
            }),
          modelSource: () => platformModels.source(),
          ...(artifactStore ? { artifactStore } : {}),
          ...(credKek ? { kek: credKek } : {}),
          // With a validation image configured, the patched tree is validated in a sandbox before delivery.
          ...(validationSandboxEnv ? { validationSandbox: { backend: sandbox, ...validationSandboxEnv } } : {}),
        }),
        deliverIssueCr: createIssueCrDeliverer({
          db,
          buildProvider: buildProviderForRepository,
          openRepository: openDefaultBranch,
          modelSource: () => platformModels.source(),
        }),
      }),
      // Tell the PR when an approved plan fails for good; otherwise an approval silently leads to nothing.
      onTerminalFailure: async ({ tenantId, plan, db: jobDb }, error) => {
        const conversation = await jobDb
          .selectFrom('conversations')
          .select(['repository_id', 'change_request_id'])
          .where('tenant_id', '=', tenantId)
          .where('id', '=', plan.conversationId)
          .executeTakeFirst();
        if (!conversation?.repository_id || !conversation.change_request_id) return;
        const cr = await jobDb
          .selectFrom('change_requests')
          .select('native_id')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', conversation.change_request_id)
          .executeTakeFirst();
        if (!cr) return;
        const language = (
          await loadEffectiveConfig(jobDb as Db, tenantId, conversation.repository_id)
        ).language;
        await conversationReply(
          {
            tenantId,
            target: { kind: 'change-request', nativeId: cr.native_id },
            actorLogin: botName(),
            body: '',
            repositoryId: conversation.repository_id,
            changeRequestId: conversation.change_request_id,
          },
          botMessages(language).conversation.actionFailed({
            planId: plan.id,
            reason: (error as Error)?.message ?? String(error),
          }),
        );
      },
    }),
    conversation_turn: createConversationTurnHandler({
      botName: botName(),
      reply: conversationReply,
      route,
      // Comments that are not commands go to the conversation agent.
      startAgent: async ({ db: jobDb, payload, conversation, findingClaim }) => {
        const agentPayload: ConversationAgentPayload = {
          turn: payload,
          conversationId: conversation.id,
          ...(findingClaim ? { findingClaim } : {}),
        };
        await enqueueJob(jobDb, {
          tenantId: payload.tenantId,
          type: 'conversation_agent',
          payload: { ...agentPayload },
          // One answer per comment; a retried model failure must not post twice.
          maxAttempts: 1,
          dedupeKey: `conversation-agent:${payload.commentNativeId ?? payload.turnId ?? conversation.id}`,
        });
      },
      // React with eyes before answering an @mention, without waiting for the LLM or the action.
      acknowledge: createConversationAcknowledger({ db, buildProvider: buildProviderForRepository }),
      // Comments on a pull request opened before installation (no opened event ever came) register it from the forge.
      registerChangeRequest: createChangeRequestRegistrar({
        db,
        buildProvider: buildProviderForRepository,
        log: (msg, data) => logger.info(data ?? {}, msg),
      }),
      // Comments addressed to the bot can become repository memory; outside commenters' need an admin.
      afterAddressedTurn: createConversationMemoryProposer({
        botName: botName(),
        resolveActorPermission: resolveActorPermissionForRepository,
      }),
    }),
    conversation_agent: createConversationAgentHandler({
      botName: botName(),
      route,
      reply: conversationReply,
      resolveModel: (tier) => platformModels.source(tier),
      openSource: async ({ tenantId, repositoryId, changeRequestId }) => {
        const repo = await db
          .selectFrom('repositories')
          .select(['installation_id', 'native_id', 'clone_url'])
          .where('tenant_id', '=', tenantId)
          .where('id', '=', repositoryId)
          .executeTakeFirstOrThrow();
        const ref = { installationId: repo.installation_id, nativeId: repo.native_id, cloneUrl: repo.clone_url };
        if (!changeRequestId) {
          const plane = await openCodePlane({ cloneUrl: ref.cloneUrl, token: await repositoryReadToken(ref.installationId, ref.nativeId) });
          return { source: new CodePlaneReader(plane, []).source, dispose: () => plane.dispose() };
        }
        const cr = await db
          .selectFrom('change_requests')
          .select(['id', 'native_id', 'number', 'kind'])
          .where('id', '=', changeRequestId)
          .executeTakeFirstOrThrow();
        const head = await db
          .selectFrom('revisions')
          .select('head_sha')
          .where('change_request_id', '=', changeRequestId)
          .orderBy('created_at', 'desc')
          .executeTakeFirstOrThrow();
        const provider = await buildProviderForRepository(repositoryId);
        const headRef = isProviderKind(provider.kind) ? changeRequestHeadRef(provider.kind, cr.number) : undefined;
        const plane = await openCodePlane({
          cloneUrl: repo.clone_url,
          token: await repositoryReadToken(repo.installation_id, repo.native_id),
          headSha: head.head_sha,
          ...(headRef ? { headRef } : {}),
        });
        const changed = await provider.changes.listChangedFiles({
          id: cr.id,
          repositoryId,
          nativeId: cr.native_id,
          number: cr.number,
          kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
        });
        const entries = changed.map((f) => ({ path: f.newPath ?? f.oldPath ?? '', status: 'modified' as const })).filter((f) => f.path);
        return { source: new CodePlaneReader(plane, entries).source, dispose: () => plane.dispose() };
      },
    }),
    run_command: createRunCommandHandler({
      db,
      buildProvider: buildProviderForRepository,
      openRepository: async (repo, at) =>
        openCodePlane({
          cloneUrl: repo.cloneUrl,
          token: await repositoryReadToken(repo.installationId, repo.nativeId),
          headSha: at.headSha,
          ...(at.headRef ? { headRef: at.headRef } : {}),
        }),
      ...(validationSandboxEnv ? { validationSandbox: { backend: sandbox, ...validationSandboxEnv } } : {}),
      modelSource: () => platformModels.source(),
      reply: conversationReply,
    }),
    // A finding dismissed or restored in the console; the merge check follows like after `@bot ignore`.
    recompute_gate: async ({ job, db: jobDb }) => {
      const p = job.payload as { tenantId: string; repositoryId: string; changeRequestId: string };
      await recomputeGateForChangeRequest({ db: jobDb as typeof db, buildProvider: buildProviderForRepository }, p);
    },
  };
}
