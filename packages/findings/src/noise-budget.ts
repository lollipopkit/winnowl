import type { DemotionReason, PublicationKind } from './types.js';

export interface NoiseItem {
  id: string;
  /** Defects and nits have separate total and per-file quotas. */
  kind: PublicationKind;
  file: string;
  /** Priority for quota allocation (`rankScore`). */
  rank: number;
}

export interface NoiseBudget {
  maxInlineComments: number;
  maxInlinePerFile: number;
  /** Separate inline quota for nits, so nits and defects never crowd each other out. */
  maxInlineNits: number;
}

export interface NoiseResult extends NoiseItem {
  overflow: boolean;
  /** Which limit caused the overflow, since each is tuned by a different setting. */
  overflowReason?: Extract<DemotionReason, 'inline-budget' | 'per-file-budget'>;
}

/**
 * Allocate inline slots by descending rank; confirmed findings over budget overflow to folded, never dropped.
 * Input must already be inline candidates; this only answers whether there is room.
 */
export function applyNoiseBudget(items: NoiseItem[], budget: NoiseBudget): NoiseResult[] {
  const order = [...items].sort((a, b) => b.rank - a.rank);
  const counts = { defect: 0, nit: 0 };
  const perFile = { defect: new Map<string, number>(), nit: new Map<string, number>() };

  const decided = new Map<string, NoiseResult>();
  for (const item of order) {
    const kind = item.kind;
    const max = kind === 'nit' ? budget.maxInlineNits : budget.maxInlineComments;
    const fileCount = perFile[kind].get(item.file) ?? 0;
    if (counts[kind] < max && fileCount < budget.maxInlinePerFile) {
      counts[kind] += 1;
      perFile[kind].set(item.file, fileCount + 1);
      decided.set(item.id, { ...item, overflow: false });
    } else {
      // Report the global quota when both limits are hit: raising the per-file limit would not help.
      const overflowReason = counts[kind] >= max ? 'inline-budget' : 'per-file-budget';
      decided.set(item.id, { ...item, overflow: true, overflowReason });
    }
  }

  return items.map((item) => decided.get(item.id)!);
}
