import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertConversation, newConversation } from '@reviewbot/conversation';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { ensureRunnerPool, enqueueJob, registerWorker } from '@reviewbot/queue';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { loadEffectiveConfig, persistEffectiveConfig } from '@reviewbot/review-runtime';
import { createConversationTurnHandler, type ConversationRouteContext, type ConversationTurnPayload } from '../src/conversation-turn.js';
import { createConversationRoute } from '../src/conversation-route.js';
import { Supervisor } from '../src/supervisor.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();
const REV = uuidv7();
const FINDING = uuidv7();
/** Our inline comment (= the GitHub thread id). */
const THREAD = 'c-finding-thread';
const noopSandbox = {} as unknown as SandboxBackend;

/*
 * Replies in our finding's thread are handled without a mention and classified with the finding;
 * the author's argument goes to the verifier. Other threads, chit-chat and third-party bots cost nothing.
 */
describe('replies in a finding thread', () => {
  let db: Db;
  let stop: () => Promise<void>;
  let workerId: string;

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    const now = new Date();
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: now }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: now }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: now }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: now }).execute();
    await db.insertInto('change_requests').values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '42', number: 42, kind: 'pull-request', source_branch: 'feat', target_branch: 'main', state: 'open', draft: false, author: 'alice', author_provider_id: 'gh-author', created_at: now, updated_at: now }).execute();
    await db.insertInto('revisions').values({ id: REV, tenant_id: TENANT, change_request_id: CR, base_sha: 'base', head_sha: 'head-1', merge_base_sha: null, source_branch: 'feat', target_branch: 'main', created_at: now }).execute();
    await db.insertInto('findings').values({ id: FINDING, tenant_id: TENANT, repository_id: REPO, semantic_fingerprint: `fp-${FINDING}`, category: 'correctness', canonical_claim: 'average([]) throws a TypeError', lifecycle: 'published', first_seen_at: now, last_seen_at: now }).execute();
    await db.insertInto('publication_records').values({ id: uuidv7(), tenant_id: TENANT, repository_id: REPO, change_request_id: CR, revision_id: REV, finding_id: FINDING, provider_host_id: HOST, kind: 'inline', idempotency_key: 'k-thread', provider_native_id: THREAD, provider_url: null, state: 'published', request_digest: 'd', created_at: now, updated_at: now }).execute();
    const baseCfg = await loadEffectiveConfig(db, TENANT, REPO);
    await persistEffectiveConfig(db, { tenantId: TENANT, repositoryId: REPO, settings: baseCfg, configDigest: 'default' });
    const poolId = await ensureRunnerPool(db, { tenantId: TENANT, name: 'pool' });
    workerId = await registerWorker(db, { poolId, version: '1.0.0', capabilities: {} });
  });

  afterAll(async () => {
    await stop?.();
  });

  const reply = (over: Partial<ConversationTurnPayload> = {}): ConversationTurnPayload => ({
    tenantId: TENANT,
    target: { kind: 'review-thread', nativeId: THREAD },
    actorLogin: 'alice',
    body: 'Callers always pass at least one sample; the list comes from a non-empty form field.',
    repositoryId: REPO,
    changeRequestId: CR,
    ...over,
  });

  /** Runs one conversation_turn; records what reached the agent and the router. */
  async function turn(payload: ConversationTurnPayload) {
    const routed: ConversationRouteContext[] = [];
    const agent: { findingClaim?: string }[] = [];
    const handler = createConversationTurnHandler({
      botName: 'winnowl',
      route: async (ctx) => void routed.push(ctx),
      startAgent: async ({ findingClaim }) => void agent.push(findingClaim ? { findingClaim } : {}),
    });
    await enqueueJob(db, { tenantId: TENANT, type: 'conversation_turn', payload: payload as unknown as Record<string, unknown>, dedupeKey: uuidv7() });
    await new Supervisor({ db, sandbox: noopSandbox, workerId, handlers: { conversation_turn: handler } }).runOnce();
    return { routed, agent };
  }

  it('a reply without a mention goes to the agent with the finding it answers', async () => {
    const r = await turn(reply());
    expect(r.routed).toHaveLength(0);
    expect(r.agent).toEqual([{ findingClaim: expect.stringContaining('average([]) throws a TypeError') }]);
  });

  it('other threads and third-party bots reach neither the agent nor the router', async () => {
    const other = await turn(reply({ target: { kind: 'review-thread', nativeId: 'someone-elses-thread' } }));
    expect(other.agent).toHaveLength(0);
    expect(other.routed).toHaveLength(0);
    const bot = await turn(reply({ actorLogin: 'coderabbitai[bot]', actorIsBot: true }));
    expect(bot.agent).toHaveLength(0);
    expect(bot.routed).toHaveLength(0);
  });

  it('a challenge from the thread hands the reply and the thread to re-verification', async () => {
    const conversation = newConversation({ tenantId: TENANT, target: { kind: 'review-thread', nativeId: `${THREAD}:route` }, repositoryId: REPO, changeRequestId: CR });
    await insertConversation(db, conversation);
    const replies: string[] = [];
    const route = createConversationRoute({ reply: async (_p, t) => void replies.push(t) });
    const payload = reply();
    // The agent passes the commenter's reasoning as the command argument.
    for (const [intent, argument] of [['challenge-finding', payload.body], ['resolve-finding', 'Fixed in the last commit.']] as const) {
      await route({ intent: { intent, source: 'agent', argument }, conversation, payload, db });
    }
    const jobs = await db.selectFrom('jobs').select('payload').where('type', '=', 'reverify_findings').execute();
    const payloads = jobs.map((j) => j.payload as { targetFindingId?: string; authorReply?: string; threadNativeId?: string });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ targetFindingId: FINDING, authorReply: payload.body, threadNativeId: THREAD });
    expect(payloads[1]).toMatchObject({ targetFindingId: FINDING, authorReply: 'Fixed in the last commit.' });
    expect(replies).toHaveLength(2);
  });
});
