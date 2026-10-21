// Pure per-stage model selection, shared by entitlement (config) and review-runtime (pick) without IO.
export const REVIEW_STAGES = ['map', 'dig', 'synthesis', 'verify', 'refute', 'vlm'] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export function isReviewStage(v: string): v is ReviewStage {
  return (REVIEW_STAGES as readonly string[]).includes(v);
}

/**
 * - `fill-first` (default): always the first model, fall through on failure;
 * - `round-robin`: rotate per work unit (dig per scope, verify per vote);
 * - `random`: pseudo-random seeded by revisionId.
 */
export const STAGE_STRATEGIES = ['fill-first', 'round-robin', 'random'] as const;
export type StageStrategy = (typeof STAGE_STRATEGIES)[number];

export function isStageStrategy(v: string): v is StageStrategy {
  return (STAGE_STRATEGIES as readonly string[]).includes(v);
}

/** 32-bit FNV-1a; deterministic so a retried revision lands on the same model. */
function hash32(seed: string, unitIndex: number): number {
  let h = 0x81_1c_9d_c5;
  const text = `${seed}#${unitIndex}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93) >>> 0;
  }
  return h >>> 0;
}

/**
 * `unitIndex` must be declaration order (dig: scope index; verify: candidate × votes + vote),
 * never completion order, so assignment stays reproducible under concurrency.
 */
export function pickStageModelIndex(count: number, strategy: StageStrategy, unitIndex: number, seed: string): number {
  if (count <= 1) return 0;
  switch (strategy) {
    case 'round-robin': {
      return ((unitIndex % count) + count) % count; // keeps negative indexes in range
    }
    case 'random': {
      return hash32(seed, unitIndex) % count;
    }
    case 'fill-first': {
      return 0;
    }
  }
}

