import {
  currentMonthStart,
  decideForReview,
  periodUsage,
  resolvePublicRepoBilling,
  startOfUtcDay,
} from '@reviewbot/entitlement';
import { platformSetting } from '@reviewbot/config';
import type { Db } from '@reviewbot/db';
import { createNotification } from '@reviewbot/notifications';
import { gateOptions } from './runtime.js';
import type { ReviewRevisionDeps } from '../review-revision.js';

/** Skips the review (before clone and model calls) when the tenant is over quota. */
export function createReviewQuotaGate(db: Db): NonNullable<ReviewRevisionDeps['quotaGate']> {
  return async (ctx, { runner }) => {
    if (!ctx.payload.tenantId) return { block: false };
    // decideForReview decides both the daily cap (per plan, so it is resolved there) and the monthly quota; this only notifies.
    const g = await decideForReview(db, ctx.payload.tenantId, Date.now(), await gateOptions(db));
    // In GitHub Actions the repository's own key pays, so platform spend caps do not apply; the review count does.
    if (runner === 'actions') return reviewCountGate(db, ctx.payload.tenantId, g);
    // Daily cost cap first: the monthly quota cannot stop a single day from burning through the budget.
    if (g.daily.tripped) {
      // dedupeKey per day: one notification a day.
      await createNotification(db, {
        tenantId: ctx.payload.tenantId,
        kind: 'quota-warning',
        title: '已触发单日成本熔断,review 已暂停',
        body: [
          `今日已消耗 $${g.daily.spentUsd.toFixed(2)},达到上限 $${g.daily.capUsd.toFixed(2)}。`,
          '',
          '在跨过 UTC 零点或调高上限之前,本租户的 review 会被跳过。',
          `若属预期用量,请调高本计划(${g.plan.name})的 daily_cost_cap_usd(设 0 = 不限)或全局 DAILY_COST_CAP_USD;若非预期,请先排查是否有异常触发。`,
        ].join('\n'),
        link: '/usage',
        dedupeKey: `daily-cost-cap:${ctx.payload.tenantId}:${startOfUtcDay().toISOString().slice(0, 10)}`,
      }).catch(() => undefined); // a failed notification must not disable the cap
      return {
        block: true,
        reason: `daily_cost_cap_exceeded(${g.daily.spentUsd.toFixed(2)}/${g.daily.capUsd.toFixed(2)} USD)`,
        reasonCode: 'daily_cost_cap' as const,
      };
    }
    if (g.block) {
      // Cost, token and review quotas have different recovery paths, hence separate kinds.
      const kind: QuotaKind =
        g.reason === 'cost_quota_exceeded' ? 'cost' : g.reason === 'token_quota_exceeded' ? 'token' : 'review';
      await notifyQuotaExhausted(db, ctx.payload.tenantId, g.plan.name, kind);
      const reasonCode = ({ cost: 'cost_quota', token: 'token_quota', review: 'review_quota' } as const)[kind];
      return { block: true, ...(g.reason ? { reason: g.reason } : {}), reasonCode };
    }
    // Warn before the quota runs out so the user has time to upgrade or switch to BYOK.
    const warnAt = Number(await platformSetting(db, 'quota.warn_ratio'));
    if (warnAt > 0 && warnAt < 1) {
      // Same billing basis as the gate; undiscounted numbers would warn public-repo tenants far too early.
      const usage = await periodUsage(
        db,
        ctx.payload.tenantId,
        currentMonthStart(),
        await resolvePublicRepoBilling(db),
      );
      const ratios: number[] = [];
      if (g.plan.monthlyCostCapUsd) ratios.push(usage.costUsd / g.plan.monthlyCostCapUsd);
      if (g.plan.monthlyReviewQuota) ratios.push(usage.reviews / g.plan.monthlyReviewQuota);
      if (g.plan.monthlyTokenQuota) ratios.push(usage.tokens / g.plan.monthlyTokenQuota);
      const peak = ratios.length > 0 ? Math.max(...ratios) : 0;
      if (peak >= warnAt) {
        const period = currentMonthStart().toISOString().slice(0, 7);
        await createNotification(db, {
          tenantId: ctx.payload.tenantId,
          kind: 'quota-warning',
          title: `本周期额度已用 ${Math.round(peak * 100)}%`,
          body: `当前计划:${g.plan.name}。额度用尽后新的 review 会被跳过(不阻断合并)。`,
          link: '/usage',
          dedupeKey: `quota-warn:${ctx.payload.tenantId}:${period}`,
        }).catch(() => undefined);
      }
    }
    return { block: false };
  };
}

type QuotaKind = 'cost' | 'token' | 'review';

/** In-app and email notice, deduplicated per billing period and kind. */
async function notifyQuotaExhausted(db: Db, tenantId: string, planName: string, kind: QuotaKind): Promise<void> {
  const title = { cost: '本周期费用上限已用尽', token: '本周期 token 额度已用尽', review: '本周期 review 额度已用尽' }[kind];
  const advice = {
    cost: '可自带 LLM key(BYOK)绕开平台费用上限,或升级计划 / 等待下个周期。',
    token: '可自带 LLM key(BYOK)绕开平台 token 额度,或升级计划 / 等待下个周期。',
    review: '升级计划或等待下个周期即可恢复。',
  }[kind];
  await createNotification(db, {
    tenantId,
    kind: 'quota-warning',
    title,
    body: [`当前计划:${planName}。本计费周期额度已用尽,新的 review 会被跳过(不阻断合并)。`, '', advice].join('\n'),
    link: '/usage',
    dedupeKey: `quota-exhausted:${tenantId}:${currentMonthStart().toISOString().slice(0, 7)}:${kind}`,
  }).catch(() => undefined);
}

async function reviewCountGate(
  db: Db,
  tenantId: string,
  g: Awaited<ReturnType<typeof decideForReview>>,
): Promise<Awaited<ReturnType<NonNullable<ReviewRevisionDeps['quotaGate']>>>> {
  const quota = g.plan.monthlyReviewQuota;
  if (!quota || g.overageAction !== 'reject') return { block: false };
  const usage = await periodUsage(db, tenantId, currentMonthStart(), await resolvePublicRepoBilling(db));
  if (usage.reviews < quota) return { block: false };
  await notifyQuotaExhausted(db, tenantId, g.plan.name, 'review');
  return { block: true, reason: 'review_quota_exceeded', reasonCode: 'review_quota' };
}
