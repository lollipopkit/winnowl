import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveModelSourceFromEnv } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import type { ChangeRequestRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import { loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import { GithubProvider } from '@reviewbot/provider-github';
import { RestClient } from '@reviewbot/provider-http';
import { runReviewAndPublish } from '@reviewbot/review-orchestrator';
import {
  authedCloneUrl,
  cloneRepository,
  createReviewBuildEnv,
  openLocalCodePlane,
  type CreateBuildEnvDeps,
} from '@reviewbot/review-runtime';

/** The repository under test, cloned into a fresh workspace per review by the production executor. */
function openTestWorkspace(repo: string, root: string, onDispose?: () => void): CreateBuildEnvDeps['openWorkspace'] {
  return async (_ctx, rev) => {
    const plane = await openLocalCodePlane(
      {
        cloneUrl: repo,
        baseSha: rev.baseSha,
        headSha: rev.headSha,
        ...(rev.stackRootBranch !== undefined ? { stackRootBranch: rev.stackRootBranch } : {}),
      },
      root,
    );
    return {
      ...plane,
      dispose: async () => {
        await plane.dispose();
        onDispose?.();
      },
    };
  };
}

import { startMigratedPostgres } from '@reviewbot/testkit';

/**
 * Review pipeline live end to end (skipped by default). Needs real GitHub and a real LLM:
 *   LLM_LIVE=1 + LLM_* in .env (agent endpoint)
 *   REVIEWBOT_LIVE_GITHUB_TOKEN / REVIEWBOT_LIVE_GITHUB_REPO (owner/name) / REVIEWBOT_LIVE_GITHUB_PR
 * Clones, reviews and posts inline comments on a real PR (use a throwaway test repo).
 */
const token = process.env.REVIEWBOT_LIVE_GITHUB_TOKEN;
const repoSlug = process.env.REVIEWBOT_LIVE_GITHUB_REPO;
const prNumber = process.env.REVIEWBOT_LIVE_GITHUB_PR;
const enabled = Boolean(
  process.env.LLM_LIVE && token && repoSlug && prNumber && process.env.LLM_MODEL,
);

const [owner, name] = (repoSlug ?? '/').split('/');
const baseUrl = process.env.REVIEWBOT_LIVE_GITHUB_API ?? 'https://api.github.com';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR_ID = uuidv7();
const REV = uuidv7();

describe.skipIf(!enabled)('Review 全链路 live(真实 GitHub + 真实 LLM)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let gitDir: string;
  let workRoot: string;
  let headSha: string;
  let provider: GithubProvider;
  let bundles: {
    mapper: PromptBundle;
    reviewer: PromptBundle;
    synthesizer: PromptBundle;
    verifier: PromptBundle;
    refuter: PromptBundle;
  };

  beforeAll(async () => {
    provider = new GithubProvider({
      client: new RestClient({ baseUrl, authorization: () => `token ${token}` }),
      host: { id: 'live', provider: 'github', baseUrl, apiUrl: baseUrl, isSaas: true },
      resolveRepo: () => ({ owner: owner ?? '', repo: name ?? '' }),
    });
    const crRef: ChangeRequestRef = {
      id: CR_ID,
      repositoryId: REPO,
      nativeId: 'live',
      number: Number(prNumber),
      kind: 'pull-request',
    };
    const revision = await provider.changes.getRevision(crRef);
    headSha = revision.headSha;

    // Real token-authenticated clone; a default clone has all branches, so base and head are reachable.
    const cloneRoot = await mkdtemp(join(tmpdir(), 'live-clone-'));
    gitDir = await cloneRepository(
      authedCloneUrl(`https://github.com/${repoSlug}.git`, token as string),
      join(cloneRoot, 'repo'),
    );
    workRoot = await mkdtemp(join(tmpdir(), 'live-work-'));

    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    await db
      .insertInto('provider_hosts')
      .values({
        id: HOST,
        tenant_id: TENANT,
        provider: 'github',
        base_url: 'https://github.com',
        api_url: baseUrl,
        is_saas: true,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('installations')
      .values({
        id: INSTALL,
        tenant_id: TENANT,
        provider_host_id: HOST,
        native_id: '1',
        account_login: owner ?? 'x',
        status: 'active',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('repositories')
      .values({
        id: REPO,
        tenant_id: TENANT,
        provider_host_id: HOST,
        installation_id: INSTALL,
        native_id: 'live',
        namespace: owner ?? '',
        name: name ?? '',
        clone_url: `https://github.com/${repoSlug}.git`,
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('change_requests')
      .values({
        id: CR_ID,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: 'live',
        number: Number(prNumber),
        kind: 'pull-request',
        source_branch: null,
        target_branch: 'main',
        state: 'open',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto('revisions')
      .values({
        id: REV,
        tenant_id: TENANT,
        change_request_id: CR_ID,
        base_sha: revision.baseSha,
        head_sha: headSha,
        merge_base_sha: revision.mergeBaseSha ?? null,
        source_branch: null,
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();

    const l = await loadPromptBundles(['mapper', 'reviewer', 'synthesizer', 'verifier', 'refuter']);
    bundles = {
      mapper: l.mapper as PromptBundle,
      reviewer: l.reviewer as PromptBundle,
      synthesizer: l.synthesizer as PromptBundle,
      verifier: l.verifier as PromptBundle,
      refuter: l.refuter as PromptBundle,
    };
  }, 120_000);

  afterAll(async () => {
    await stop?.();
    if (gitDir)
      await rm(join(gitDir, '..'), { recursive: true, force: true }).catch(() => undefined);
    if (workRoot) await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('webhook→clone→diff→真实 agent→发布 inline + publication_record', async () => {
    const buildEnv = createReviewBuildEnv({
      bundles,
      openWorkspace: openTestWorkspace(gitDir, workRoot),
      buildDiscussions: () => provider.discussions,
      modelSource: () => {
        const s = resolveModelSourceFromEnv();
        if (!s) throw new Error('no model source');
        return s;
      },
    });

    const env = await buildEnv({
      payload: { revisionId: REV, tenantId: TENANT, repositoryId: REPO },
      db,
    });
    const changeRequest: ChangeRequestRef = {
      id: CR_ID,
      repositoryId: REPO,
      nativeId: 'live',
      number: Number(prNumber),
      kind: 'pull-request',
    };
    const outcome = await runReviewAndPublish({
      ...env,
      newId: () => uuidv7(),
      publishTarget: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequest,
        changeRequestId: CR_ID,
        revisionId: REV,
        revisionSha: headSha,
        providerHostId: HOST,
        expectedHeadSha: headSha,
      },
    });

    console.log(
      '[live-review] outcome:',
      JSON.stringify(
        {
          candidateCount: outcome.candidateCount,
          publishedInline: outcome.publishedInline,
          coverage: outcome.coverage,
          findings: outcome.findings.map((f) => ({
            claim: f.claim,
            location: f.location,
            severity: f.verdict.severity,
            confirmation: f.verdict.confirmation,
          })),
        },
        null,
        2,
      ),
    );

    // This fixture has publishable issues; zero output means the model or publish path broke.
    expect(outcome.coverage.scopesTotal).toBeGreaterThanOrEqual(1);
    expect(outcome.candidateCount).toBeGreaterThan(0);
    expect(outcome.publishedInline).toBeGreaterThan(0);
    const rec = await db
      .selectFrom('publication_records')
      .selectAll()
      .where('change_request_id', '=', CR_ID)
      .where('state', '=', 'published')
      .executeTakeFirst();
    expect(rec).toBeTruthy();
    expect(rec?.provider_native_id).toBeTruthy();
  }, 300_000);
});
