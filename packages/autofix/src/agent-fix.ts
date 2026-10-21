import {
  runAgentInvocation,
  Type,
  type AgentBudget,
  type AgentTool,
  type Model,
  type Static,
  type StreamFn,
} from '@reviewbot/agent-pi';
import type { FixAgentContext, ProducedFix } from './pipeline.js';
import type { FixKind } from './types.js';

const FIX_SCHEMA = Type.Object({
  patch: Type.String(),
  modifiedFiles: Type.Array(Type.String()),
  residualRisks: Type.Array(Type.String()),
  confidence: Type.Number(),
});

const KIND_GOAL: Record<FixKind, string> = {
  autofix: 'Fix the referenced findings with a minimal, correct patch.',
  'generate-tests': 'Add tests that cover the referenced findings/behaviour.',
  'generate-docs': 'Add or update documentation for the referenced code.',
  'generate-diagram':
    'Add a Markdown document (or update an existing doc) containing a Mermaid diagram that illustrates the referenced code — architecture, control flow, or data flow as most appropriate. Only add documentation; do not change program behaviour.',
  simplify: 'Simplify the referenced code without changing behaviour.',
  'resolve-conflict': 'Resolve merge conflicts in the referenced files.',
  'add-comments': 'Add clarifying comments to the referenced code.',
};

export interface AgentFixProducerDeps {
  model: Model<string>;
  streamFn: StreamFn;
  /** Read-only code exploration tools; default none. */
  readTools?: AgentTool[];
  budget?: AgentBudget;
  context?: string;
  /** Attempts when the model produces no patch or never finalises (default 3). */
  maxAttempts?: number;
}

/** Only produces a patch via the finalise tool; it never writes remotely. */
export function createAgentFixProducer(
  deps: AgentFixProducerDeps,
): (ctx: FixAgentContext) => Promise<ProducedFix> {
  return async (ctx: FixAgentContext): Promise<ProducedFix> => {
    const { plan } = ctx;
    const task = [
      `Goal: ${KIND_GOAL[plan.kind]}`,
      `Finding IDs: ${plan.findingIds.join(', ') || '(none)'}`,
      `Expected files: ${plan.expectedFiles.join(', ') || '(unspecified)'}`,
      `Constraints: ${plan.constraints.join('; ') || '(none)'}`,
      `Public API changes allowed: ${plan.publicApiChangesAllowed}`,
      deps.context ? `Context:\n${deps.context}` : '',
      'Read the referenced files, then call submit_fix with the patch. The patch may be a git unified diff or an OpenAI apply_patch (*** Begin Patch) block — both are accepted.',
      'You MUST call submit_fix with a non-empty patch. Do not finish your turn without submitting a patch that resolves the findings.',
    ]
      .filter(Boolean)
      .join('\n');

    const attempts = Math.max(1, deps.maxAttempts ?? 3);
    let lastStatus = 'none';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await runAgentInvocation({
        systemPrompt:
          'You are an autofix agent. Make the smallest correct change. Never widen public API unless allowed. Report residual risks honestly. Always finish by calling submit_fix with a non-empty patch.',
        task,
        model: deps.model,
        streamFn: deps.streamFn,
        readTools: deps.readTools ?? [],
        finalization: {
          name: 'submit_fix',
          description: 'Submit the generated patch.',
          label: 'Submit fix',
          schema: FIX_SCHEMA,
        },
        budget: deps.budget ?? { maxTurns: 12, maxToolCalls: 60 },
      });
      lastStatus = result.status;
      if (result.status === 'complete' && result.finalization) {
        const fix = result.finalization as Static<typeof FIX_SCHEMA>;
        if (fix.patch.trim()) {
          return {
            patch: fix.patch,
            modifiedFiles: fix.modifiedFiles,
            residualRisks: fix.residualRisks,
            confidence: clamp01(fix.confidence),
          };
        }
      }
      // No patch: retry the same task and rely on sampling variance.
    }
    return {
      patch: '',
      modifiedFiles: [],
      residualRisks: [`fix agent 未产 patch(${attempts} 次尝试;末次 status=${lastStatus})`],
      confidence: 0,
    };
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
