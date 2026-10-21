import { Type } from '@reviewbot/agent-pi';
import { CHANGE_RELATIONS } from '@reviewbot/domain';

/** critical/high/medium must be fixed before merge; low is a nitpick. */
export const SEVERITY_SCHEMA = Type.Union([
  Type.Literal('critical'),
  Type.Literal('high'),
  Type.Literal('medium'),
  Type.Literal('low'),
]);

/** Must be an enum: only introduced/exposed/regressed block, and free text would all become `unknown`. */
export const CHANGE_RELATION_SCHEMA = Type.Union(CHANGE_RELATIONS.map((r) => Type.Literal(r)));

export const SUBMIT_VERDICT_SCHEMA = Type.Object({
  /**
   * Written before the decision. accept: triggering input -> wrong result, with the code line of each
   * step; reject: the code that disproves the claim.
   */
  rationale: Type.Optional(
    Type.String({
      description:
        'Your evidence, written before the decision. For accept: the triggering input, the wrong result, and the code lines (file:line) each step of the path goes through. For reject: the code that contradicts the claim (file:line). For uncertain: what you could not inspect.',
    }),
  ),
  /**
   * Asked separately from decision because models read accept as "accept my judgement". When false
   * the decision is treated as reject.
   */
  claimHolds: Type.Optional(
    Type.Boolean({
      description:
        'Does the code actually behave the way the claim says — does the claimed defect exist? Must agree with your rationale.',
    }),
  ),
  decision: Type.Union([Type.Literal('accept'), Type.Literal('reject'), Type.Literal('uncertain')], {
    description:
      'About the claim, not about your own analysis: accept = the claimed defect is real; reject = the claim is wrong or does not matter; uncertain = you could not resolve it.',
  }),
  introducedByChange: Type.Boolean(),
  reachable: Type.Boolean(),
  actionable: Type.Boolean(),
  changeRelation: CHANGE_RELATION_SCHEMA,
  severity: SEVERITY_SCHEMA,
  confirmation: Type.Union([
    Type.Literal('hypothesis'),
    Type.Literal('code-supported'),
    Type.Literal('independently-verified'),
  ]),
  residualUncertainty: Type.Array(Type.String()),
  /** Only helps the author prioritize; does not affect publication. */
  effort: Type.Optional(Type.Union([Type.Literal('quick-win'), Type.Literal('heavy-lift')])),
  /**
   * Only for local, mechanical, unambiguous fixes (it is committed with one click). `originalText`
   * must equal the head's [startLine, endLine] verbatim, or the suggestion is dropped.
   */
  suggestion: Type.Optional(
    Type.Object({
      startLine: Type.Number(),
      endLine: Type.Number(),
      originalText: Type.String(),
      replacement: Type.String(),
    }),
  ),
});

export const SUBMIT_REFUTATION_SCHEMA = Type.Object({
  decision: Type.String(),
  arguments: Type.Array(Type.String()),
});
