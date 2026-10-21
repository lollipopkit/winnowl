import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { startMigratedPostgres } from '@reviewbot/testkit';
import {
  checkQuota,
  currentMonthStart,
  decideForReview,
  FREE_PLAN,
  periodUsage,
  provisionTenant,
  resolveDefaultModel,
  resolvePlan,
  resolvePublicRepoBilling,
} from '../src/index.js';

describe('entitlement 计划/配额 + 开通(用户系统 P3/P4)', () => {
  let stop: () => Promise<void>;
  let db: Db;
  const TENANT = uuidv7(); // resolvePlan
  const TU = uuidv7();
  const HOST = uuidv7();
  const INST = uuidv7();
  const REPO = uuidv7();

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values([
      { id: TENANT, name: 'acme', region: null, created_at: new Date() },
      { id: TU, name: 'usage', region: null, created_at: new Date() },
    ]).execute();
    // host -> installation -> repo -> review_costs (2 rows this month, 3000 tokens)
    await db.insertInto('provider_hosts').values({ id: HOST, tenant_id: TU, provider: 'github', base_url: 'https://github.com', api_url: 'https://api.github.com', is_saas: true, created_at: new Date() }).execute();
    await db.insertInto('installations').values({ id: INST, tenant_id: TU, provider_host_id: HOST, native_id: '7', account_login: 'usage', status: 'active', created_at: new Date() }).execute();
    await db.insertInto('repositories').values({ id: REPO, tenant_id: TU, provider_host_id: HOST, installation_id: INST, native_id: '70', namespace: 'usage', name: 'app', clone_url: 'x', default_branch: 'main', created_at: new Date() }).execute();
    for (const t of [1000, 2000]) {
      await db.insertInto('review_costs').values({ id: uuidv7(), tenant_id: TU, repository_id: REPO, change_request_id: null, revision_id: uuidv7(), input_tokens: t, output_tokens: 0, total_tokens: t, cost_usd: 0.01, candidate_count: 1, published_inline: 0, scopes_total: 1, scopes_complete: 1, created_at: new Date() }).execute();
    }
  });

  afterAll(async () => {
    await stop?.();
  });

  it('resolvePlan:无 subscription → free(seed)+ **reject 兜底**(用完即停,不降档续烧)', async () => {
    const r = await resolvePlan(db, TENANT);
    expect(r.plan.key).toBe('free');
    expect(r.plan.modelTier).toBe('cheap');
    expect(r.overageAction).toBe('reject');
  });

  it('resolvePlan:active subscription → 对应 plan + overage_policy', async () => {
    const pro = await db.selectFrom('plans').select('id').where('key', '=', 'pro').executeTakeFirstOrThrow();
    await db.insertInto('subscriptions').values({ id: uuidv7(), tenant_id: TENANT, plan_id: pro.id, status: 'active', overage_policy: 'reject', current_period_start: new Date(), current_period_end: null, created_at: new Date(), updated_at: new Date() }).execute();
    const r = await resolvePlan(db, TENANT);
    expect(r.plan.key).toBe('pro');
    expect(r.plan.modelTier).toBe('balanced');
    expect(r.overageAction).toBe('reject');
  });

  it('periodUsage 聚合本月 review_costs;BYOK 行 token 不计配额、次数仍计(0035)', async () => {
    const u = await periodUsage(db, TU, currentMonthStart());
    expect(u.reviews).toBe(2);
    expect(u.tokens).toBe(3000);
    expect(u.costUsd).toBeCloseTo(0.02, 6);

    await db.insertInto('review_costs').values({ id: uuidv7(), tenant_id: TU, repository_id: REPO, change_request_id: null, revision_id: uuidv7(), input_tokens: 9000, output_tokens: 0, total_tokens: 9000, cost_usd: 0.09, candidate_count: 1, published_inline: 0, scopes_total: 1, scopes_complete: 1, model_source: 'byok', created_at: new Date() }).execute();
    const u2 = await periodUsage(db, TU, currentMonthStart());
    expect(u2.reviews).toBe(3); // reviews always count
    expect(u2.tokens).toBe(3000); // BYOK tokens excluded
    expect(u2.costUsd).toBeCloseTo(0.02, 6);
  });

  it('checkQuota:达上限即 over(null=无限)', () => {
    const counted = { ...FREE_PLAN, monthlyCostCapUsd: null, monthlyReviewQuota: 50, monthlyTokenQuota: 5_000_000 };
    expect(checkQuota(counted, { costUsd: 0, reviews: 10, tokens: 0 }, 'degrade').withinQuota).toBe(true);
    const over = checkQuota(counted, { costUsd: 0, reviews: 50, tokens: 0 }, 'degrade');
    expect(over.withinQuota).toBe(false);
    expect(over.reason).toBe('review_quota_exceeded');
    const unlimited = checkQuota({ ...counted, monthlyReviewQuota: null, monthlyTokenQuota: null }, { costUsd: 9e9, reviews: 9999, tokens: 9e12 }, 'degrade');
    expect(unlimited.withinQuota).toBe(true);
  });

  it('checkQuota:**费用上限是主闸** —— free 用满 $3 即 over,且报因优先说钱(0046)', () => {
    expect(FREE_PLAN.monthlyCostCapUsd).toBe(3);
    expect(FREE_PLAN.monthlyReviewQuota).toBeNull();
    expect(checkQuota(FREE_PLAN, { costUsd: 2.99, reviews: 999, tokens: 9e9 }, 'reject').withinQuota).toBe(true);
    const over = checkQuota(FREE_PLAN, { costUsd: 3, reviews: 1, tokens: 0 }, 'reject');
    expect(over.withinQuota).toBe(false);
    expect(over.reason).toBe('cost_quota_exceeded');

    // Cost and count both exceeded: the reported reason is cost.
    const both = checkQuota({ ...FREE_PLAN, monthlyReviewQuota: 1 }, { costUsd: 5, reviews: 9, tokens: 0 }, 'reject');
    expect(both.reason).toBe('cost_quota_exceeded');

    expect(checkQuota({ ...FREE_PLAN, monthlyCostCapUsd: null }, { costUsd: 1e6, reviews: 0, tokens: 0 }, 'reject').withinQuota).toBe(true);
  });

  it('decideForReview:费用上限用尽 + reject → 阻断,理由为 cost_quota_exceeded(0046)', async () => {
    const T = uuidv7();
    await db.insertInto('tenants').values({ id: T, name: 'costcap', region: null, created_at: new Date() }).execute();
    const planId = uuidv7();
    await db
      .insertInto('plans')
      .values({ id: planId, key: 'cheapcap', name: 'CheapCap', model_tier: 'cheap', monthly_cost_cap_usd: '0.5', monthly_review_quota: null, monthly_token_quota: null, max_concurrency: 1, features: JSON.stringify({}) as unknown as Record<string, unknown>, active: true, created_at: new Date() })
      .execute();
    await db
      .insertInto('subscriptions')
      .values({ id: uuidv7(), tenant_id: T, plan_id: planId, status: 'active', overage_policy: 'reject', current_period_start: new Date(), current_period_end: null, created_at: new Date(), updated_at: new Date() })
      .execute();

    expect((await decideForReview(db, T)).block).toBe(false);

    await db.insertInto('review_costs').values({ id: uuidv7(), tenant_id: T, repository_id: REPO, change_request_id: null, revision_id: uuidv7(), input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0.6, candidate_count: 1, published_inline: 0, scopes_total: 1, scopes_complete: 1, created_at: new Date() }).execute();
    const d = await decideForReview(db, T);
    expect(d.block).toBe(true);
    expect(d.reason).toBe('cost_quota_exceeded');
    expect(d.plan.monthlyCostCapUsd).toBe(0.5);
  });

  it('单日熔断按计划取上限(0049):plan 值压过 env;0=显式不限;null=继承 env', async () => {
    const T = uuidv7();
    await db.insertInto('tenants').values({ id: T, name: 'dailycap', region: null, created_at: new Date() }).execute();
    const planId = uuidv7();
    // Monthly uncapped, so only the daily cap matters.
    await db
      .insertInto('plans')
      .values({ id: planId, key: 'dailytest', name: 'DailyTest', model_tier: 'cheap', monthly_cost_cap_usd: null, daily_cost_cap_usd: null, monthly_review_quota: null, monthly_token_quota: null, max_concurrency: 1, features: JSON.stringify({}) as unknown as Record<string, unknown>, active: true, created_at: new Date() })
      .execute();
    await db
      .insertInto('subscriptions')
      .values({ id: uuidv7(), tenant_id: T, plan_id: planId, status: 'active', overage_policy: 'reject', current_period_start: new Date(), current_period_end: null, created_at: new Date(), updated_at: new Date() })
      .execute();
    // $26 spent today, above the env cap of $20.
    await db.insertInto('review_costs').values({ id: uuidv7(), tenant_id: T, repository_id: REPO, change_request_id: null, revision_id: uuidv7(), input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 26, candidate_count: 1, published_inline: 0, scopes_total: 1, scopes_complete: 1, created_at: new Date() }).execute();

    // Plan null -> inherits env $20 -> tripped.
    const inherited = await decideForReview(db, T, Date.now(), { envDailyCapUsd: 20 });
    expect(inherited.daily.tripped).toBe(true);
    expect(inherited.block).toBe(true);
    expect(inherited.reason).toBe('daily_cost_cap_exceeded');

    // Plan 0 = uncapped, overrides env.
    await db.updateTable('plans').set({ daily_cost_cap_usd: 0 }).where('id', '=', planId).execute();
    const unlimited = await decideForReview(db, T, Date.now(), { envDailyCapUsd: 20 });
    expect(unlimited.daily.tripped).toBe(false);
    expect(unlimited.block).toBe(false);

    // A higher plan value wins over env.
    await db.updateTable('plans').set({ daily_cost_cap_usd: 100 }).where('id', '=', planId).execute();
    expect((await decideForReview(db, T, Date.now(), { envDailyCapUsd: 20 })).daily.tripped).toBe(false);
    await db.updateTable('plans').set({ daily_cost_cap_usd: 10 }).where('id', '=', planId).execute();
    expect((await decideForReview(db, T, Date.now(), { envDailyCapUsd: 999 })).daily.tripped).toBe(true);

    // No env and plan null -> breaker disabled.
    await db.updateTable('plans').set({ daily_cost_cap_usd: null }).where('id', '=', planId).execute();
    expect((await decideForReview(db, T)).daily.tripped).toBe(false);
  });

  it('seed 的 internal 计划:日线为 0(不限),不受全局 DAILY_COST_CAP_USD 约束(0049)', async () => {
    const row = await db.selectFrom('plans').select('daily_cost_cap_usd').where('key', '=', 'internal').executeTakeFirstOrThrow();
    expect(Number(row.daily_cost_cap_usd)).toBe(0);
  });

  it('decideForReview:超额 + degrade → cheap 不阻断;reject → 阻断', async () => {
    // quota=1 plan; TU already has 2 review_costs rows this month -> over quota.
    const planId = uuidv7();
    await db
      .insertInto('plans')
      .values({ id: planId, key: 'tiny', name: 'Tiny', model_tier: 'quality', monthly_cost_cap_usd: null, monthly_review_quota: 1, monthly_token_quota: null, max_concurrency: 1, features: JSON.stringify({}) as unknown as Record<string, unknown>, active: true, created_at: new Date() })
      .execute();
    await db
      .insertInto('subscriptions')
      .values({ id: uuidv7(), tenant_id: TU, plan_id: planId, status: 'active', overage_policy: 'degrade', current_period_start: new Date(), current_period_end: null, created_at: new Date(), updated_at: new Date() })
      .execute();
    const d1 = await decideForReview(db, TU);
    expect(d1.withinQuota).toBe(false);
    expect(d1.effectiveTier).toBe('cheap');
    expect(d1.block).toBe(false);

    await db.updateTable('subscriptions').set({ overage_policy: 'reject' }).where('tenant_id', '=', TU).execute();
    const d2 = await decideForReview(db, TU);
    expect(d2.block).toBe(true);
    expect(d2.reason).toBe('review_quota_exceeded');
  });

  describe('模型注册表(0046;0070:档位允许集删掉,默认模型来自注册表本身)', () => {
    const T = uuidv7();
    const CHEAP = uuidv7();
    const PRICEY = uuidv7();
    const PLAN = uuidv7();
    let subId: string;

    beforeAll(async () => {
      await db.insertInto('tenants').values({ id: T, name: 'modelpick', region: null, created_at: new Date() }).execute();
      await db.insertInto('models').values([
        { id: CHEAP, provider: 'openai', model_id: 'm-cheap', metadata_source: null, metadata_provider: null, metadata_model_id: null, active: true, sort: 10, created_at: new Date() },
        { id: PRICEY, provider: 'openai', model_id: 'm-pricey', metadata_source: 'models.dev', metadata_provider: 'openai', metadata_model_id: 'gpt-4o', active: true, sort: 20, created_at: new Date() },
      ]).execute();
      await db.insertInto('plans').values({ id: PLAN, key: 'picky', name: 'Picky', model_tier: 'balanced', monthly_cost_cap_usd: 10, monthly_review_quota: null, monthly_token_quota: null, max_concurrency: 1, features: JSON.stringify({}) as unknown as Record<string, unknown>, active: true, created_at: new Date() }).execute();
      subId = uuidv7();
      await db.insertInto('subscriptions').values({ id: subId, tenant_id: T, plan_id: PLAN, status: 'active', overage_policy: 'reject', current_period_start: new Date(), current_period_end: null, created_at: new Date(), updated_at: new Date() }).execute();
    });

    it('默认模型 = 注册表 sort 第一个;库里遗留的租户选择不再生效(2026-08-02 选择权收回平台)', async () => {
      const eff = await resolveDefaultModel(db);
      expect(eff.allowed.map((m) => m.modelId)).toEqual(['m-cheap', 'm-pricey']);
      expect(eff.model?.modelId).toBe('m-cheap');
      expect((await decideForReview(db, T)).effectiveModel?.modelId).toBe('m-cheap');
    });

    it('停用即下架:退出候选集,也不再被选为默认(active=false)', async () => {
      await db.updateTable('models').set({ active: false }).where('id', '=', CHEAP).execute();
      const eff = await resolveDefaultModel(db);
      expect(eff.allowed.map((m) => m.modelId)).toEqual(['m-pricey']);
      expect(eff.model?.modelId).toBe('m-pricey'); // next by sort, not the inactive one
      await db.updateTable('models').set({ active: true }).where('id', '=', CHEAP).execute();
    });

    it('注册表全空 → model=null(调用方回退 env/tier,迁移期零行为变化)', async () => {
      await db.updateTable('models').set({ active: false }).execute();
      const eff = await resolveDefaultModel(db);
      expect(eff.allowed).toEqual([]);
      expect(eff.model).toBeNull();
      expect((await decideForReview(db, T)).effectiveModel).toBeNull();
      await db.updateTable('models').set({ active: true }).execute();
    });

    it('超额降档时忽略档位模型(degraded 置位,由调用方退回平台最省档)', async () => {
      await db.updateTable('subscriptions').set({ overage_policy: 'degrade' }).where('id', '=', subId).execute();
      await db.insertInto('review_costs').values({ id: uuidv7(), tenant_id: T, repository_id: REPO, change_request_id: null, revision_id: uuidv7(), input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 99, candidate_count: 1, published_inline: 0, scopes_total: 1, scopes_complete: 1, created_at: new Date() }).execute();
      const d = await decideForReview(db, T);
      expect(d.withinQuota).toBe(false);
      expect(d.degraded).toBe(true);
      expect(d.effectiveTier).toBe('cheap');
      expect(d.block).toBe(false);
    });
  });

  it('provisionTenant:新建 tenant+host+installation+owner+free subscription;幂等', async () => {
    const input = {
      provider: 'github',
      host: { baseUrl: 'https://github.com', apiUrl: 'https://api.github.com', isSaas: true },
      installationNativeId: '12345',
      accountLogin: 'newco',
      installer: { providerUserId: '99', login: 'alice', email: 'alice@newco.io' },
    };
    const r1 = await provisionTenant(db, input);
    expect(r1.created).toBe(true);
    const m = await db.selectFrom('memberships').select('role').where('tenant_id', '=', r1.tenantId).where('user_id', '=', r1.userId).executeTakeFirst();
    expect(m?.role).toBe('owner');
    const sub = await db.selectFrom('subscriptions').innerJoin('plans', 'plans.id', 'subscriptions.plan_id').select(['plans.key', 'subscriptions.overage_policy']).where('subscriptions.tenant_id', '=', r1.tenantId).executeTakeFirst();
    expect(sub?.key).toBe('free');
    // Out of quota = stop, never silently degrade and keep spending.
    expect(sub?.overage_policy).toBe('reject');
    const idn = await db.selectFrom('user_identities').select('login').where('kind', '=', 'provider').where('subject', '=', '99').executeTakeFirst();
    expect(idn?.login).toBe('alice');

    const r2 = await provisionTenant(db, input);
    expect(r2.created).toBe(false);
    expect(r2.tenantId).toBe(r1.tenantId);
  });
  // Public-repo discount: cost, tokens and count are discounted together; unknown visibility counts as private;
  // BYOK combined with public must not go negative or double-discount.
  describe('公开仓库计费(0072)', () => {
    const T = uuidv7();
    const PUB = uuidv7();
    const PRIV = uuidv7();
    const UNK = uuidv7();

    beforeAll(async () => {
      await db.insertInto('tenants').values({ id: T, name: 'pubrepo', region: null, created_at: new Date() }).execute();
      const host = uuidv7();
      const inst = uuidv7();
      await db.insertInto('provider_hosts').values({ id: host, tenant_id: T, provider: 'github', base_url: 'https://github.com', api_url: 'https://api.github.com', is_saas: true, created_at: new Date() }).execute();
      await db.insertInto('installations').values({ id: inst, tenant_id: T, provider_host_id: host, native_id: '900', account_login: 'pub', status: 'active', created_at: new Date() }).execute();
      for (const [id, vis, nat] of [[PUB, 'public', '901'], [PRIV, 'private', '902'], [UNK, null, '903']] as const) {
        await db.insertInto('repositories').values({ id, tenant_id: T, provider_host_id: host, installation_id: inst, native_id: nat, namespace: 'pub', name: nat, clone_url: 'x', default_branch: 'main', visibility: vis, created_at: new Date() }).execute();
      }
      // One row per repo: $1 / 1000 tokens / 1 review.
      for (const [repo, vis] of [[PUB, 'public'], [PRIV, 'private'], [UNK, null]] as const) {
        await db.insertInto('review_costs').values({
          id: uuidv7(), tenant_id: T, repository_id: repo, change_request_id: null, revision_id: uuidv7(),
          input_tokens: 1000, output_tokens: 0, total_tokens: 1000, cost_usd: 1,
          candidate_count: 1, published_inline: 0, scopes_total: 1, scopes_complete: 1,
          repo_visibility: vis, created_at: new Date(),
        }).execute();
      }
    });

    it('full:公开仓与其它一样计(默认,零行为变化)', async () => {
      const u = await periodUsage(db, T, currentMonthStart(), 'full');
      expect(u.costUsd).toBeCloseTo(3, 6);
      expect(u.tokens).toBe(3000);
      expect(u.reviews).toBe(3);
    });

    it('x10:公开仓那一行按 1/10 计 —— 钱、token、次数**一起**打折', async () => {
      const u = await periodUsage(db, T, currentMonthStart(), 'x10');
      // private 1 + unknown 1 + public 0.1
      expect(u.costUsd).toBeCloseTo(2.1, 6);
      expect(u.tokens).toBeCloseTo(2100, 6);
      expect(u.reviews).toBeCloseTo(2.1, 6);
    });

    it('free:公开仓完全不计', async () => {
      const u = await periodUsage(db, T, currentMonthStart(), 'free');
      expect(u.costUsd).toBeCloseTo(2, 6);
      expect(u.tokens).toBe(2000);
      expect(u.reviews).toBeCloseTo(2, 6);
    });

    it('可见性未知按私有算(折扣是给钱松绑的,拿不准时不该松)', async () => {
      const free = await periodUsage(db, T, currentMonthStart(), 'free');
      expect(free.reviews).toBeCloseTo(2, 6);
    });

    it('BYOK 与公开仓叠加:token/成本已由 BYOK 归零,不再二次打折', async () => {
      await db.insertInto('review_costs').values({
        id: uuidv7(), tenant_id: T, repository_id: PUB, change_request_id: null, revision_id: uuidv7(),
        input_tokens: 5000, output_tokens: 0, total_tokens: 5000, cost_usd: 9,
        candidate_count: 1, published_inline: 0, scopes_total: 1, scopes_complete: 1,
        model_source: 'byok', repo_visibility: 'public', created_at: new Date(),
      }).execute();
      const u = await periodUsage(db, T, currentMonthStart(), 'x10');
      // Cost/tokens as in x10 (BYOK rows contribute 0); count gains 0.1 for the public review.
      expect(u.costUsd).toBeCloseTo(2.1, 6);
      expect(u.tokens).toBeCloseTo(2100, 6);
      expect(u.reviews).toBeCloseTo(2.2, 6);
    });

    it('resolvePublicRepoBilling:DB > env > 默认;非法值当没设', async () => {
      expect(await resolvePublicRepoBilling(db)).toBe('full');
      await db.insertInto('platform_settings').values({ key: 'billing.public_repo', value: 'x10', updated_at: new Date(), updated_by: null }).execute();
      expect(await resolvePublicRepoBilling(db)).toBe('x10');
      await db.updateTable('platform_settings').set({ value: 'nonsense' }).where('key', '=', 'billing.public_repo').execute();
      expect(await resolvePublicRepoBilling(db)).toBe('full'); // invalid value falls back
      await db.deleteFrom('platform_settings').where('key', '=', 'billing.public_repo').execute();
    });
  });
});
