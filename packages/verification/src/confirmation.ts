export type Assertion =
  | { kind: 'stdout-contains'; value: string }
  | { kind: 'stdout-not-contains'; value: string }
  | { kind: 'exit-code'; value: number };

export interface ExecObservation {
  stdout: string;
  exitCode: number | null;
  timedOut?: boolean;
}

export function checkAssertions(observation: ExecObservation, assertions: Assertion[]): boolean {
  return assertions.every((a) => {
    switch (a.kind) {
      case 'stdout-contains':
        return observation.stdout.includes(a.value);
      case 'stdout-not-contains':
        return !observation.stdout.includes(a.value);
      case 'exit-code':
        return observation.exitCode === a.value;
    }
  });
}

export interface ConfirmationPlan {
  hypothesis: string;
  expectedSuccessSignal: Assertion[];
  expectedFailureSignal?: Assertion[];
  targetRevision: 'base' | 'head' | 'patched-head';
}

/** Without success assertions nothing is confirmed (a zero exit code is not enough). */
export async function runConfirmationPlan(
  run: () => Promise<ExecObservation>,
  plan: ConfirmationPlan,
): Promise<{ confirmed: boolean; observation: ExecObservation }> {
  const observation = await run();
  const confirmed =
    plan.expectedSuccessSignal.length > 0 && checkAssertions(observation, plan.expectedSuccessSignal);
  return { confirmed, observation };
}

/** Fails on the original code and passes after the fix -> differential-confirmed. */
export function isDifferentialConfirmed(
  headObserved: ExecObservation,
  patchedObserved: ExecObservation,
  plan: ConfirmationPlan,
): boolean {
  const bugPresentOnHead = plan.expectedFailureSignal
    ? checkAssertions(headObserved, plan.expectedFailureSignal)
    : !checkAssertions(headObserved, plan.expectedSuccessSignal);
  const fixedOnPatch = checkAssertions(patchedObserved, plan.expectedSuccessSignal);
  return bugPresentOnHead && fixedOnPatch;
}
