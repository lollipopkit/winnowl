import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import type { Actor, ChangeRequest, RepositoryRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import type { ChangedFile, PathCommitAuthor, RepositoryPermission, ReviewRecord, SourceControlProvider } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { requestReviewersOnce, suggestReviewers } from '../src/review-reviewers.js';

const NOW = Date.parse('2026-09-30T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const user = (id: string, type: Actor['type'] = 'user'): Actor => ({ providerUserId: id, login: id, type });
const AUTHOR = user('author');
const BOT = user('winnowl', 'bot');
const REPO = { namespace: 'acme', name: 'app' } as RepositoryRef;

function changeRequest(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    ref: { id: uuidv7(), repositoryId: uuidv7(), nativeId: '42', number: 42, kind: 'pull-request' },
    revision: { baseSha: 'base' },
    state: 'open',
    draft: false,
    author: AUTHOR,
    reviewers: [],
    ...over,
  } as ChangeRequest;
}

const file = (path: string, changes: number, over: Partial<ChangedFile> = {}): ChangedFile => ({
  oldPath: path,
  newPath: path,
  status: 'modified',
  additions: changes,
  deletions: 0,
  ...over,
});

function fakeProvider(opts: {
  history?: Record<string, PathCommitAuthor[]>;
  permissions?: Record<string, RepositoryPermission>;
  reviews?: ReviewRecord[];
}) {
  const queried: string[] = [];
  const requested: string[][] = [];
  const provider = {
    repositories: {
      listPathCommitAuthors: async (_r: RepositoryRef, path: string) => {
        queried.push(path);
        return opts.history?.[path] ?? [];
      },
      getActorPermission: async (_r: RepositoryRef, a: { login: string }) => opts.permissions?.[a.login] ?? 'write',
    },
    changes: {
      listReviews: async () => opts.reviews ?? [],
      requestReviewers: async (_ref: unknown, reviewers: Actor[]) => void requested.push(reviewers.map((r) => r.login)),
    },
  } as unknown as SourceControlProvider;
  return { provider, queried, requested };
}

const commit = (actor: Actor, days: number): PathCommitAuthor => ({ actor, committedAt: daysAgo(days) });

describe('suggestReviewers', () => {
  it('按改动行数占比 × 时间衰减打分;排除作者、bot、过旧提交与无 write 权限者', async () => {
    const { provider, queried } = fakeProvider({
      history: {
        'big.ts': [commit(user('alice'), 10), commit(AUTHOR, 1), commit(user('dependabot', 'bot'), 1)],
        'small.ts': [commit(user('bob'), 1), commit(user('bob'), 2)],
        'old.ts': [commit(user('carol'), 400)],
        'renamed-from.ts': [commit(user('reader'), 1)],
      },
      permissions: { reader: 'read' },
    });
    const picked = await suggestReviewers({
      provider,
      repo: REPO,
      changeRequest: changeRequest(),
      files: [
        file('big.ts', 90),
        file('small.ts', 10),
        file('old.ts', 50),
        file('new.ts', 500, { status: 'added' }),
        file('renamed-to.ts', 30, { oldPath: 'renamed-from.ts', status: 'renamed' }),
      ],
      bot: BOT,
      max: 3,
      now: NOW,
    });
    // alice: 90/180 ≈ 0.48; bob: 2 × 10/180 ≈ 0.11; carol is older than a year; reader is read-only and not suggested.
    expect(picked.map((a) => a.login)).toEqual(['alice', 'bob']);
    expect(queried).not.toContain('new.ts');
    expect(queried).toContain('renamed-from.ts');
  });

  it('provider 不支持查询 → 空', async () => {
    const provider = { repositories: {} } as unknown as SourceControlProvider;
    expect(await suggestReviewers({ provider, repo: REPO, changeRequest: changeRequest(), files: [file('a.ts', 1)], bot: BOT, max: 2, now: NOW })).toEqual([]);
  });
});

describe('requestReviewersOnce', () => {
  let stop: () => Promise<void>;
  let db: Db;
  const TENANT = uuidv7();
  const HOST = uuidv7();

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  const run = (provider: SourceControlProvider, cr: ChangeRequest) =>
    requestReviewersOnce({ db, provider, changeRequest: cr, reviewers: [user('alice')], bot: BOT, tenantId: TENANT, providerHostId: HOST });

  it('没有 reviewer 时请求,同一 PR 之后不再请求', async () => {
    const { provider, requested } = fakeProvider({});
    const cr = changeRequest();
    expect(await run(provider, cr)).toBe(true);
    expect(await run(provider, cr)).toBe(false);
    expect(requested).toEqual([['alice']]);
  });

  it('已有待 review 的人、已有人交过 review、草稿 → 不请求', async () => {
    const reviewed = fakeProvider({ reviews: [{ nativeId: '1', author: user('dave'), state: 'commented' }] });
    expect(await run(reviewed.provider, changeRequest())).toBe(false);
    const idle = fakeProvider({});
    expect(await run(idle.provider, changeRequest({ reviewers: [user('erin')] }))).toBe(false);
    expect(await run(idle.provider, changeRequest({ draft: true }))).toBe(false);
    expect([...reviewed.requested, ...idle.requested]).toEqual([]);
  });

  it('作者和 bot 自己的 review 不算有人审过', async () => {
    const { provider, requested } = fakeProvider({
      reviews: [
        { nativeId: '1', author: AUTHOR, state: 'commented' },
        { nativeId: '2', author: BOT, state: 'changes-requested' },
      ],
    });
    expect(await run(provider, changeRequest())).toBe(true);
    expect(requested).toEqual([['alice']]);
  });
});
