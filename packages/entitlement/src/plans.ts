import { sql, type Db } from '@reviewbot/db';
import { platformSetting } from '@reviewbot/config';
import { dailyCostStatus, effectiveDailyCapUsd, effectiveReviewCapUsd, type DailyCostStatus } from './circuit.js';
import { resolveDefaultModel, type RegisteredModel } from './models.js';

/** Mirrors agent-pi ModelTier; duplicated to avoid depending on agent-pi. */
export type ModelTier = 'quality' | 'balanced' | 'cheap';
export type OverageAction = 'reject' | 'degrade';
export const OVERAGE_ACTIONS: readonly OverageAction[] = ['reject', 'degrade'];

/** Quota fields: null = unlimited. */
export interface Plan {
  key: string;
  name: string;
  modelTier: ModelTier;
  /** Primary limit: USD per period, null = uncapped. Review cost varies by orders of magnitude, so counts are a poor proxy. */
  monthlyCostCapUsd: number | null;
  /**
   * Daily USD breaker: null = inherit env `DAILY_COST_CAP_USD`, 0 = explicitly uncapped.
   * Per plan so internal tenants are not cut off by the env cap meant for external ones.
   */
  dailyCostCapUsd: number | null;
  /** Per-review USD cap: null = inherit env `REVIEW_COST_CAP_USD`, 0 = explicitly uncapped (see `dailyCostCapUsd`). */
  reviewCostCapUsd: number | null;
  /** Abuse limit only, not a cost control; usually null. */
  monthlyReviewQuota: number | null;
  /** Abuse limit only. */
  monthlyTokenQuota: number | null;
  maxConcurrency: number;
}

/** Fallback when the plans table is not seeded. Count/token quotas are intentionally unset; cost is the limit. */
export const FREE_PLAN: Plan = {
  key: 'free',
  name: 'Free',
  modelTier: 'cheap',
  monthlyCostCapUsd: 3,
  dailyCostCapUsd: null,
  reviewCostCapUsd: null,
  monthlyReviewQuota: null,
  monthlyTokenQuota: null,
  maxConcurrency: 2,
};

function coerceTier(v: string): ModelTier {
  return v === 'quality' || v === 'balanced' || v === 'cheap' ? v : 'balanced';
}

function coerceOverage(v: string): OverageAction {
  return v === 'reject' || v === 'degrade' ? v : 'degrade';
}

interface PlanRow {
  key: string;
  name: string;
  model_tier: string;
  monthly_cost_cap_usd: string | null;
  daily_cost_cap_usd: string | null;
  review_cost_cap_usd: string | null;
  monthly_review_quota: number | null;
  monthly_token_quota: string | null;
  max_concurrency: number;
}

function rowToPlan(row: PlanRow): Plan {
  return {
    key: row.key,
    name: row.name,
    modelTier: coerceTier(row.model_tier),
    monthlyCostCapUsd: row.monthly_cost_cap_usd === null ? null : Number(row.monthly_cost_cap_usd),
    dailyCostCapUsd: row.daily_cost_cap_usd === null ? null : Number(row.daily_cost_cap_usd),
    reviewCostCapUsd: row.review_cost_cap_usd === null ? null : Number(row.review_cost_cap_usd),
    monthlyReviewQuota: row.monthly_review_quota,
    monthlyTokenQuota: row.monthly_token_quota === null ? null : Number(row.monthly_token_quota),
    maxConcurrency: row.max_concurrency,
  };
}

const PLAN_COLS = [
  'key',
  'name',
  'model_tier',
  'monthly_cost_cap_usd',
  'daily_cost_cap_usd',
  'review_cost_cap_usd',
  'monthly_review_quota',
  'monthly_token_quota',
  'max_concurrency',
] as const;

export interface ResolvedPlan {
  plan: Plan;
  overageAction: OverageAction;
}

/** Active subscription's plan, else the seeded free plan, else FREE_PLAN. */
export async function resolvePlan(db: Db, tenantId: string): Promise<ResolvedPlan> {
  const sub = await db
    .selectFrom('subscriptions')
    .innerJoin('plans', 'plans.id', 'subscriptions.plan_id')
    .select([
      'plans.key',
      'plans.name',
      'plans.model_tier',
      'plans.monthly_cost_cap_usd',
      'plans.daily_cost_cap_usd',
      'plans.review_cost_cap_usd',
      'plans.monthly_review_quota',
      'plans.monthly_token_quota',
      'plans.max_concurrency',
      'subscriptions.overage_policy',
    ])
    .where('subscriptions.tenant_id', '=', tenantId)
    .where('subscriptions.status', '=', 'active')
    .executeTakeFirst();
  if (sub) return { plan: rowToPlan(sub), overageAction: coerceOverage(sub.overage_policy) };

  const free = await db
    .selectFrom('plans')
    .select(PLAN_COLS)
    .where('key', '=', 'free')
    .where('active', '=', true)
    .executeTakeFirst();
  // Without a subscription, reject rather than degrade: degrading keeps accruing cost and silently worsens results.
  return { plan: free ? rowToPlan(free) : FREE_PLAN, overageAction: 'reject' };
}

