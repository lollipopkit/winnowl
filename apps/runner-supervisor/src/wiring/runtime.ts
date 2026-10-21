import { resolvePublicRepoBilling, type PublicRepoBilling } from '@reviewbot/entitlement';
import type { createPlatformModels } from '../platform-models.js';
import type { RepositoryRef } from '@reviewbot/domain';
import type { Db } from '@reviewbot/db';
import { langfuseAdminFromEnv } from '@reviewbot/telemetry';
import {
  createEnvCredentialStore,
  createFallbackCredentialStore,
  createKmsCredentialStore,
  createSourceProviderForInstallation,
  getInstallationToken,
} from '@reviewbot/provider-factory';
import { masterKeyFromEnv } from '@reviewbot/kms';
import type { RepositoryPermission } from '@reviewbot/provider-contracts';
import { artifactStoreFromEnv } from '@reviewbot/artifacts';
import type { CodePlane } from '@reviewbot/review-runtime';
import { createReviewAcknowledger } from '../review-ack.js';
import { createStatusComment } from '../status-comment.js';
import { reviewSandboxResources, type createSandboxBackend } from '../sandbox-backend.js';
import { llmRelayFromEnv } from '../llm-relay.js';
import type { WorkspaceScanDeps } from '../workspace-scan.js';
import { createCodePlaneOpener } from '../code-plane.js';
import { createConversationReply } from '../reply.js';
import { mailerFromEnv } from '@reviewbot/notifications';
import { repositoryRefFromRow } from '../repository-ref.js';
import type { Logger } from 'pino';

/*
 * Shared dependencies of the job handlers: credentials, provider construction, workspaces, the
 * model relay and the PR feedback helpers. Built once at startup (index.ts); each wiring module
 * picks what its handlers need.
 */

/** Every gate call needs the billing basis; missing it on one path discounts some paths and not others. */
export async function gateOptions(db: Db): Promise<{
  envDailyCapUsd: number;
  envReviewCapUsd: number;
  publicRepoBilling: PublicRepoBilling;
}> {
  return {
    envDailyCapUsd: Number(process.env.DAILY_COST_CAP_USD) || 0,
    envReviewCapUsd: Number(process.env.REVIEW_COST_CAP_USD) || 0,
    publicRepoBilling: await resolvePublicRepoBilling(db),
  };
}

export function notWired(what: string): never {
  throw new Error(`${what} 尚未接线:需 provider API key`);
}

export interface RunnerRuntimeBase {
  db: Db;
  logger: Logger;
  sandbox: ReturnType<typeof createSandboxBackend>['sandbox'];
  platformModels: ReturnType<typeof createPlatformModels>;
}

