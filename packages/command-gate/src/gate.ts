import { classifyCommand } from './rules.js';
import { judgeCommand, type JudgeDeps, type JudgeInput, type JudgeVerdict } from './judge.js';

export interface GateDecision {
  verdict: 'allow' | 'deny';
  decidedBy: 'rule' | 'judge';
  /** The rule that decided, or escalated to the judge. */
  rule: string;
  reason: string;
  judgeCostUsd?: number;
}

export interface GateContext {
  task: string;
  purpose?: string;
  previous?: JudgeInput['previous'];
}

/** Rules first, then the judge; without a judge, escalated commands are denied (fail closed). */
export async function reviewCommand(
  command: string,
  ctx: GateContext,
  judge?: JudgeDeps | ((input: JudgeInput) => Promise<JudgeVerdict>),
): Promise<GateDecision> {
  const rule = classifyCommand(command);
  if (rule.tier !== 'judge') return { verdict: rule.tier, decidedBy: 'rule', rule: rule.rule, reason: rule.reason };
  if (!judge) {
    return { verdict: 'deny', decidedBy: 'rule', rule: rule.rule, reason: `${rule.reason}; such commands need a review that is not available here` };
  }
  const input: JudgeInput = {
    task: ctx.task,
    command,
    escalation: rule.reason,
    ...(ctx.purpose ? { purpose: ctx.purpose } : {}),
    ...(ctx.previous ? { previous: ctx.previous } : {}),
  };
  const v = typeof judge === 'function' ? await judge(input) : await judgeCommand(input, judge);
  return {
    verdict: v.verdict,
    decidedBy: 'judge',
    rule: rule.rule,
    reason: v.reason,
    ...(v.usage ? { judgeCostUsd: v.usage.costUsd } : {}),
  };
}