/** Changes the active subscription's policy; false when the tenant has none (it then always rejects). */
export async function setOveragePolicy(db: Db, tenantId: string, action: OverageAction): Promise<boolean> {
  const res = await db
    .updateTable('subscriptions')
    .set({ overage_policy: action, updated_at: new Date() })
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export interface Usage {
  /** Platform-paid USD; excludes BYOK. */
  costUsd: number;
  reviews: number;
  tokens: number;
}

export function currentMonthStart(now: number = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Billing for public repositories: `full`, `x10` (counted at 1/10), or `free`. */
export type PublicRepoBilling = 'full' | 'x10' | 'free';

/** `free` = 0, handled by a SQL case branch rather than division. */
const PUBLIC_REPO_DIVISOR: Record<PublicRepoBilling, number> = { full: 1, x10: 10, free: 0 };

/**
 * Usage since `since`, with two discounts:
 * - BYOK: tokens and cost excluded (tenant pays); review count still counted.
 * - Public repos: all three discounted per platform setting; null visibility counts as private.
 * Neither applies to the daily breaker or the per-review cap, which guard real spend.
 */
export async function periodUsage(
  db: Db,
  tenantId: string,
  since: Date,
  publicRepoBilling: PublicRepoBilling = 'full',
): Promise<Usage> {
  const divisor = PUBLIC_REPO_DIVISOR[publicRepoBilling];
  const factor = divisor === 0 ? 0 : 1 / divisor;
  // `::numeric` is required: otherwise `else 1` types the case as integer and 0.1 fails to parse.
  const factorSql = sql<string>`${factor}::numeric`;
  const row = await db
    .selectFrom('review_costs')
    .select(() => [
      sql<string>`sum(case when repo_visibility = 'public' then ${factorSql} else 1 end)`.as('reviews'),
      sql<string>`sum(case
          when model_source = 'byok' then 0
          when repo_visibility = 'public' then total_tokens * ${factorSql}
          else total_tokens end)`.as('tokens'),
      sql<string>`sum(case
          when model_source = 'byok' then 0
          when repo_visibility = 'public' then cost_usd * ${factorSql}
          else cost_usd end)`.as('cost'),
    ])
    .where('tenant_id', '=', tenantId)
    .where('created_at', '>=', since)
    .executeTakeFirstOrThrow();
  return {
    costUsd: row.cost === null ? 0 : Number(row.cost),
    reviews: row.reviews === null ? 0 : Number(row.reviews),
    tokens: row.tokens === null ? 0 : Number(row.tokens),
  };
}

/**
 * DB > env > default. Shared by the gate, warnings and usage page so they agree.
 * Not cached so operator changes apply immediately; a DB error falls back to env/default rather than blocking reviews.
 */
export async function resolvePublicRepoBilling(db: Db): Promise<PublicRepoBilling> {
  const v = await platformSetting(db, 'billing.public_repo');
  return v === 'x10' || v === 'free' ? v : 'full';
}

export interface QuotaDecision {
  withinQuota: boolean;
  overageAction: OverageAction;
  reason?: string;
}

/** Over quota if any limit trips; cost is checked first so it is the reported reason. */
export function checkQuota(plan: Plan, usage: Usage, overageAction: OverageAction): QuotaDecision {
  const overCost = plan.monthlyCostCapUsd !== null && usage.costUsd >= plan.monthlyCostCapUsd;
  const overReviews = plan.monthlyReviewQuota !== null && usage.reviews >= plan.monthlyReviewQuota;
  const overTokens = plan.monthlyTokenQuota !== null && usage.tokens >= plan.monthlyTokenQuota;
  if (!overCost && !overReviews && !overTokens) return { withinQuota: true, overageAction };
  const reason = overCost ? 'cost_quota_exceeded' : overReviews ? 'review_quota_exceeded' : 'token_quota_exceeded';
  return { withinQuota: false, overageAction, reason };
}

export interface ReviewGate {
  plan: Plan;
  withinQuota: boolean;
  overageAction: OverageAction;
  /** Per-review cap: plan overrides env; 0 = uncapped. */
  reviewCostCapUsd: number;
  /** cheap when over quota with degrade, else plan.modelTier. */
  effectiveTier: ModelTier;
  block: boolean;
  reason?: string;
  /** Model for stages without a configured list; null = empty registry, fall back to env/tier. */
  effectiveModel: RegisteredModel | null;
  allowedModels: RegisteredModel[];
  /** When true, ignore effectiveModel and use the cheapest tier. */
  degraded: boolean;
  /** `capUsd <= 0` = disabled; when tripped, block is always true. */
  daily: DailyCostStatus;
}

/** Single decision shared by the review handler (blocking) and buildEnv (model). The daily breaker is checked before monthly quota. */
export async function decideForReview(
  db: Db,
  tenantId: string,
  now: number = Date.now(),
  options: { envDailyCapUsd?: number; envReviewCapUsd?: number; publicRepoBilling?: PublicRepoBilling } = {},
): Promise<ReviewGate> {
  const { plan, overageAction } = await resolvePlan(db, tenantId);
  const dailyCap = effectiveDailyCapUsd(plan.dailyCostCapUsd, options.envDailyCapUsd ?? 0);
  // Not discounted (see periodUsage): it guards real spend.
  const daily = await dailyCostStatus(db, tenantId, dailyCap, now);
  const usage = await periodUsage(db, tenantId, currentMonthStart(now), options.publicRepoBilling ?? 'full');
  const q = checkQuota(plan, usage, overageAction);
  const over = !q.withinQuota;
  const degraded = over && overageAction === 'degrade';
  const { model, allowed } = await resolveDefaultModel(db);
  const reason = daily.tripped ? 'daily_cost_cap_exceeded' : q.reason;
  return {
    plan,
    reviewCostCapUsd: effectiveReviewCapUsd(plan.reviewCostCapUsd, options.envReviewCapUsd ?? 0),
    withinQuota: q.withinQuota,
    overageAction,
    effectiveTier: degraded ? 'cheap' : plan.modelTier,
    effectiveModel: model,
    allowedModels: allowed,
    degraded,
    daily,
    block: daily.tripped || (over && overageAction === 'reject'),
    ...(reason ? { reason } : {}),
  };
}
