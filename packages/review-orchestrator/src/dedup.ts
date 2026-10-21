/**
 * Candidate dedup strategies: token-Dice (default) and embedding are incremental and keep the
 * dig→verify pipeline overlapping; LLM clustering is batch and needs a barrier.
 */
import { runAgentInvocation, Type, type AgentBudget, type Model, type Static, type StreamFn } from '@reviewbot/agent-pi';

export interface DedupCandidate {
  id: string;
  path: string;
  claim: string;
}

/**
 * `incremental` judges each streamed candidate against kept survivors (pipeline-friendly);
 * `batch` needs every candidate at once (introduces a barrier).
 */
export type DedupStrategy =
  | {
      kind: 'incremental';
      /** true = duplicate of a survivor; skip verify. */
      isDuplicate: (candidate: DedupCandidate, survivors: DedupCandidate[]) => boolean | Promise<boolean>;
    }
  | {
      kind: 'batch';
      /** Returns the ids to suppress. */
      dedupe: (candidates: DedupCandidate[]) => Promise<Set<string>>;
    };

/*
 * CJK has no word separators, so the Latin split yields no tokens. Approximate with character n-grams:
 * Han/Hangul one char per token (≈ one morpheme); kana as 2-grams since single kana are syllables and
 * would make unrelated claims look similar.
 */
const HAN_RUN = /[㐀-䶿一-鿿豈-﫿가-힯]+/g;
const KANA_RUN = /[぀-ヿ]+/g;

/** Latin words longer than 2 chars plus CJK n-grams, in one set. */
function claimTokens(claim: string): Set<string> {
  const lower = claim.toLowerCase();
  const tokens = new Set<string>();
  for (const w of lower.split(/[^a-z0-9_.]+/)) if (w.length > 2) tokens.add(w);
  for (const run of lower.match(HAN_RUN) ?? []) for (const ch of run) tokens.add(ch);
  for (const run of lower.match(KANA_RUN) ?? []) {
    if (run.length === 1) tokens.add(run);
    else for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/** Shared by pre- and post-verify dedup so both judge alike. */
export const NEAR_DUP_THRESHOLD = 0.62;

export type ClaimSimilarityFn = (a: string, b: string) => number;

/** Token-Dice similarity (0..1). */
export const claimSimilarity: ClaimSimilarityFn = (a, b) => {
  const ta = claimTokens(a);
  const tb = claimTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter += 1;
  return (2 * inter) / (ta.size + tb.size);
};

/** Zero vectors return 0. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Post-verify near-duplicate folding within one review: two findings in the same file are one defect
 * when they anchor the same line or their claims are similar; the lower rank is suppressed.
 */
export function nearDuplicateIds(
  items: { id: string; path: string; claim: string; rank: number; line?: number }[],
  threshold = NEAR_DUP_THRESHOLD,
  similarity: ClaimSimilarityFn = claimSimilarity,
): Set<string> {
  const dup = new Set<string>();
  const byFile = new Map<string, typeof items>();
  for (const s of items) {
    const arr = byFile.get(s.path);
    if (arr) arr.push(s);
    else byFile.set(s.path, [s]);
  }
  for (const group of byFile.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        if (dup.has(a.id) || dup.has(b.id)) continue;
        const sameLine = a.line !== undefined && a.line === b.line;
        if (sameLine || similarity(a.claim, b.claim) >= threshold) {
          dup.add((a.rank >= b.rank ? b : a).id);
        }
      }
    }
  }
  return dup;
}

/**
 * Display-only merge of rows describing the same defect across rounds (same path + similar claim);
 * keeps the first in input order. Gate counts must keep using the unmerged rows.
 */
export function mergeSameDefect<T extends { path?: string; claim: string }>(
  items: readonly T[],
  threshold = NEAR_DUP_THRESHOLD,
  similarity: ClaimSimilarityFn = claimSimilarity,
): { kept: T[]; merged: number } {
  const kept: T[] = [];
  for (const item of items) {
    const dup = kept.some((k) => k.path === item.path && similarity(k.claim, item.claim) >= threshold);
    if (!dup) kept.push(item);
  }
  return { kept, merged: items.length - kept.length };
}

