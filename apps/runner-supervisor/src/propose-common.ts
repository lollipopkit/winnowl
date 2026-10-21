import { assertModelEndpointAllowed, runAgentInvocation, Type, type AgentBudget, type AgentTool, type Model, type Static, type StreamFn, type TSchema } from '@reviewbot/agent-pi';
import { cosineSimilarity, createOpenAICompatibleEmbed } from '@reviewbot/review-orchestrator';

/**
 * Shared skeleton of learning_propose / global_learning_propose / memory_propose: stage runner, findings
 * digest and near-duplicate check. Quota, billing and approval stay in each handler.
 */

export interface ProposeModelSource {
  model: Model<string>;
  streamFn: StreamFn;
}

export interface ProposeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export function newUsage(): ProposeUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

export function addUsage(acc: ProposeUsage, u?: { inputTokens: number; outputTokens: number; totalTokens?: number; costUsd: number }): void {
  if (!u) return;
  acc.inputTokens += u.inputTokens;
  acc.outputTokens += u.outputTokens;
  acc.totalTokens += u.totalTokens ?? u.inputTokens + u.outputTokens;
  acc.costUsd += u.costUsd;
}

export function clamp01(n: number): number {
  return Number.isNaN(n) ? 0 : Math.max(0, Math.min(1, n));
}

export function findingsDigest(findings: { claim: string; category: string; severity: string }[]): string {
  return findings.length > 0 ? findings.map((f) => `- [${f.category}/${f.severity}] ${f.claim}`).join('\n') : '(no findings)';
}

export interface ProposeStageInput<T extends TSchema> {
  source: ProposeModelSource;
  systemPrompt: string;
  task: string;
  /** Stage tools (none for triage/vote; draft gets aggregate search). */
  tools?: AgentTool[];
  finalization: { name: string; description: string; label: string; schema: T };
  budget: AgentBudget;
  /** Usage accumulates here; billing is up to the caller. */
  usage: ProposeUsage;
}

/** Triage/vote budget (no tools). */
export const TRIAGE_BUDGET: AgentBudget = { maxTurns: 2, maxToolCalls: 2 };
/** Draft budget (with search tools). */
export const DRAFT_BUDGET: AgentBudget = { maxTurns: 6, maxToolCalls: 16 };

/** Runs one stage: returns the finalization payload, else null (caller exits early). Usage is always accumulated. */
export async function runProposeStage<T extends TSchema>(input: ProposeStageInput<T>): Promise<Static<T> | null> {
  const result = await runAgentInvocation({
    systemPrompt: input.systemPrompt,
    task: input.task,
    model: input.source.model,
    streamFn: input.source.streamFn,
    readTools: input.tools ?? [],
    finalization: input.finalization,
    budget: input.budget,
  });
  addUsage(input.usage, result.usage);
  if (result.status !== 'complete' || !result.finalization) return null;
  return result.finalization as Static<T>;
}

export type NearDupChecker = (candidate: string, existing: readonly string[]) => Promise<boolean>;

/** Default embedding dedup threshold (cosine; same as review-side createEmbeddingDeduper). */
const EMBED_NEAR_DUP_THRESHOLD = 0.86;
/** Cap on existing entries compared (bounds embedding calls and prompt length). */
const NEAR_DUP_EXISTING_CAP = 100;

const DEDUP_JUDGE_SCHEMA = Type.Object({
  duplicate: Type.Boolean({ description: 'true if the candidate states the same rule/fact as ANY existing item (paraphrase counts).' }),
});

/**
 * Near-duplicate checker from env `LLM_DEDUP`:
 * - `embedding` → OpenAI-compatible /embeddings + cosine (endpoint must pass the ZDR allowlist, fail-closed);
 * - `llm` → one cheap-tier judge (usage billed to the caller);
 * - `token`/unset → no semantic check (token-Dice misses paraphrased proposals).
 * Misconfiguration throws instead of degrading silently.
 */
export function resolveProposeNearDup(
  opts: { cheapSource?: ProposeModelSource; usage: ProposeUsage },
  env: NodeJS.ProcessEnv = process.env,
): NearDupChecker {
  const mode = (env.LLM_DEDUP ?? 'token').trim().toLowerCase();
  if (mode === '' || mode === 'token') return async () => false;

  if (mode === 'embedding') {
    const baseUrl = env.LLM_BASE_URL;
    const apiKey = env.LLM_API_KEY;
    const embedModel = env.LLM_EMBED_MODEL;
    if (!baseUrl || !apiKey || !embedModel) {
      throw new Error('LLM_DEDUP=embedding 需 LLM_BASE_URL + LLM_API_KEY + LLM_EMBED_MODEL(OpenAI 兼容 /embeddings)');
    }
    assertModelEndpointAllowed({ provider: env.LLM_PROVIDER ?? '', baseUrl }, env);
    const t = Number(env.LLM_DEDUP_THRESHOLD);
    const threshold = Number.isFinite(t) && t > 0 ? t : EMBED_NEAR_DUP_THRESHOLD;
    const embed = createOpenAICompatibleEmbed({ baseUrl, apiKey, model: embedModel });
    return async (candidate, existing) => {
      if (existing.length === 0) return false;
      const cv = await embed(candidate);
      for (const e of existing.slice(0, NEAR_DUP_EXISTING_CAP)) {
        if (cosineSimilarity(cv, await embed(e)) >= threshold) return true;
      }
      return false;
    };
  }

  if (mode === 'llm') {
    const source = opts.cheapSource;
    if (!source) throw new Error('LLM_DEDUP=llm 需可用的 cheap 档模型源');
    return async (candidate, existing) => {
      if (existing.length === 0) return false;
      const listed = existing
        .slice(0, NEAR_DUP_EXISTING_CAP)
        .map((e, i) => `${i + 1}. ${e}`)
        .join('\n');
      const verdict = await runProposeStage({
        source,
        systemPrompt:
          'You judge whether a candidate rule is a semantic duplicate of any existing rule (same rule/fact in different words counts as duplicate; related-but-different does not). Call submit_dedup.',
        task: `Candidate:\n${candidate}\n\nExisting:\n${listed}\n\nSubmit duplicate true/false.`,
        finalization: { name: 'submit_dedup', description: 'Submit dedup verdict.', label: 'Submit dedup', schema: DEDUP_JUDGE_SCHEMA },
        budget: TRIAGE_BUDGET,
        usage: opts.usage,
      });
      // Judge failure → treat as not duplicate (better an extra proposal than a dropped candidate).
      return verdict?.duplicate ?? false;
    };
  }

  throw new Error(`未知 LLM_DEDUP="${mode}"(应为 token|embedding|llm)`);
}
