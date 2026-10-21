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
import type { FailedJob, RootCause } from './types.js';

const ROOT_CAUSE_SCHEMA = Type.Object({
  summary: Type.String(),
  causingChange: Type.Optional(Type.String()),
  sameRootCauseGroups: Type.Array(Type.Array(Type.String())),
  verifiableFix: Type.Optional(Type.String()),
  codeLocations: Type.Array(Type.Object({ file: Type.String(), line: Type.Optional(Type.Number()) })),
  confidence: Type.Number(),
});

export interface RootCauseDeps {
  model: Model<string>;
  streamFn: StreamFn;
  readTools?: AgentTool[];
  budget?: AgentBudget;
  changeSummary?: string;
  /** Output language for user-visible text; default `en`. */
  language?: string;
}

function languageSuffix(language: string | undefined): string {
  return languageInstruction(language, 'summary, attribution, verifiable fix');
}

/** Input diagnostics are already redacted. Never claims a reproduction; confidence reflects certainty. */
export async function analyzeRootCause(failedJobs: FailedJob[], deps: RootCauseDeps): Promise<RootCause> {
  const jobsText = failedJobs
    .map((j) => {
      const diags = j.diagnostics
        .map((d) => `  - ${d.severity} ${d.file ?? '?'}:${d.line ?? '?'} ${d.onChangedCode ? '[changed]' : ''} ${d.message}`)
        .join('\n');
      return `Job ${j.jobId} (${j.name}, ${j.conclusion}):\n${diags || '  (no structured diagnostics)'}`;
    })
    .join('\n\n');

  const task = [
    deps.changeSummary ? `Change summary: ${deps.changeSummary}` : '',
    'Failed CI jobs and normalized diagnostics:',
    jobsText,
    'Determine the root cause. Group jobs that share a root cause. Attribute to the change that caused it when possible. Propose a verifiable fix. Do not claim to have reproduced anything you did not.',
    'Call submit_root_cause.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await runAgentInvocation({
    systemPrompt:
      'You are a CI failure root-cause analyst. Be precise. Only claim a cause you can support from the diagnostics. Report confidence honestly.' +
      ' Format all user-facing text as Markdown: wrap every code identifier, function or variable name, file path, and code expression in inline-code backticks (e.g. `mul`, `src/math.js`, `arr[arr.length - 1]`) so it reads like a review comment.' +
      languageSuffix(deps.language),
    task,
    model: deps.model,
    streamFn: deps.streamFn,
    readTools: deps.readTools ?? [],
    finalization: {
      name: 'submit_root_cause',
      description: 'Submit the root-cause analysis.',
      label: 'Submit root cause',
      schema: ROOT_CAUSE_SCHEMA,
    },
    budget: deps.budget ?? { maxTurns: 6, maxToolCalls: 24 },
  });

  if (result.status !== 'complete' || !result.finalization) {
    return { summary: 'root cause undetermined', sameRootCauseGroups: [], codeLocations: [], confidence: 0 };
  }
  const rc = result.finalization as Static<typeof ROOT_CAUSE_SCHEMA>;
  return {
    summary: rc.summary,
    ...(rc.causingChange !== undefined ? { causingChange: rc.causingChange } : {}),
    sameRootCauseGroups: rc.sameRootCauseGroups,
    ...(rc.verifiableFix !== undefined ? { verifiableFix: rc.verifiableFix } : {}),
    codeLocations: rc.codeLocations.map((l) => ({ file: l.file, ...(l.line !== undefined ? { line: l.line } : {}) })),
    confidence: Math.max(0, Math.min(1, rc.confidence)),
  };
}