export function createRunnerRuntime({ db, logger, sandbox, platformModels }: RunnerRuntimeBase) {
  /*
   * Validation sandbox: the image plus the registry proxy its package managers go through. Without the
   * proxy every install fails, so an image without it is a configuration error.
   */
  const validationSandboxEnv = process.env.VALIDATION_SANDBOX_IMAGE
    ? {
        image: process.env.VALIDATION_SANDBOX_IMAGE,
        registryProxyUrl:
          process.env.SANDBOX_REGISTRY_PROXY ||
          (() => {
            throw new Error('VALIDATION_SANDBOX_IMAGE requires SANDBOX_REGISTRY_PROXY');
          })(),
      }
    : undefined;

  // With a KEK, credentials come from KMS (DB envelope decryption), falling back to env on a miss or Vault
  // failure so reviews survive a Vault outage. Without a KEK: env only.
  const envCredentialStore = createEnvCredentialStore();
  const credKek = masterKeyFromEnv();
  const credentialStore = credKek
    ? createFallbackCredentialStore(
        createKmsCredentialStore(db, credKek),
        envCredentialStore,
        (kind, hostId, err) =>
          logger.warn({ kind, hostId, err: (err as Error)?.message }, 'KMS 凭据读取失败,回退 env'),
      )
    : envCredentialStore;
  const factoryDeps = { db, store: credentialStore };
  /** App-level credentials (webhook config checks, redelivery). One GitHub App per deployment: the first github host. */
  const githubAppCredentials = async () => {
    const host = await db.selectFrom('provider_hosts').select('id').where('provider', '=', 'github').executeTakeFirst();
    return host ? credentialStore.githubAppCredentials(host.id) : null;
  };

  // Undefined without ARTIFACT_S3_*; delivery then keeps patches inline.
  const artifactStore = artifactStoreFromEnv() ?? undefined;

  // Undefined without Langfuse (no traces to erase).
  const langfuseAdmin = langfuseAdminFromEnv();

  async function buildProviderForRepository(
    repositoryId: string,
  ): Promise<Awaited<ReturnType<typeof createSourceProviderForInstallation>>> {
    const repo = await db
      .selectFrom('repositories')
      .select(['installation_id'])
      .where('id', '=', repositoryId)
      .executeTakeFirstOrThrow();
    return createSourceProviderForInstallation(factoryDeps, repo.installation_id);
  }

  /**
   * The commenter's permission on a repository (`ignore`/`pause` authorization). An unsupported endpoint
   * or failed lookup logs a warning and counts as `none`: strict, but distinguishable from a real `none`.
   * On GitHub this endpoint needs only the default Metadata: Read permission.
   */
  async function resolveActorPermissionForRepository(
    repositoryId: string,
    actor: { login: string; providerUserId?: string },
  ): Promise<RepositoryPermission> {
    const repo = await db
      .selectFrom('repositories')
      .select([
        'id',
        'provider_host_id',
        'installation_id',
        'native_id',
        'namespace',
        'name',
        'clone_url',
        'default_branch',
      ])
      .where('id', '=', repositoryId)
      .executeTakeFirst();
    if (!repo) return 'none';
    try {
      const provider = await buildProviderForRepository(repositoryId);
      if (!provider.repositories.getActorPermission) return 'none';
      return await provider.repositories.getActorPermission(
        repositoryRefFromRow(repo),
        actor,
      );
    } catch (err) {
      logger.warn(
        { repositoryId, actor: actor.login, err: (err as Error)?.message },
        '仓库权限查询失败,按无权限处理(退化成仅 CR 作者可用)',
      );
      return 'none';
    }
  }

  /**
   * A CR's author from the provider, backfilling rows whose `author` is empty. null when unavailable;
   * authorization then falls back to the permission check.
   */
  async function resolveChangeRequestAuthorFromProvider(
    repositoryId: string,
    changeRequestId: string,
  ): Promise<{ login: string; providerUserId?: string } | null> {
    const cr = await db
      .selectFrom('change_requests')
      .select(['id', 'repository_id', 'native_id', 'number', 'kind'])
      .where('id', '=', changeRequestId)
      .executeTakeFirst();
    if (!cr) return null;
    try {
      const provider = await buildProviderForRepository(repositoryId);
      const detail = await provider.changes.get({
        id: cr.id,
        repositoryId: cr.repository_id,
        nativeId: cr.native_id,
        number: cr.number,
        kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
      });
      if (!detail.author?.login) return null;
      return {
        login: detail.author.login,
        ...(detail.author.providerUserId ? { providerUserId: detail.author.providerUserId } : {}),
      };
    } catch (err) {
      logger.warn(
        { repositoryId, changeRequestId, err: (err as Error)?.message },
        'CR 作者回填失败,授权退到权限判据',
      );
      return null;
    }
  }

  /** A revision's installation and clone URL, plus what a fork PR head needs (provider, CR number, head sha). */
  async function repoContextForRevision(
    database: Db,
    revisionId: string,
  ): Promise<{
    installationId: string;
    repositoryId: string;
    repositoryNativeId: string;
    cloneUrl: string;
    provider: string;
    changeRequestNumber: number;
    headSha: string;
  }> {
    const row = await database
      .selectFrom('revisions as rev')
      .innerJoin('change_requests as cr', 'cr.id', 'rev.change_request_id')
      .innerJoin('repositories as repo', 'repo.id', 'cr.repository_id')
      .innerJoin('provider_hosts as host', 'host.id', 'repo.provider_host_id')
      .select([
        'repo.installation_id as installationId',
        'repo.id as repositoryId',
        'repo.native_id as repositoryNativeId',
        'repo.clone_url as cloneUrl',
        'host.provider as provider',
        'cr.number as changeRequestNumber',
        'rev.head_sha as headSha',
      ])
      .where('rev.id', '=', revisionId)
      .executeTakeFirstOrThrow();
    return {
      installationId: row.installationId,
      repositoryId: row.repositoryId,
      repositoryNativeId: row.repositoryNativeId,
      cloneUrl: row.cloneUrl,
      provider: row.provider,
      changeRequestNumber: row.changeRequestNumber,
      headSha: row.headSha,
    };
  }

  /**
   * Workspaces: on a sandbox host with the agent pool, in this process
   * otherwise. Every clone token is scoped to one repository, read-only.
   */
  const openCodePlane = createCodePlaneOpener({
    sandbox,
    // The review / validation then lacks those files; visible here rather than as a puzzling result.
    onSkippedSubmodules: (target, skipped) =>
      logger.info({ repository: target.cloneUrl, headSha: target.headSha, skipped }, 'workspace: submodules skipped'),
  });
  /** Model relay (apps/llm-relay): sandboxed reviews call models and keyed plugins through it. */
  const llmRelay = llmRelayFromEnv(process.env, (msg, data) => logger.warn(data ?? {}, msg));
  /** Scanners run next to the workspace: a sandbox on its sandbox host, or local processes. */
  const workspaceScanDeps: WorkspaceScanDeps = {
    sandbox,
    image: process.env.REVIEW_SANDBOX_IMAGE ?? 'winnowl:latest',
    resources: reviewSandboxResources(),
    ...(process.env.SANDBOX_EGRESS_PROXY ? { egressProxyUrl: process.env.SANDBOX_EGRESS_PROXY } : {}),
  };
  /** A tree workspace of a repository's default branch head (issue→CR, post-merge follow-ups). */
  async function openDefaultBranch(repo: RepositoryRef): Promise<CodePlane> {
    return openCodePlane({ cloneUrl: repo.cloneUrl, token: await repositoryReadToken(repo.installationId, repo.nativeId) });
  }
  /** Read-only clone token for one repository: what a workspace (possibly on a sandbox host) gets. */
  function repositoryReadToken(installationId: string, repositoryNativeId: string): Promise<string> {
    return getInstallationToken(factoryDeps, installationId, {
      repositoryNativeIds: [repositoryNativeId],
      permissions: { contents: 'read' },
    });
  }

  // On picking up a review: check run in_progress plus eyes reaction; failure or timeout ends neutral.
  const reviewAck = createReviewAcknowledger({ db, buildProvider: buildProviderForRepository });
  const statusComment = createStatusComment({ db, buildProvider: buildProviderForRepository });
  const notificationMailer = mailerFromEnv();

  // Replies on the PR / issue a comment came from (conversation_turn, its routing).
  const conversationReply = createConversationReply({ db, buildProvider: buildProviderForRepository });

  return {
    db,
    logger,
    sandbox,
    platformModels,
    validationSandboxEnv,
    credentialStore,
    credKek,
    factoryDeps,
    githubAppCredentials,
    artifactStore,
    langfuseAdmin,
    buildProviderForRepository,
    resolveActorPermissionForRepository,
    resolveChangeRequestAuthorFromProvider,
    repoContextForRevision,
    openCodePlane,
    llmRelay,
    workspaceScanDeps,
    openDefaultBranch,
    repositoryReadToken,
    reviewAck,
    statusComment,
    notificationMailer,
    conversationReply,
  };
}

export type RunnerRuntime = ReturnType<typeof createRunnerRuntime>;
