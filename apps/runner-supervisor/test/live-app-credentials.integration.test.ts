import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { createEnvCredentialStore, createSourceProviderForInstallation, getInstallationToken } from '@reviewbot/provider-factory';
import { startMigratedPostgres } from '@reviewbot/testkit';

/**
 * GitHub App credential chain, live (skipped by default).
 * Needs .env: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY(_PATH) / GITHUB_APP_INSTALLATION_ID
 * + REVIEWBOT_LIVE_GITHUB_REPO (owner/name) / REVIEWBOT_LIVE_GITHUB_PR.
 * Checks App JWT → installation token → read PR, create issue, create a Check Run (App-only).
 */
const appId = process.env.GITHUB_APP_ID;
const installNativeId = process.env.GITHUB_APP_INSTALLATION_ID;
const hasKey = Boolean(process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_PATH);
const repoSlug = process.env.REVIEWBOT_LIVE_GITHUB_REPO;
const prNumber = process.env.REVIEWBOT_LIVE_GITHUB_PR;
const [owner, name] = (repoSlug ?? '/').split('/');
const enabled = Boolean(appId && installNativeId && hasKey && repoSlug && prNumber);

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();

describe.skipIf(!enabled)('GitHub App 凭据链路 live(App JWT→token→读写+Check Run)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'https://github.com', api_url: 'https://api.github.com', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: installNativeId as string, account_login: owner ?? '', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: 'live', namespace: owner ?? '', name: name ?? '', clone_url: `https://github.com/${repoSlug}.git`, default_branch: 'main', created_at: new Date() }).execute();
  }, 60_000);

  afterAll(async () => {
    await stop?.();
  });

  it('App JWT → installation token(ghs_)', async () => {
    const token = await getInstallationToken({ db, store: createEnvCredentialStore() }, INSTALL);
    expect(token).toMatch(/^(ghs_|v1\.)/); // installation token
    console.log('[live-app] installation token acquired (prefix)', token.slice(0, 4));
  }, 60_000);

  it('createSourceProviderForInstallation → 读 PR + 建 issue + 提交 Check Run', async () => {
    const provider = await createSourceProviderForInstallation({ db, store: createEnvCredentialStore() }, INSTALL);
    const crRef = { id: uuidv7(), repositoryId: REPO, nativeId: 'live', number: Number(prNumber), kind: 'pull-request' as const };

    const cr = await provider.changes.get(crRef);
    expect(typeof cr.title).toBe('string');
    expect(cr.revision.headSha).toBeTruthy();

    const issue = await provider.issues.create(
      { id: REPO, providerHostId: HOST, installationId: INSTALL, nativeId: 'live', namespace: owner ?? '', name: name ?? '', cloneUrl: '', defaultBranch: 'main' },
      { title: `winnowl app-cred smoke ${Date.now()}`, body: { markdown: 'App installation token write smoke' }, labels: ['winnowl'] },
      { key: `app-issue-${Date.now()}` },
    );
    expect(issue.ref.number).toBeGreaterThan(0);

    // Only a GitHub App installation token can create Check Runs (not PAT/OAuth).
    const check = await provider.checks.createOrUpdate(
      { id: REPO, providerHostId: HOST, installationId: INSTALL, nativeId: 'live', namespace: owner ?? '', name: name ?? '', cloneUrl: '', defaultBranch: 'main' },
      { name: 'winnowl/app-cred-smoke', status: 'completed', conclusion: 'neutral', title: 'app cred smoke', summary: 'App token can submit checks', headSha: cr.revision.headSha },
      { key: `app-check-${Date.now()}` },
    );
    expect(check.nativeId).toBeTruthy();
    console.log('[live-app] created issue #', issue.ref.number, 'and Check Run', check.nativeId);
  }, 90_000);
});
