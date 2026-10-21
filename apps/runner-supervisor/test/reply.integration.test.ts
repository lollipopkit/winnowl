import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { ConversationTurnPayload } from '../src/conversation-turn.js';
import { createConversationReply } from '../src/reply.js';

/**
 * Reply idempotency keys are per request and per reply index within the turn: keying on
 * content length would drop a second, different reply of the same length.
 */
const TENANT = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();

describe('会话回执的幂等键(§26 / §8.1)', () => {
  let stop: () => Promise<void>;
  let db: Db;

  /** Fake provider that dedupes by idempotency key, like the real ones. */
  const recorder = (): { posted: { key: string; markdown: string }[]; provider: SourceControlProvider } => {
    const posted: { key: string; markdown: string }[] = [];
    const seen = new Set<string>();
    const provider = {
      discussions: {
        createTopLevelComment: async (
          _target: unknown,
          body: { markdown: string },
          idem: { key: string },
        ) => {
          if (seen.has(idem.key)) return { nativeId: 'dup' };
          seen.add(idem.key);
          posted.push({ key: idem.key, markdown: body.markdown });
          return { nativeId: `c${posted.length}` };
        },
      },
    } as unknown as SourceControlProvider;
    return { posted, provider };
  };

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db
      .insertInto('tenants')
      .values({ id: TENANT, name: 'acme', region: null, created_at: new Date() })
      .execute();
    const host = uuidv7();
    const install = uuidv7();
    await db
      .insertInto('provider_hosts')
      .values({
        id: host,
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
        id: install,
        tenant_id: TENANT,
        provider_host_id: host,
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
        provider_host_id: host,
        installation_id: install,
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
        state: 'open',
        draft: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  const payload = (over: Partial<ConversationTurnPayload> = {}): ConversationTurnPayload => ({
    tenantId: TENANT,
    target: { kind: 'change-request', nativeId: '42' },
    actorLogin: 'alice',
    body: '@winnowl approve',
    repositoryId: REPO,
    changeRequestId: CR,
    ...over,
  });

  it('同一次请求里的多条回执各自发得出去(哪怕长度一样)', async () => {
    const { posted, provider } = recorder();
    const reply = createConversationReply({ db, buildProvider: async () => provider });
    const p = payload({ commentNativeId: 'comment-1' });
    await reply(p, 'AB'); // same length, different body
    await reply(p, 'XY');
    expect(posted.map((x) => x.markdown)).toEqual(['AB', 'XY']);
    expect(posted[0]!.key).not.toBe(posted[1]!.key);
  });

  it('同一个请求重试(新 payload、同一评论 id)→ 不再发第二条', async () => {
    const { posted, provider } = recorder();
    const reply = createConversationReply({ db, buildProvider: async () => provider });
    await reply(payload({ commentNativeId: 'comment-2' }), 'approved');
    // Retry: new job and payload object, same triggering comment.
    await reply(payload({ commentNativeId: 'comment-2', turnId: 'job-2' }), 'approved');
    expect(posted).toHaveLength(1);
  });

  it('两条不同的命令(不同评论 id)发同样长度的回执 → 两条都发', async () => {
    const { posted, provider } = recorder();
    const reply = createConversationReply({ db, buildProvider: async () => provider });
    await reply(payload({ commentNativeId: 'comment-3' }), 'ok ok');
    await reply(payload({ commentNativeId: 'comment-4' }), 'no no');
    expect(posted).toHaveLength(2);
  });

  it('没有评论 id 时按 job id 判身份:同 job 重试不重复,不同 job 不被吞', async () => {
    const { posted, provider } = recorder();
    const reply = createConversationReply({ db, buildProvider: async () => provider });
    const job = payload({ turnId: 'job-a' });
    await reply(job, 'nothing pending');
    await reply(payload({ turnId: 'job-a' }), 'nothing pending'); // retry → same key
    await reply(payload({ turnId: 'job-b' }), 'nothing pending'); // another turn → another key
    expect(posted).toHaveLength(2);
  });

  it('既没有评论 id 也没有 job id(临时构造的 payload)→ 不去重,绝不吞', async () => {
    const { posted, provider } = recorder();
    const reply = createConversationReply({ db, buildProvider: async () => provider });
    // Two distinct payload objects with the same body are two notifications; both are sent.
    await reply(payload(), 'plan failed');
    await reply(payload(), 'plan failed');
    expect(posted).toHaveLength(2);
  });
});
