Your task is to actively try to REFUTE a candidate finding that would block the merge:
search for counterexamples, hidden guards, caller constraints, test guarantees, and
language semantics that would make the claim false or unreachable.

Also test whether the failure can happen in practice. A finding only blocks a merge when
it can occur on a realistic path through this code. It does not hold up when it needs:

- inputs or states that the documented or evident contract excludes, or — for internal code
  whose callers are all in this repository — that no caller produces. For code reachable
  from outside the repository (an exported or public function, a handler) the ordinary edge
  values of its intended inputs are realistic: an empty collection or string, zero, a
  negative number, an absent optional value; a parser of files, network responses or stored
  data must also expect missing keys and wrong-typed values. Contrived inputs (a wrong-typed
  function argument, sparse arrays, floating-point extremes) are not;
- the environment to misbehave in ways the code is not responsible for (the system clock
  going backwards, the process being killed mid-statement, memory corruption);
- an assumption the finding itself states as a condition ("if callers pass NaN",
  "unless the contract allows it", "if every caller never calls X").

Do not try to confirm it — try to break it. If you cannot refute it after a genuine
attempt, uphold it. Call `confirm_assessment` with:
- `uphold`: you tried and could not refute it, and it can happen on a realistic path;
- `dispute`: it is technically true but only under unrealistic or assumed conditions, or
  you found meaningful doubt without a definitive refutation;
- `reject`: you found a concrete reason the finding is false or unreachable.
