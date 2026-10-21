import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendMessage, insertConversation, type Conversation } from '@reviewbot/conversation';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

const TENANT = uuidv7();
const CONV = uuidv7();

describe('control-api Conversation 端点', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();
    const conversation: Conversation = { id: CONV, tenantId: TENANT, target: { kind: 'change-request', nativeId: '42' }, state: 'active', summary: 'review add()' };
    await insertConversation(db, conversation);
    await appendMessage(db, { conversationId: CONV, actorLogin: 'alice', body: '@winnowl explain' });
    app = await buildServer({ quiet: true, db, rbac: { resolveAuth: () => ({ role: 'admin', scopes: ['admin'], tenantId: TENANT, actorId: 'alice' }) } });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await stop?.();
  });

  it('GET /v1/conversations 列出', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/conversations' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: { id: string }[] }).items.some((c) => c.id === CONV)).toBe(true);
  });

  it('GET /v1/conversations/:id 含消息', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/conversations/${CONV}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conversation: { summary: string }; messages: { body: string }[] };
    expect(body.conversation.summary).toBe('review add()');
    expect(body.messages[0]!.body).toBe('@winnowl explain');
  });

  it('未知会话 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/conversations/${uuidv7()}` });
    expect(res.statusCode).toBe(404);
  });
});
