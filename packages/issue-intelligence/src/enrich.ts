import {
  languageInstruction,
  runAgentInvocation,
  Type,
  type AgentBudget,
  type AgentTool,
  type Model,
  type Static,
  type StreamFn,
} from '@reviewbot/agent-pi';
import type { IssueEnrichment } from './types.js';

const ENRICH_SCHEMA = Type.Object({
  duplicateOf: Type.Array(Type.String()),
  relatedIssues: Type.Array(Type.String()),
  relatedChangeRequests: Type.Array(Type.String()),
  relatedCode: Type.Array(Type.Object({ file: Type.String(), symbol: Type.Optional(Type.String()) })),
  suggestedLabels: Type.Array(Type.String()),
  suggestedOwners: Type.Array(Type.String()),
  reproductionQuestions: Type.Array(Type.String()),
  feasibility: Type.String(),
  riskClassification: Type.String(),
});

export interface IssueEnrichDeps {
  model: Model<string>;
  streamFn: StreamFn;
  readTools?: AgentTool[];
  budget?: AgentBudget;
  /** Output language; default `en`. */
  language?: string;
}

const FEASIBILITY = new Set(['clear', 'needs-clarification', 'infeasible']);
const RISK = new Set(['low', 'medium', 'high']);

/** Never applies labels/owners itself; `resolveAutoApply` decides that by policy. */
export async function enrichIssue(
  input: { title: string; body: string },
  deps: IssueEnrichDeps,
): Promise<IssueEnrichment> {
  const result = await runAgentInvocation({
    systemPrompt:
      'You triage a repository issue. Detect duplicates, related work, relevant code, and missing reproduction info. Do not invent issue numbers.' +
      languageInstruction(deps.language, 'reproduction questions, feasibility and risk explanations'),
    task: `Issue: ${input.title}\n\n${input.body}\n\nCall submit_enrichment.`,
    model: deps.model,
    streamFn: deps.streamFn,
    readTools: deps.readTools ?? [],
    finalization: {
      name: 'submit_enrichment',
      description: 'Submit issue enrichment.',
      label: 'Submit enrichment',
      schema: ENRICH_SCHEMA,
    },
    budget: deps.budget ?? { maxTurns: 6, maxToolCalls: 24 },
  });

  if (result.status !== 'complete' || !result.finalization) {
    return {
      duplicateOf: [],
      relatedIssues: [],
      relatedChangeRequests: [],
      relatedCode: [],
      suggestedLabels: [],
      suggestedOwners: [],
      reproductionQuestions: [],
      feasibility: 'needs-clarification',
      riskClassification: 'medium',
    };
  }
  const e = result.finalization as Static<typeof ENRICH_SCHEMA>;
  return {
    duplicateOf: e.duplicateOf,
    relatedIssues: e.relatedIssues,
    relatedChangeRequests: e.relatedChangeRequests,
    relatedCode: e.relatedCode.map((c) => ({ file: c.file, ...(c.symbol !== undefined ? { symbol: c.symbol } : {}) })),
    suggestedLabels: e.suggestedLabels,
    suggestedOwners: e.suggestedOwners,
    reproductionQuestions: e.reproductionQuestions,
    feasibility: (FEASIBILITY.has(e.feasibility) ? e.feasibility : 'needs-clarification') as IssueEnrichment['feasibility'],
    riskClassification: (RISK.has(e.riskClassification) ? e.riskClassification : 'medium') as IssueEnrichment['riskClassification'],
  };
}
