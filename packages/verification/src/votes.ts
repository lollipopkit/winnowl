import type { ConfirmationLevel, Severity } from '@reviewbot/findings';
import { CONFIRMATION_RANK } from '@reviewbot/findings';
import { sumUsage as sumInvocationUsage } from '@reviewbot/agent-pi';
import type { InvocationUsage, Model, StreamFn } from '@reviewbot/agent-pi';
import type { VerifiableCandidate, VerifiedCandidate, VerifyDeps } from './types.js';
import { verifyCandidate } from './verify.js';

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const sumUsage = (parts: (InvocationUsage | undefined)[]): InvocationUsage | undefined =>
  sumInvocationUsage(...parts);

/** Median; for an even count the lower one (conservative). */
function medianBy<T>(items: T[], rank: (t: T) => number): T {
  const sorted = [...items].sort((a, b) => rank(a) - rank(b));
  return sorted[Math.ceil(sorted.length / 2) - 1]!;
}

/**
 * N independent verifications, conservatively aggregated:
 * - accept needs a strict majority; otherwise any accept -> uncertain, none -> reject;
 * - severity = median of accepts (lower on ties), confirmation = lowest among accepts;
 * - refuterUpheld is false if any accept was refuted; residual uncertainties are unioned.
 * votes <= 1 is a plain verifyCandidate.
 */
export async function verifyCandidateWithVotes(
  deps: VerifyDeps,
  candidate: VerifiableCandidate,
  votes: number,
  /**
   * Model per vote index (not per candidate), so every candidate gets the same cross-model panel
   * regardless of arrival order. undefined: `deps.model`.
   */
  voteModel?: (
    voteIndex: number,
    stage: 'verify' | 'refute',
  ) => { model: Model<string>; fallbackModels?: Model<string>[]; streamFn?: StreamFn } | undefined,
): Promise<VerifiedCandidate> {
  const depsForVote = (i: number): VerifyDeps => {
    const v = voteModel?.(i, 'verify');
    const r = voteModel?.(i, 'refute');
    if (!v && !r) return deps;
    return {
      ...deps,
      ...(v
        ? {
            model: v.model,
            ...(v.fallbackModels ? { fallbackModels: v.fallbackModels } : {}),
            ...(v.streamFn ? { streamFn: v.streamFn } : {}),
          }
        : {}),
      ...(r ? { refuterModel: r } : {}),
    };
  };
  if (votes <= 1) return verifyCandidate(depsForVote(0), candidate);

  const results = await Promise.all(
    Array.from({ length: votes }, (_, i) => verifyCandidate(depsForVote(i), candidate)),
  );
  const usage = sumUsage(results.map((r) => r.usage));
  const majority = Math.floor(votes / 2) + 1;
  const accepts = results.filter((r) => r.verdict.decision === 'accept');
  const rejects = results.filter((r) => r.verdict.decision === 'reject');

  if (accepts.length >= majority) {
    const severity = medianBy(accepts, (r) => SEVERITY_RANK[r.verdict.severity]).verdict.severity;
    const confirmation = accepts.reduce<ConfirmationLevel>(
      (lowest, r) =>
        CONFIRMATION_RANK[r.verdict.confirmation] < CONFIRMATION_RANK[lowest]
          ? r.verdict.confirmation
          : lowest,
      accepts[0]!.verdict.confirmation,
    );
    const residual = [...new Set(accepts.flatMap((r) => r.verdict.residualUncertainty))];
    const anyRefuted = accepts.some((r) => r.refuterUpheld === false);
    const upheld = anyRefuted
      ? false
      : accepts.find((r) => r.refuterUpheld !== undefined)?.refuterUpheld;
    const base = accepts[0]!;
    return {
      verdict: { ...base.verdict, severity, confirmation, residualUncertainty: residual },
      ...(upheld !== undefined ? { refuterUpheld: upheld } : {}),
      ...(base.refutation ? { refutation: base.refutation } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  if (accepts.length > 0) {
    // Accepts without a majority: uncertain (non-blocking).
    const base = accepts[0]!;
    return { verdict: { ...base.verdict, decision: 'uncertain' }, ...(usage ? { usage } : {}) };
  }

  const base = rejects[0] ?? results[0]!;
  return {
    verdict: { ...base.verdict, decision: base.verdict.decision },
    ...(usage ? { usage } : {}),
  };
}