export function tokenDiceStrategy(similarity: ClaimSimilarityFn = claimSimilarity, threshold = NEAR_DUP_THRESHOLD): DedupStrategy {
  return {
    kind: 'incremental',
    isDuplicate: (c, survivors) => survivors.some((s) => s.path === c.path && similarity(s.claim, c.claim) >= threshold),
  };
}

export interface EmbeddingDeduperOptions {
  /** Caller must ensure the endpoint is on the ZDR allowlist, like LLM endpoints. */
  embed: (text: string) => Promise<number[]>;
  /** Cosine threshold; default 0.86 (typical paraphrase range). */
  threshold?: number;
}

/** Vectors are cached by candidate id; only same-file survivors are compared. */
export function createEmbeddingDeduper(opts: EmbeddingDeduperOptions): DedupStrategy {
  const threshold = opts.threshold ?? 0.86;
  const vectors = new Map<string, number[]>();
  return {
    kind: 'incremental',
    isDuplicate: async (c, survivors) => {
      let v = vectors.get(c.id);
      if (!v) {
        v = await opts.embed(c.claim);
        vectors.set(c.id, v);
      }
      for (const s of survivors) {
        if (s.path !== c.path) continue;
        const sv = vectors.get(s.id);
        if (sv && cosineSimilarity(v, sv) >= threshold) return true;
      }
      return false;
    },
  };
}

export interface OpenAICompatibleEmbedOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** OpenAI-compatible `/embeddings` client. Does not check the ZDR allowlist; the caller must. */
export function createOpenAICompatibleEmbed(opts: OpenAICompatibleEmbedOptions): (text: string) => Promise<number[]> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/embeddings`;
  return async (text: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model: opts.model, input: text }),
    });
    if (!res.ok) throw new Error(`embedding 端点返回 ${res.status}`);
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    const v = json.data?.[0]?.embedding;
    if (!v) throw new Error('embedding 响应缺 data[0].embedding');
    return v;
  };
}

const DEDUP_GROUPS_SCHEMA = Type.Object({
  duplicateGroups: Type.Array(
    Type.Object({
      keepId: Type.String(),
      duplicateIds: Type.Array(Type.String()),
    }),
  ),
});

const DEDUP_SYSTEM = [
  'You group candidate code-review findings that describe the SAME underlying defect',
  '(same root cause and same location/behavior), so duplicates can be folded into one.',
  'Be conservative: only group findings you are confident are the same defect. When unsure, keep',
  'them separate — wrongly merging two distinct findings hides a real issue. Only group findings',
  'that share the same file path. For each group pick one keepId and list the rest as duplicateIds.',
].join('\n');

const DEDUP_TASK = 'Group duplicate candidate findings, then call `submit_dedup` with the groups.';

export interface LlmDeduperDeps {
  model: Model<string>;
  streamFn: StreamFn;
  budget: AgentBudget;
}

/** Only ids that exist and are not the group's keepId are suppressed. */
export function createLlmDeduper(deps: LlmDeduperDeps): DedupStrategy {
  return {
    kind: 'batch',
    dedupe: async (candidates) => {
      const suppressed = new Set<string>();
      if (candidates.length < 2) return suppressed;
      const list = candidates.map((c) => `${c.id} | ${c.path} | ${c.claim}`).join('\n');
      const result = await runAgentInvocation({
        systemPrompt: DEDUP_SYSTEM,
        task: `${DEDUP_TASK}\n\nCandidates (id | path | claim):\n${list}`,
        model: deps.model,
        streamFn: deps.streamFn,
        readTools: [],
        finalization: {
          name: 'submit_dedup',
          description: 'Submit duplicate groups (each: keepId + duplicateIds).',
          label: 'Submit dedup',
          schema: DEDUP_GROUPS_SCHEMA,
        },
        budget: deps.budget,
      });
      const fin = result.finalization as Static<typeof DEDUP_GROUPS_SCHEMA> | undefined;
      const validIds = new Set(candidates.map((c) => c.id));
      for (const g of fin?.duplicateGroups ?? []) {
        if (!validIds.has(g.keepId)) continue; // unknown keepId → distrust the whole group
        for (const id of g.duplicateIds) {
          if (id !== g.keepId && validIds.has(id)) suppressed.add(id);
        }
      }
      return suppressed;
    },
  };
}
