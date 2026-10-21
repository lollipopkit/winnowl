import type { CommentDecision, NormalizedDiagnostic, RootCause } from './types.js';

export interface CommentDecisionInput {
  diagnostics: NormalizedDiagnostic[];
  /** The error is already visible to the user (annotation/summary). */
  ciAlreadyShowsError: boolean;
  rootCause?: RootCause;
}

/** Only comment when adding something the CI output does not already show. */
export function decideComment(input: CommentDecisionInput): CommentDecision {
  // User-visible (rendered in the comment footer).
  const valueAdds: string[] = [];
  const rc = input.rootCause;
  if (rc?.summary) valueAdds.push('root cause');
  if (rc?.causingChange) valueAdds.push('attributed to this change');
  if (rc && rc.sameRootCauseGroups.some((g) => g.length > 1)) valueAdds.push('grouped same-root-cause failures');
  if (rc?.verifiableFix) valueAdds.push('verifiable fix');
  if (input.diagnostics.some((d) => d.onChangedCode)) valueAdds.push('located on changed code');

  const hasValue = valueAdds.length > 0;
  const shouldComment = hasValue || (!input.ciAlreadyShowsError && input.diagnostics.length > 0);

  const reasons: string[] = [];
  if (!shouldComment) {
    reasons.push(
      input.ciAlreadyShowsError
        ? 'CI 已清楚显示错误且无增量价值,不复述(§29.3)'
        : '无诊断可呈现',
    );
  }
  return { shouldComment, valueAdds, reasons };
}
