import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import type { SandboxBackend } from '@reviewbot/sandbox';
import { createWebhookConfigCheckHandler } from '../src/webhook-config-check.js';

const TENANT = uuidv7();
const EXPECTED = 'https://winnowl.lollipopkit.com/webhooks/github';
const noopSandbox = {} as unknown as SandboxBackend;

// readConfig is injected, so no request is sent, but signAppJwt still needs a valid RSA key.
import { generateKeyPairSync } from 'node:crypto';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

describe('webhook_config_check(§可观测性:配置漂移巡检)', () => {
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

  const run = async (opts: {
    url?: string;
    insecureSsl?: string;
    expected?: string | undefined;
    creds?: boolean;
  }): Promise<string[]> => {
    const logs: string[] = [];
    const handler = createWebhookConfigCheckHandler({
      appCredentials: async () => (opts.creds === false ? null : { appId: '4312382', privateKeyPem: PEM }),
      expectedUrl: () => (opts.expected === undefined && 'expected' in opts ? undefined : (opts.expected ?? EXPECTED)),
      readConfig: async () => ({ url: opts.url ?? EXPECTED, ...(opts.insecureSsl ? { insecureSsl: opts.insecureSsl } : {}) }),
    });
    await handler({
      job: { id: uuidv7(), tenantId: TENANT, type: 'webhook_config_check', status: 'running', priority: 100, dedupeKey: null, payload: { tenantId: TENANT }, runnerSelector: {}, attemptCount: 1, maxAttempts: 3, cancellationRequested: false, leaseOwner: null },
      db,
      sandbox: noopSandbox,
      log: (m) => logs.push(m),
    });
    return logs;
  };

  const drifts = async (): Promise<Record<string, unknown>[]> =>
    (await db.selectFrom('audit_events').select('detail').where('action', '=', 'webhook.config-drift').execute()).map(
      (r) => r.detail as unknown as Record<string, unknown>,
    );

  it('配置一致 → 通过,不落审计', async () => {
    const logs = await run({});
    expect(logs.join()).toContain('巡检通过');
    expect(await drifts()).toHaveLength(0);
  });

  it('指向旧 VM(七天全断的形态)→ 落 webhook.config-drift 审计 + 刺眼日志', async () => {
    const logs = await run({ url: 'https://old-host.example.com/webhooks/github' });
    expect(logs.join()).toContain('漂移');
    const rows = await drifts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.drifted).toBe(true);
    expect(rows[0]!.actual).toContain('old-host.example.com');
    expect(rows[0]!.expected).toBe(EXPECTED);
  });

  it('insecure_ssl=1 → 也算问题(明文投递泄露 payload)', async () => {
    await db.deleteFrom('audit_events').where('action', '=', 'webhook.config-drift').execute();
    await run({ insecureSsl: '1' });
    const rows = await drifts();
    expect(rows[0]!.insecure).toBe(true);
  });

  it('未配期望值 → 跳过(不拿当前值当基线,免得把误配固化成正确)', async () => {
    await db.deleteFrom('audit_events').where('action', '=', 'webhook.config-drift').execute();
    const logs = await run({ expected: undefined, url: 'https://whatever.example/webhooks/github' });
    expect(logs.join()).toContain('跳过');
    expect(await drifts()).toHaveLength(0);
  });

  it('无 App 凭据 → 跳过,不报漂移', async () => {
    const logs = await run({ creds: false });
    expect(logs.join()).toContain('跳过');
    expect(await drifts()).toHaveLength(0);
  });
});
