import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent, type ResolvedModelSource } from '@reviewbot/agent-pi';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { runGit } from '@reviewbot/git-repository';
import { openLocalCodePlane } from '@reviewbot/review-runtime';
import { createCrossRepoAnalyzeHandler } from '../src/cross-repo-analyze.js';
import { createRelationshipDiscoverHandler } from '../src/relationship-discover.js';
import type { JobHandler } from '../src/supervisor.js';

function run(handler: JobHandler, db: Db, payload: unknown): Promise<unknown> {
  return handler({ job: { payload } as never, db, log: () => undefined } as unknown as Parameters<JobHandler>[0]);
}

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO_CORE = uuidv7(); // provider (npm package @acme/core)
const REPO_APP = uuidv7(); // consumer (depends on @acme/core)
const CR_ID = uuidv7();
const REV = uuidv7();

/** relationship_discover end to end (fixture workspace) and cross_repo_analyze (faux agent, stub provider). */
describe('跨仓:发现扫描 + 深度分析', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let fixtureRoot: string;
  let coreDir: string;
  let appDir: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db
      .insertInto('repositories')
      .values([
        { id: REPO_CORE, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: 'c', namespace: 'acme', name: 'core', clone_url: 'https://x/core.git', default_branch: 'main', created_at: new Date() },
        { id: REPO_APP, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: 'a', namespace: 'acme', name: 'app', clone_url: 'https://x/app.git', default_branch: 'main', created_at: new Date() },
      ])
      .execute();
    await db.insertInto('change_requests').values({ id: CR_ID, tenant_id: TENANT, repository_id: REPO_CORE, native_id: '7', number: 7, kind: 'pull-request', source_branch: 'feat', target_branch: 'main', state: 'open', draft: false, created_at: new Date(), updated_at: new Date() }).execute();
    await db.insertInto('revisions').values({ id: REV, tenant_id: TENANT, change_request_id: CR_ID, base_sha: 'b'.repeat(40), head_sha: 'h'.repeat(40), merge_base_sha: null, source_branch: 'feat', target_branch: 'main', created_at: new Date() }).execute();
    // billRevision needs an existing review_costs row.
    await db
      .insertInto('review_costs')
      .values({ id: uuidv7(), tenant_id: TENANT, repository_id: REPO_CORE, change_request_id: CR_ID, revision_id: REV, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: '0', candidate_count: 0, published_inline: 0, created_at: new Date() })
      .execute();

    // Two fixture repositories; the handler opens shallow workspaces through the production executor.
    fixtureRoot = await mkdtemp(join(tmpdir(), 'xrepo-fixture-'));
    coreDir = join(fixtureRoot, 'core');
    appDir = join(fixtureRoot, 'app');
    await mkdir(join(coreDir, 'src'), { recursive: true });
    await mkdir(join(appDir, 'src'), { recursive: true });
    await writeFile(join(coreDir, 'package.json'), JSON.stringify({ name: '@acme/core', dependencies: {} }));
    await writeFile(join(appDir, 'package.json'), JSON.stringify({ name: '@acme/app', dependencies: { '@acme/core': '^1.0.0' } }));
    await writeFile(join(appDir, 'src', 'client.ts'), "import { fetchUser } from '@acme/core';\nexport const u = fetchUser('42');\n");
    for (const dir of [coreDir, appDir]) {
      await runGit(dir, ['init', '-q', '-b', 'main']);
      await runGit(dir, ['add', '-A']);
      await runGit(dir, ['-c', 'user.email=t@t.co', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
    }
  });

  /** The fixture repository behind a clone URL, opened as a shallow workspace. */
  const openFixture = (dirs: Map<string, string>) => async (repo: { cloneUrl: string }) =>
    openLocalCodePlane({ cloneUrl: dirs.get(repo.cloneUrl)!, depth: 1 }, join(fixtureRoot, 'ws'));

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    await stop?.();
  });

  it('relationship_discover:A 提供 npm 包、B 依赖 → 落 repository_packages + proposed 关系 + 审计', async () => {
    const dirs = new Map([
      ['https://x/core.git', coreDir],
      ['https://x/app.git', appDir],
    ]);
    const handler = createRelationshipDiscoverHandler({
      openRepository: openFixture(dirs),
    });
    await run(handler, db, { tenantId: TENANT, trigger: 'manual' });

    const pkgs = await db.selectFrom('repository_packages').select(['repository_id', 'role', 'name']).where('tenant_id', '=', TENANT).execute();
    expect(pkgs.some((p) => p.repository_id === REPO_CORE && p.role === 'provides' && p.name === '@acme/core')).toBe(true);
    expect(pkgs.some((p) => p.repository_id === REPO_APP && p.role === 'depends' && p.name === '@acme/core')).toBe(true);

    const rel = await db
      .selectFrom('repository_relationships')
      .selectAll()
      .where('source_repository_id', '=', REPO_CORE)
      .where('target_repository_id', '=', REPO_APP)
      .executeTakeFirstOrThrow();
    expect(rel).toMatchObject({ status: 'proposed', kind: 'library-dependent', proposed_by: 'auto:discover', enabled: false });
    expect(rel.rationale).toContain('npm:@acme/core');

    // A rerun is idempotent: nothing proposed again.
    await run(handler, db, { tenantId: TENANT, trigger: 'manual' });
    const count = await db.selectFrom('repository_relationships').select((eb) => eb.fn.countAll<string>().as('n')).where('tenant_id', '=', TENANT).executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('cross_repo_analyze:faux 出 impact → consumer issue + producer 顶层评论(幂等记录)+ 计费 + 审计', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('submit_impact', { path: 'src/client.ts', claim: 'fetchUser now requires a numeric id; string call site breaks', severity: 'high', evidence: "fetchUser('42')" })),
      faux.assistant(faux.toolCall('complete_analysis', { summary: 'One breaking call site.' })),
    ]);
    const issues: { repoId: string; title: string; body: string; key: string }[] = [];
    const topLevel: { body: string }[] = [];
    const provider = {
      issues: {
        create: async (repo: { id: string }, input: { title: string; body: { markdown: string } }, idem: { key: string }) => {
          issues.push({ repoId: repo.id, title: input.title, body: input.body.markdown, key: idem.key });
          return { nativeId: 'i1', url: 'https://x/issues/1' };
        },
      },
      discussions: {
        createTopLevelComment: async (_t: unknown, body: { markdown: string }) => {
          topLevel.push({ body: body.markdown });
          return { nativeId: 't1', url: 'u' };
        },
      },
    } as unknown as SourceControlProvider;

    const handler = createCrossRepoAnalyzeHandler({
      resolveModel: () => ({ model: faux.model, streamFn: faux.streamFn }) as ResolvedModelSource,
      openRepository: openFixture(new Map([['https://x/app.git', appDir]])),
      buildProvider: async () => provider,
    });
    await run(handler, db, {
      tenantId: TENANT,
      sourceRepositoryId: REPO_CORE,
      revisionId: REV,
      consumer: { repositoryId: REPO_APP, relationshipId: uuidv7(), kind: 'library-dependent' },
      triggers: [{ kind: 'versioned-library-api', files: ['package.json'] }],
      contractContext: [{ path: 'src/index.ts', headContent: 'export function fetchUser(id: number): User', truncated: false }],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]!.repoId).toBe(REPO_APP); // the issue goes to the consumer repository
    expect(issues[0]!.key).toBe(`xrepo:${REV}:${REPO_APP}`);
    expect(issues[0]!.body).toContain('src/client.ts');
    expect(issues[0]!.title).toContain('acme/core');
    expect(topLevel).toHaveLength(1); // note on the producer PR
    expect(topLevel[0]!.body).toContain('acme/app');

    const cost = await db.selectFrom('review_costs').select('total_tokens').where('revision_id', '=', REV).executeTakeFirstOrThrow();
    expect(Number(cost.total_tokens)).toBeGreaterThan(0); // usage billed to the producer revision
    const audit = await db.selectFrom('audit_events').select('action').where('action', '=', 'cross-repo.analyzed').execute();
    expect(audit).toHaveLength(1);
  });

  it('cross_repo_analyze:无 impact → 不建 issue 不发评论,仅审计', async () => {
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('complete_analysis', { summary: 'No impact.' }))]);
    const issues: unknown[] = [];
    const provider = {
      issues: { create: async () => (issues.push(1), { nativeId: 'x', url: 'u' }) },
      discussions: { createTopLevelComment: async () => ({ nativeId: 'x', url: 'u' }) },
    } as unknown as SourceControlProvider;
    const handler = createCrossRepoAnalyzeHandler({
      resolveModel: () => ({ model: faux.model, streamFn: faux.streamFn }) as ResolvedModelSource,
      openRepository: openFixture(new Map([['https://x/app.git', appDir]])),
      buildProvider: async () => provider,
    });
    await run(handler, db, {
      tenantId: TENANT,
      sourceRepositoryId: REPO_CORE,
      revisionId: REV,
      consumer: { repositoryId: REPO_APP, relationshipId: uuidv7(), kind: 'library-dependent' },
      triggers: [{ kind: 'versioned-library-api', files: ['package.json'] }],
      contractContext: [],
    });
    expect(issues).toHaveLength(0);
  });
});
