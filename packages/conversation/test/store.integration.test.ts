import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  appendMessage,
  insertConversation,
  listConversations,
  listMessages,
  loadConversation,
  updateConversation,
  type Conversation,
} from '../src/index.js';

const TENANT = uuidv7();

function conv(id: string): Conversation {
  return { id, tenantId: TENANT, target: { kind: 'change-request', nativeId: id }, state: 'active', summary: '' };
}

describe('Conversation 持久化', () => {
  let stop: () => Promise<void>;
  let db: Db;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('insert → load 往返', async () => {
    const id = uuidv7();
    await insertConversation(db, conv(id));
    const loaded = await loadConversation(db, TENANT, id);
    expect(loaded).toMatchObject({ id, target: { kind: 'change-request', nativeId: id }, state: 'active' });
  });

  it('appendMessage → listMessages(按时间序)', async () => {
    const id = uuidv7();
    await insertConversation(db, conv(id));
    await appendMessage(db, { conversationId: id, actorLogin: 'alice', body: '@winnowl review', now: 1000 });
    await appendMessage(db, { conversationId: id, actorLogin: 'bot', body: 'on it', now: 2000 });
    const msgs = await listMessages(db, id);
    expect(msgs.map((m) => m.body)).toEqual(['@winnowl review', 'on it']);
  });

  it('updateConversation 状态/摘要', async () => {
    const id = uuidv7();
    await insertConversation(db, conv(id));
    await updateConversation(db, id, { state: 'completed', summary: '已完成 review', contextRevisionSha: 'head-1' });
    const loaded = await loadConversation(db, TENANT, id);
    expect(loaded).toMatchObject({ state: 'completed', summary: '已完成 review', contextRevisionSha: 'head-1' });
  });

  it('listConversations 按 tenant', async () => {
    const list = await listConversations(db, TENANT);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.tenantId === TENANT)).toBe(true);
  });
});
