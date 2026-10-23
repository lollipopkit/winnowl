import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import { createReviewQuotaGate } from '../src/wiring/review-quota-gate.js';

describe('review quota gate by runner', () => {
  let stop: () => Promise<void>;
  let db: Db;
  const T = uuidv7();
  const REPO = uuidv7();

  const cost = (usd: number) =>
    db
      .insertInto('review_costs')
      .values({ id: uuidv7(), tenant_id: T, repository_id: REPO, change_request_id: null, revision_id: uuidv7(), input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: usd, candidate_count: 1, published_inline: 0, scopes_total: 1, scopes_complete: 1, created_at: new Date() })
      .execute();

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    const HOST = uuidv7();
    const INST = uuidv7();
    const PLAN = uuidv7();
    await db.insertInto('tenants').values({ id: T, name: 'gate', region: null, created_at: new Date() }).execute();
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: T, provider: 'github', base_url: 'https://github.com', api_url: 'https://api.github.com', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INST, tenant_id: T, provider_host_id: HOST, native_id: '9', account_login: 'gate', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: T, provider_host_id: HOST, installation_id: INST, native_id: '90', namespace: 'gate', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    await db
      .insertInto('plans')
      .values({ id: PLAN, key: 'gate', name: 'Gate', model_tier: 'cheap', monthly_cost_cap_usd: '0.5', monthly_review_quota: 2, monthly_token_quota: null, max_concurrency: 1, features: JSON.stringify({}) as unknown as Record<string, unknown>, active: true, created_at: new Date() })
      .execute();
    await db
      .insertInto('subscriptions')
      .values({ id: uuidv7(), tenant_id: T, plan_id: PLAN, status: 'active', overage_policy: 'reject', current_period_start: new Date(), current_period_end: null, created_at: new Date(), updated_at: new Date() })
      .execute();
  });

  afterAll(async () => {
    await stop?.();
  });

  it('a spent platform budget skips platform reviews but not reviews paid by the repository key', async () => {
    await db.insertInto('platform_settings').values({ key: 'quota.warn_ratio', value: '0.5', updated_by: 'test' }).execute();
    const gate = createReviewQuotaGate(db);
    const ctx = { payload: { tenantId: T } } as never;
    await cost(0.6);
    expect(await gate(ctx, { runner: 'platform' })).toMatchObject({ block: true, reasonCode: 'cost_quota' });
    expect(await gate(ctx, { runner: 'actions' })).toEqual({ block: false });

    // One review of two used: past the warn ratio, Actions tenants are warned too.
    const warnings = await db.selectFrom('notifications').select('title').where('tenant_id', '=', T).where('kind', '=', 'quota-warning').execute();
    expect(warnings.map((w) => w.title)).toContain('本周期额度已用 50%');

    await cost(0);
    expect(await gate(ctx, { runner: 'actions' })).toMatchObject({ block: true, reasonCode: 'review_quota' });
  });
});
