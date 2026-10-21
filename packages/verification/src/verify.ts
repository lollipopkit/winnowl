import { sumUsage } from '@reviewbot/agent-pi';
import { needsRefuter, runRefuter } from './refuter.js';
import { runVerifier } from './verifier.js';
import type { VerifiableCandidate, VerifiedCandidate, VerifyDeps } from './types.js';


/** Verifier, then the refuter when needed; dispute keeps the accept but makes it non-blocking. */
export async function verifyCandidate(
  deps: VerifyDeps,
  candidate: VerifiableCandidate,
): Promise<VerifiedCandidate> {
  let verdict = await runVerifier(deps, candidate);
  /*
   * No finalization call is not a judgement, so run once more. Budget or wall-clock exhaustion is
   * not retried (same budget, same result); gateway errors were already retried.
   */
  if (verdict.incomplete && verdict.incompleteReason === 'no finalization tool called') {
    const again = await runVerifier(deps, candidate);
    const usage = sumUsage(verdict.usage, again.usage);
    verdict = { ...again, ...(usage ? { usage } : {}) };
  }
  const modelId = verdict.modelId;

  if (verdict.decision !== 'accept') {
    return { verdict, ...(verdict.usage ? { usage: verdict.usage } : {}), ...(modelId ? { modelId } : {}) };
  }
  if (!needsRefuter(verdict.severity, candidate.category)) {
    return { verdict, ...(verdict.usage ? { usage: verdict.usage } : {}), ...(modelId ? { modelId } : {}) };
  }

  const refutation = await runRefuter(deps, candidate);
  const usage = sumUsage(verdict.usage, refutation.usage);
  if (refutation.decision === 'reject') {
    return { verdict: { ...verdict, decision: 'reject' }, refutation, refuterUpheld: false, ...(usage ? { usage } : {}), ...(modelId ? { modelId } : {}) };
  }
  /*
   * dispute: technically valid but doubtful in practice. Still accept (the verifier reproduced it),
   * but non-blocking; critical/high go to Unverified risks, medium and below publish as non-blocking.
   */
  if (refutation.decision === 'dispute') {
    return { verdict, refutation, refuterUpheld: false, ...(usage ? { usage } : {}), ...(modelId ? { modelId } : {}) };
  }
  return { verdict, refutation, refuterUpheld: true, ...(usage ? { usage } : {}), ...(modelId ? { modelId } : {}) };
}
