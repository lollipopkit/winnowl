import type { Db } from '@reviewbot/db';

/**
 * Per-tenant daily cost breaker, the last line against runaway spend within one billing period.
 * Uses actual cost (review_costs), not estimates, so it always overshoots by one review; leave headroom.
 */
export interface DailyCostStatus {
  spentUsd: number;
  /** <= 0 = disabled. */
  capUsd: number;
  tripped: boolean;
}

/** Plan value (including 0 = uncapped) wins over env `DAILY_COST_CAP_USD`; null inherits env. */
export function effectiveDailyCapUsd(planDailyCapUsd: number | null, envCapUsd: number): number {
  return planDailyCapUsd === null ? envCapUsd : planDailyCapUsd;
}

/** Plan value (including 0 = uncapped) wins over env `REVIEW_COST_CAP_USD`; null inherits env. */
export function effectiveReviewCapUsd(planReviewCapUsd: number | null, envCapUsd: number): number {
  return planReviewCapUsd === null ? envCapUsd : planReviewCapUsd;
}

export function startOfUtcDay(now: number = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Counts platform-paid cost only; BYOK spend is the tenant's own. */
export async function dailyCostStatus(db: Db, tenantId: string, capUsd: number, now: number = Date.now()): Promise<DailyCostStatus> {
  if (!(capUsd > 0)) return { spentUsd: 0, capUsd: 0, tripped: false };
  const row = await db
    .selectFrom('review_costs')
    .select((eb) => eb.fn.sum<string>('cost_usd').as('total'))
    .where('tenant_id', '=', tenantId)
    .where('created_at', '>=', startOfUtcDay(now))
    .where((eb) => eb.or([eb('model_source', '=', 'platform'), eb('model_source', 'is', null)]))
    .executeTakeFirst();
  const spentUsd = Number(row?.total ?? 0);
  return { spentUsd, capUsd, tripped: spentUsd >= capUsd };
}
