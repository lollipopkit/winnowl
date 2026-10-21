import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  agentMemoryExists,
  buildMemoryIndex,
  insertAgentMemory,
  listAgentMemories,
  newAgentMemory,
  normalizeMemoryTitle,
} from '../src/index.js';

const TENANT = uuidv7();
const TENANT_B = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();

describe('Agent 记忆持久化与索引', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    await db.insertInto('tenants').values({ id: TENANT_B, name: 'other', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '1', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
  });

  afterAll(async () => {
    await stop();
  });

  it('insert → list 往返(title 归一化,links/selector/origin 保真)', async () => {
    const m = newAgentMemory({
      kind: 'repo-quirk',
      title: '  Build  Needs   PNPM ',
      summary: '构建必须用 pnpm,npm 会因 workspace 协议失败',
      body: '详情:workspace:* 协议;CI 亦然。',
      selector: 'packages/**',
      links: ['some-id'],
      originReviewId: uuidv7(),
    });
    await insertAgentMemory(db, TENANT, REPO, m);
    const listed = await listAgentMemories(db, TENANT, REPO);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.title).toBe('build needs pnpm');
    expect(listed[0]!.links).toEqual(['some-id']);
    expect(listed[0]!.selector).toBe('packages/**');
    expect(listed[0]!.status).toBe('active');
  });

  it('agentMemoryExists:归一化等值命中;别租户不命中(隔离)', async () => {
    expect(await agentMemoryExists(db, TENANT, REPO, 'BUILD   needs pnpm')).toBe(true);
    expect(await agentMemoryExists(db, TENANT, REPO, 'unknown')).toBe(false);
    expect(await agentMemoryExists(db, TENANT_B, REPO, 'build needs pnpm')).toBe(false);
  });

  it('buildMemoryIndex:selector 命中任一变更文件才入;过期剔除;渲染 kind/title/summary', () => {
    const now = 1_000_000;
    const hit = newAgentMemory({ kind: 'repo-quirk', title: 'a', summary: 'S-a', body: 'B', selector: 'src/**', now });
    const miss = newAgentMemory({ kind: 'arch-note', title: 'b', summary: 'S-b', body: 'B', selector: 'docs/**', now });
    const expired = newAgentMemory({ kind: 'arch-note', title: 'c', summary: 'S-c', body: 'B', expiresAt: now - 1, now });
    const global = newAgentMemory({ kind: 'false-positive-pattern', title: 'd', summary: 'S-d', body: 'B', now });
    const idx = buildMemoryIndex([hit, miss, expired, global], ['src/x.ts'], { now });
    expect(idx.entries.map((m) => m.title)).toEqual(['a', 'd']);
    expect(idx.indexText).toContain('- [repo-quirk] a — S-a');
    expect(idx.indexText).toContain('- [false-positive-pattern] d — S-d');
    expect(idx.truncated).toBe(0);
  });

  it('buildMemoryIndex:超上限截断 + 显式提示行(不静默丢);空集 → 无 indexText', () => {
    const many = Array.from({ length: 5 }, (_, i) => newAgentMemory({ kind: 'repo-quirk', title: `t${i}`, summary: `s${i}`, body: 'b', now: 1000 + i }));
    const idx = buildMemoryIndex(many, [], { maxLines: 3 });
    expect(idx.entries).toHaveLength(3);
    expect(idx.truncated).toBe(2);
    expect(idx.indexText).toContain('另有 2 条记忆超出索引上限');
    expect(buildMemoryIndex([], []).indexText).toBeUndefined();
  });

  it('normalizeMemoryTitle 幂等', () => {
    expect(normalizeMemoryTitle(normalizeMemoryTitle('  A  B '))).toBe('a b');
  });
});
