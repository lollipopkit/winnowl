import { buildSourceTools, runAgentInvocation, type Static } from '@reviewbot/agent-pi';
import type { FindingCategory, Severity } from '@reviewbot/findings';
import { coerce } from './coerce.js';
import { SUBMIT_REFUTATION_SCHEMA } from './schemas.js';
import { candidatePrompt } from './verifier.js';
import type { RefutationResult, VerifiableCandidate, VerifyDeps } from './types.js';

/** Every blocking severity (critical/high/medium) needs the refuter: one verifier vote must not block a PR. */
export function needsRefuter(severity: Severity, category: FindingCategory): boolean {
  if (severity === 'critical' || severity === 'high' || severity === 'medium') return true;
  return (
    ['security', 'authorization', 'data-integrity', 'concurrency'] as FindingCategory[]
  ).includes(category);
}

/** Not finishing yields dispute (non-blocking). */
export async function runRefuter(
  deps: VerifyDeps,
  candidate: VerifiableCandidate,
): Promise<RefutationResult> {
  const bundle = deps.bundles.refuter;
  const result = await runAgentInvocation({
    systemPrompt: bundle.system + (deps.standards ?? ''),
    task: `${bundle.task}\n\n${candidatePrompt(candidate)}`,
    model: deps.refuterModel?.model ?? deps.model,
    ...((deps.refuterModel ? deps.refuterModel.fallbackModels : deps.fallbackModels)
      ? {
          fallbackModels: (deps.refuterModel
            ? deps.refuterModel.fallbackModels
            : deps.fallbackModels)!,
        }
      : {}),
    streamFn: deps.refuterModel?.streamFn ?? deps.streamFn,
    ...(deps.seedMessages && deps.seedMessages.length > 0
      ? { seedMessages: deps.seedMessages }
      : {}),
    readTools: [...buildSourceTools(deps.source), ...(deps.knowledgeTools ?? []), ...(deps.pluginTools ?? [])],
    finalization: {
      name: 'confirm_assessment',
      description: 'Submit the final decision on the finding.',
      label: 'Confirm assessment',
      schema: SUBMIT_REFUTATION_SCHEMA,
    },
    budget: deps.budget,
  });

  if (result.status !== 'complete' || !result.finalization) {
    return {
      candidateId: candidate.id,
      decision: 'dispute',
      arguments: ['refuter did not finalize'],
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
  const f = result.finalization as Static<typeof SUBMIT_REFUTATION_SCHEMA>;
  return {
    candidateId: candidate.id,
    decision: coerce(f.decision, ['uphold', 'dispute', 'reject'] as const, 'dispute'),
    arguments: f.arguments,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
