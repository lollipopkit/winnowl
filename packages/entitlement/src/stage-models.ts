import type { Db } from '@reviewbot/db';
import type { RegisteredModel } from './models.js';
import { REVIEW_STAGES, isStageStrategy, type ReviewStage, type StageStrategy } from '@reviewbot/domain';

/** DB side of per-stage model selection; the algorithm lives in `@reviewbot/domain/stage-models`. */
export type { ReviewStage, StageStrategy } from '@reviewbot/domain';

export interface StageModelPlan {
  stage: ReviewStage;
  strategy: StageStrategy;
  /** Sorted by sort; empty = the stage uses the plan's default model. */
  models: RegisteredModel[];
}

interface StageRow {
  stage: string;
  model_id: string;
  sort: number;
}

/**
 * Stage lists are intersected with `allowed` so a model removed from the plan stops running;
 * an empty intersection falls back to the default model.
 */
export async function loadStageModelPlans(db: Db, planId: string, allowed: readonly RegisteredModel[]): Promise<StageModelPlan[]> {
  const [rows, policies] = await Promise.all([
    db.selectFrom('plan_stage_models').select(['stage', 'model_id', 'sort']).where('plan_id', '=', planId).orderBy('sort').orderBy('model_id').execute() as Promise<StageRow[]>,
    db.selectFrom('plan_stage_policies').select(['stage', 'strategy']).where('plan_id', '=', planId).execute(),
  ]);
  const byId = new Map(allowed.map((m) => [m.id, m]));
  const strategyOf = new Map(policies.map((p) => [p.stage, p.strategy]));
  return REVIEW_STAGES.map((stage) => {
    const models = rows
      .filter((r) => r.stage === stage)
      .map((r) => byId.get(r.model_id))
      .filter((m): m is RegisteredModel => m !== undefined && m.active);
    const raw = strategyOf.get(stage);
    return { stage, strategy: raw !== undefined && isStageStrategy(raw) ? raw : 'fill-first', models };
  });
}
