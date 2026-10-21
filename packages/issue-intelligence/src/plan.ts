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
import type { ImplementationPlan } from './types.js';

const PLAN_SCHEMA = Type.Object({
  understanding: Type.String(),
  assumptions: Type.Array(Type.String()),
  relatedCode: Type.Array(Type.Object({ file: Type.String(), symbol: Type.Optional(Type.String()) })),
  likelyRootCause: Type.String(),
  changeSteps: Type.Array(Type.String()),
  testSteps: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  openQuestions: Type.Array(Type.String()),
  canStartCodingAgent: Type.Boolean(),
});

export interface PlanDeps {
  model: Model<string>;
  streamFn: StreamFn;
  readTools?: AgentTool[];
  budget?: AgentBudget;
  /** Output language; default `en`. */
  language?: string;
}

/** Must not claim unexecuted code paths were verified; those go into assumptions/openQuestions. */
export async function planImplementation(
  input: { title: string; body: string },
  deps: PlanDeps,
): Promise<ImplementationPlan> {
  const result = await runAgentInvocation({
    systemPrompt:
      'You produce an implementation plan for an issue. State assumptions explicitly. Never claim to have verified a code path you did not execute — put anything unverified into assumptions or open questions.' +
      languageInstruction(deps.language, 'understanding, steps, tests, risks and open questions'),
    task: `Issue: ${input.title}\n\n${input.body}\n\nCall submit_plan.`,
    model: deps.model,
    streamFn: deps.streamFn,
    readTools: deps.readTools ?? [],
    finalization: {
      name: 'submit_plan',
      description: 'Submit the implementation plan.',
      label: 'Submit plan',
      schema: PLAN_SCHEMA,
    },
    budget: deps.budget ?? { maxTurns: 8, maxToolCalls: 32 },
  });

  if (result.status !== 'complete' || !result.finalization) {
    return {
      understanding: 'plan undetermined',
      assumptions: [],
      relatedCode: [],
      likelyRootCause: '',
      changeSteps: [],
      testSteps: [],
      risks: [],
      openQuestions: ['agent did not finalize a plan'],
      canStartCodingAgent: false,
    };
  }
  const p = result.finalization as Static<typeof PLAN_SCHEMA>;
  return {
    understanding: p.understanding,
    assumptions: p.assumptions,
    relatedCode: p.relatedCode.map((c) => ({ file: c.file, ...(c.symbol !== undefined ? { symbol: c.symbol } : {}) })),
    likelyRootCause: p.likelyRootCause,
    changeSteps: p.changeSteps,
    testSteps: p.testSteps,
    risks: p.risks,
    openQuestions: p.openQuestions,
    canStartCodingAgent: p.canStartCodingAgent,
  };
}
