import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { ReviewOutcome } from '@reviewbot/review-orchestrator';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createAutoIssueProposer } from '../src/auto-issue.js';
import type { ReviewRevisionContext } from '../src/review-revision.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();

function finding(over: Record<string, unknown> = {}): unknown {
  return {
    candidateId: uuidv7(),
    claim: 'preexisting null-deref in legacy parser',
    category: 'correctness',
    primaryAnchorText: 'p.value',
    location: 'summary',
    fingerprint: `fp-${uuidv7()}`,
    incremental: 'new',
    decision: { blocking: false, publish: false, location: 'summary' },
    verdict: {
      severity: 'high',
      confirmation: 'independently-verified',
      changeRelation: 'preexisting-unrelated',
      decision: 'accept',
      actionable: true,
    },
    ...over,
  };
}

function ctx(db: Db): ReviewRevisionContext {
  return {
    payload: {
      tenantId: TENANT,
      repositoryId: REPO,
      changeRequestId: CR,
      revisionId: REV,
      headSha: 'h',
      configDigest: '',
    },
    changeRequest: { id: CR, repositoryId: REPO, nativeId: '42', number: 42, kind: 'pull-request' },
    providerHostId: HOST,
    db,
  } as unknown as ReviewRevisionContext;
}

async function setAutoIssue(db: Db, enabled: boolean): Promise<void> {
  const settings = { reviews: { scope: { auto_issue_preexisting: enabled } } } as unknown as Record<
    string,
    unknown
  >;
  await db
    .insertInto('repository_settings')
    .values({
      repository_id: REPO,
      tenant_id: TENANT,
      settings,
      config_digest: 'c',
      updated_at: new Date(),
    })
    .onConflict((oc) => oc.column('repository_id').doUpdateSet({ settings }))
    .execute();
}

describe('auto-issue 提议(§30.4)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
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
        base_url: 'x',
        api_url: 'x',
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
        account_login: 'acme',
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
        native_id: '900',
        namespace: 'acme',
        name: 'app',
        clone_url: 'x',
        default_branch: 'main',
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto('change_requests')
      .values({
        id: CR,
        tenant_id: TENANT,
        repository_id: REPO,
        native_id: '42',
        number: 42,
        kind: 'pull-request',
        source_branch: 'feat',
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
        change_request_id: CR,
        base_sha: 'b',
        head_sha: 'h',
        merge_base_sha: null,
        source_branch: 'feat',
        target_branch: 'main',
        created_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('配置关闭 → 不提议', async () => {
    await setAutoIssue(db, false);
    const outcome = {
      candidateCount: 1,
      coverage: { scopesTotal: 1, scopesComplete: 1 },
      publishedInline: 0,
      findings: [finding()],
    } as unknown as ReviewOutcome;
    await createAutoIssueProposer()(outcome, ctx(db));
    const plans = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('tenant_id', '=', TENANT)
      .execute();
    expect(plans).toHaveLength(0);
  });

  it('开启 + preexisting-unrelated new finding → 提议 create-issue ActionPlan + 建 CR 会话', async () => {
    await setAutoIssue(db, true);
    const outcome = {
      candidateCount: 3,
      coverage: { scopesTotal: 1, scopesComplete: 1 },
      publishedInline: 0,
      findings: [
        finding(),
        finding({ incremental: 'persisted' }), // incremental duplicate: not proposed
        finding({
          verdict: {
            severity: 'high',
            confirmation: 'independently-verified',
            changeRelation: 'introduced',
            decision: 'accept',
            actionable: true,
          },
        }), // introduced here: not proposed
      ],
    } as unknown as ReviewOutcome;
    await createAutoIssueProposer()(outcome, ctx(db));

    const plans = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('tenant_id', '=', TENANT)
      .where('status', '=', 'proposed')
      .execute();
    expect(plans).toHaveLength(1);
    const actions = plans[0]!.actions as unknown as { type: string; description: string }[];
    expect(actions[0]!.type).toBe('create-issue');
    expect(actions[0]!.description).toContain('null-deref');
    const conv = await db
      .selectFrom('conversations')
      .selectAll()
      .where('change_request_id', '=', CR)
      .executeTakeFirst();
    expect(conv).toBeTruthy();
  });

  it('does not stack duplicate proposed plans for the same finding', async () => {
    await setAutoIssue(db, true);
    const repeated = finding({ fingerprint: 'stable-auto-issue-fingerprint' });
    const outcome = {
      candidateCount: 1,
      coverage: { scopesTotal: 1, scopesComplete: 1 },
      publishedInline: 0,
      findings: [repeated],
    } as unknown as ReviewOutcome;
    await createAutoIssueProposer()(outcome, ctx(db));
    await createAutoIssueProposer()(outcome, ctx(db));
    const plans = await db
      .selectFrom('action_plans')
      .selectAll()
      .where('tenant_id', '=', TENANT)
      .where('dedupe_key', '=', `auto-issue:${REPO}:stable-auto-issue-fingerprint`)
      .execute();
    expect(plans).toHaveLength(1);
  });
});
