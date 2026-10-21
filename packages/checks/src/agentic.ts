import {
  runAgentInvocation,
  Type,
  type AgentBudget,
  type AgentTool,
  type Model,
  type Static,
  type StreamFn,
} from '@reviewbot/agent-pi';
import type { CheckResult, CheckStatus } from './types.js';

export type AgenticCheckKind =
  | 'backward-compatibility'
  | 'security-invariant'
  | 'linked-issue-satisfaction'
  | 'custom-policy';

const CHECK_SCHEMA = Type.Object({
  status: Type.String(),
  explanation: Type.String(),
});

const STATUSES = new Set<CheckStatus>(['pass', 'warning', 'fail', 'unknown']);

export interface AgenticCheckDeps {
  model: Model<string>;
  streamFn: StreamFn;
  readTools?: AgentTool[];
  budget?: AgentBudget;
}

export interface AgenticCheckInput {
  kind: AgenticCheckKind;
  /** Natural-language policy (custom-policy) or checkpoint description. */
  policy: string;
  context: string;
  revisionSha: string;
}

/** Returns unknown (never a fake pass) when undecidable or when the status is invalid. */
export async function runAgenticCheck(input: AgenticCheckInput, deps: AgenticCheckDeps): Promise<CheckResult> {
  const result = await runAgentInvocation({
    systemPrompt:
      'You evaluate a pre-merge policy check. Return pass/warning/fail/unknown. Use unknown when you cannot verify from available evidence — never fake a pass.',
    task: `Check kind: ${input.kind}\nPolicy: ${input.policy}\n\nContext:\n${input.context}\n\nCall submit_check.`,
    model: deps.model,
    streamFn: deps.streamFn,
    readTools: deps.readTools ?? [],
    finalization: {
      name: 'submit_check',
      description: 'Submit the check result.',
      label: 'Submit check',
      schema: CHECK_SCHEMA,
    },
    budget: deps.budget ?? { maxTurns: 6, maxToolCalls: 24 },
  });

  if (result.status !== 'complete' || !result.finalization) {
    return { id: input.kind, type: 'agentic', status: 'unknown', evidence: [], explanation: 'check did not finalize', revisionSha: input.revisionSha };
  }
  const c = result.finalization as Static<typeof CHECK_SCHEMA>;
  const status: CheckStatus = STATUSES.has(c.status as CheckStatus) ? (c.status as CheckStatus) : 'unknown';
  return { id: input.kind, type: 'agentic', status, evidence: [], explanation: c.explanation, revisionSha: input.revisionSha };
}
