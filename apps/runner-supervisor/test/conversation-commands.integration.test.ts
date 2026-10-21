import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newConversation } from '@reviewbot/conversation';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import type { RepositoryPermission } from '@reviewbot/provider-contracts';
import { loadEffectiveConfig, persistEffectiveConfig } from '@reviewbot/review-runtime';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createConversationRoute } from '../src/conversation-route.js';
import type { ConversationTurnPayload } from '../src/conversation-turn.js';
import { createRunCommandHandler } from '../src/run-command.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const INSTALL = uuidv7();
const REPO = uuidv7();
const CR = uuidv7();

describe('show config and run', () => {
  let stop: () => Promise<void>;
  let db: Db;
  const replies: string[] = [];
  const PERMISSIONS: Record<string, RepositoryPermission> = { writer: 'write' };
  const route = createConversationRoute({
    resolveActorPermission: async (_r, a) => PERMISSIONS[a.login] ?? 'read',
    reply: async (_p, t) => void replies.push(t),
  });
  const conversation = {
    ...newConversation({ tenantId: TENANT, target: { kind: 'change-request', nativeId: '42' }, repositoryId: REPO, changeRequestId: CR }),
    id: uuidv7(),
  };
  const say = async (actor: string, intent: 'show-config' | 'run-command', argument?: string, over: Partial<ConversationTurnPayload> = {}) => {
    replies.length = 0;
    const payload: ConversationTurnPayload = {
      tenantId: TENANT,
      target: { kind: 'change-request', nativeId: '42' },
      actorLogin: actor,
      body: '',
      repositoryId: REPO,
      changeRequestId: CR,
      commentNativeId: uuidv7(),
      ...over,
    };
    await route({ intent: { intent, source: 'command', ...(argument ? { argument } : {}) }, conversation, payload, db });
    return replies.join('\n');
  };
  const runJobs = () => db.selectFrom('jobs').select('payload').where('type', '=', 'run_command').execute();
  const setRunAllowed = async (allowed: boolean) => {
    const cfg = await loadEffectiveConfig(db, TENANT, REPO);
    await persistEffectiveConfig(db, { tenantId: TENANT, repositoryId: REPO, settings: { ...cfg, chat: { ...cfg.chat, allow_run_command: allowed } }, configDigest: String(allowed) });
  };

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    const now = new Date();
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: now }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TENANT, provider: 'github', base_url: 'x', api_url: 'x', is_saas: true, created_at: now }).execute();
    await db.insertInto('installations').values({ id: INSTALL, tenant_id: TENANT, provider_host_id: HOST, native_id: '1', account_login: 'acme', status: 'active', created_at: now }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TENANT, provider_host_id: HOST, installation_id: INSTALL, native_id: '900', namespace: 'acme', name: 'app', clone_url: 'x', default_branch: 'main', created_at: now }).execute();
    await db
      .insertInto('change_requests')
      .values({ id: CR, tenant_id: TENANT, repository_id: REPO, native_id: '42', number: 42, kind: 'pull-request', source_branch: 'feat', target_branch: 'main', state: 'open', draft: false, author: 'alice', author_provider_id: '1', created_at: now, updated_at: now })
      .execute();
    const cfg = await loadEffectiveConfig(db, TENANT, REPO);
    await persistEffectiveConfig(db, { tenantId: TENANT, repositoryId: REPO, settings: { ...cfg, language: 'en' }, configDigest: 'en' });
  });
  afterAll(async () => {
    await stop?.();
  });

  it('show config replies with the effective configuration as YAML', async () => {
    const text = await say('passer-by', 'show-config');
    expect(text).toContain('```yaml');
    expect(text).toContain('allow_run_command: true');
  });

  it('run is queued for writers only, with a command, and only when the repository allows it', async () => {
    expect(await say('passer-by', 'run-command', 'npm test')).toContain('write access');
    expect(await say('writer', 'run-command')).toContain('Write the command after `run`');
    expect(await say('writer', 'run-command', 'npm test', { changeRequestId: undefined })).toContain('works on a pull request');
    expect(await runJobs()).toHaveLength(0);

    // Authorship is not enough: anyone can open a pull request on a public repository.
    expect(await say('alice', 'run-command', 'npm run lint', { actorId: '1' })).toContain('write access');
    expect(await say('writer', 'run-command', 'npm test')).toBe('');
    expect(await say('writer', 'run-command', 'npm run lint')).toBe('');
    expect((await runJobs()).map((j) => (j.payload as { command: string }).command)).toEqual(['npm test', 'npm run lint']);

    await setRunAllowed(false);
    expect(await say('writer', 'run-command', 'npm test')).toContain('turned off');
    expect(await runJobs()).toHaveLength(2);
  });

  it('without a sandbox for it, run says so instead of failing silently', async () => {
    const posted: string[] = [];
    const handler = createRunCommandHandler({
      db,
      buildProvider: async () => {
        throw new Error('not reached');
      },
      openRepository: async () => {
        throw new Error('not reached');
      },
      modelSource: () => null,
      reply: async (_p, t) => void posted.push(t),
    });
    const turn = { tenantId: TENANT, target: { kind: 'change-request' as const, nativeId: '42' }, actorLogin: 'writer', body: '', repositoryId: REPO, changeRequestId: CR };
    await handler({ job: { id: uuidv7(), payload: { turn, command: 'npm test' } } as never, db, log: () => undefined } as unknown as Parameters<typeof handler>[0]);
    expect(posted).toEqual([expect.stringContaining('could not be started')]);
  });
});
