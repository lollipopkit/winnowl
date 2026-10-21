import { buildSourceTools, runAgentInvocation, Type, type AgentBudget, type Model, type SourceProvider, type StreamFn } from '@reviewbot/agent-pi';

/**
 * Reconciles prior blocking findings on an incremental review (auto-approve gate).
 * approve iff every prior blocking finding is confirmed fixed by the LLM; a code change alone never counts.
 * Cheap prefilter: if the flagged file is untouched since the head that last reported the finding, it is
 * still present. The prefilter keys on "file touched", not "old anchor still matches": anchors sit on
 * declaration lines while fixes land inside the window, so anchor matching would keep the gate stuck.
 */

export interface PriorBlockingFinding {
  findingId: string;
  fingerprint: string;
  claim: string;
  /** Focus input for LLM verification only; never used to decide the status. */
  anchorText?: string;
  path?: string;
  /** Head sha that last reported this finding (prefilter base); missing → defer to the LLM. */
  lastSeenHeadSha?: string;
}

export interface ResolutionDeps {
  source: SourceProvider;
  model: Model<string>;
  /** Same-tier fallback models, passed through to `runAgentInvocation`. */
  fallbackModels?: Model<string>[];
  streamFn: StreamFn;
  budget: AgentBudget;
  /** Cap on LLM verifications (cost bound); findings beyond it stay blocking. Default 20. */
  maxVerify?: number;
  /**
   * Files changed between `sinceSha` and the current head; `null` = cannot tell, which always defers to the LLM.
   * Omitted = always `null`.
   */
  filesChangedSince?: (sinceSha: string) => Promise<ReadonlySet<string> | null>;
}

/**
 * still-present = still gates this PR; resolved = confirmed fixed;
 * not-applicable = flagged code is not on this head (belongs to another branch/PR): neither gates nor resolves.
 */
export type ResolutionStatus = 'still-present' | 'resolved' | 'not-applicable';
export type ResolutionMethod =
  | 'file-unchanged'
  | 'llm-verify'
  | 'no-anchor'
  | 'verify-capped'
  | 'file-absent'
  /** The whole workspace is unreadable (not just this file) → stay blocking. */
  | 'workspace-unreadable';

export interface ResolutionResult {
  findingId: string;
  fingerprint: string;
  claim: string;
  path?: string;
  status: ResolutionStatus;
  method: ResolutionMethod;
  /** LLM verdict rationale (llm-verify/no-anchor only); shown in the summary when the finding stays open. */
  reason?: string;
  /** Only with `status='resolved'`: a different problem found during verification; callers stage it as a new candidate. */
  newIssue?: ResolutionNewIssue;
}

/**
 * A different problem found in the same code while confirming the original fix. It does not inherit the
 * old finding's identity: the old one resolves and this one goes through the full publish chain
 * (`stageCandidate`), so a residual sub-case cannot keep a fixed finding gating forever.
 */
export interface ResolutionNewIssue {
  claim: string;
  path: string;
  /** Verbatim current code the new issue sits on; used for anchor resolution. */
  anchorText: string;
  category: string;
  suspectedSeverity: string;
}

const RESOLUTION_SYSTEM = [
  'You determine whether a previously reported code issue has been GENUINELY FIXED at the current revision.',
  'You are given the prior issue description and the exact code that was flagged. Use the read tools to inspect the current code.',
  'Critical: do NOT assume the issue is fixed just because the code changed — a change may be unrelated, cosmetic, or even introduce a different problem.',
  'Judge the DEFECT, not the wording. A prior description usually bundles three things: the defect, the evidence that led to it (file/line references, quoted control flow), and one remedy the reporter had in mind. Only the defect decides this verdict.',
  'The question to answer is whether the defect\'s observable consequence can still occur at the current revision. A fix that takes a different route than the remedy the description suggested still counts as fixed. Stale line numbers or quoted code that has since moved do not keep an issue open on their own.',
  'Report "fixed" ONLY if that consequence can no longer occur. If it still can, or you cannot confirm it is gone, report "still-present".',
  'A partial fix is still a fix of the original defect. If the specific consequence described above can no longer occur, report "fixed" — even when the surrounding code could still fail in some OTHER way. Do not keep the original issue open on the strength of a residual case it did not describe.',
  'When you report "fixed" and your inspection turned up a DIFFERENT problem in that code, put it in "newIssue" instead of holding the original open. It will be reported separately, on its own merits, after independent verification. Leave "newIssue" out when there is nothing new to report — an empty one is better than a manufactured one.',
  'State in "reasoning" which current code decides the verdict — that sentence is shown to the author when the issue stays open.',
].join('\n');

const RESOLUTION_SCHEMA = Type.Object({
  status: Type.String({ description: 'fixed | still-present' }),
  reasoning: Type.String(),
  newIssue: Type.Optional(
    Type.Object({
      claim: Type.String({ description: 'The different problem you found, stated as one falsifiable consequence.' }),
      path: Type.String({ description: 'File it lives in.' }),
      anchorText: Type.String({ description: 'The exact current source line(s) it sits on, copied verbatim.' }),
      category: Type.String({ description: 'correctness | security | concurrency | …' }),
      suspectedSeverity: Type.String({ description: 'critical | high | medium | low' }),
    }),
  ),
});

/** Any non-complete invocation is treated as still-present. */
async function verifyResolution(
  deps: ResolutionDeps,
  prior: PriorBlockingFinding,
): Promise<{ status: ResolutionStatus; reason?: string; newIssue?: ResolutionNewIssue }> {
  const task = [
    `Prior issue (claim): ${prior.claim}`,
    prior.path ? `File: ${prior.path}` : '',
    prior.anchorText ? `Previously flagged code:\n${prior.anchorText}` : '',
    'Inspect the current code and decide whether this specific issue is fixed.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const result = await runAgentInvocation({
    systemPrompt: RESOLUTION_SYSTEM,
    task,
    model: deps.model,
    ...(deps.fallbackModels ? { fallbackModels: deps.fallbackModels } : {}),
    streamFn: deps.streamFn,
    readTools: buildSourceTools(deps.source),
    finalization: { name: 'submit_resolution', description: 'Submit fixed/still-present verdict.', label: 'Submit resolution', schema: RESOLUTION_SCHEMA },
    budget: deps.budget,
  });
  if (result.status !== 'complete' || !result.finalization) return { status: 'still-present' };
  const fin = result.finalization as { status?: unknown; reasoning?: unknown; newIssue?: unknown };
  const status = String(fin.status ?? '').toLowerCase() === 'fixed' ? 'resolved' : 'still-present';
  const reason = typeof fin.reasoning === 'string' && fin.reasoning.trim() ? fin.reasoning.trim() : undefined;
  // Accept a new issue only on a "fixed" verdict and only with every field set; without path/anchorText it cannot be anchored.
  const n = fin.newIssue as Partial<Record<keyof ResolutionNewIssue, unknown>> | undefined;
  const newIssue: ResolutionNewIssue | undefined =
    status === 'resolved' && n && ['claim', 'path', 'anchorText', 'category', 'suspectedSeverity'].every((k) => typeof n[k as keyof ResolutionNewIssue] === 'string' && (n[k as keyof ResolutionNewIssue] as string).trim())
      ? {
          claim: (n.claim as string).trim(),
          path: (n.path as string).trim(),
          anchorText: (n.anchorText as string).trim(),
          category: (n.category as string).trim(),
          suspectedSeverity: (n.suspectedSeverity as string).trim(),
        }
      : undefined;
  return { status, ...(reason ? { reason } : {}), ...(newIssue ? { newIssue } : {}) };
}

/**
 * File absent from head → not-applicable; file untouched since last reported → still-present (no LLM);
 * otherwise a bounded (`maxVerify`) LLM verification.
 */
export async function reconcilePriorBlocking(deps: ResolutionDeps, priors: readonly PriorBlockingFinding[]): Promise<ResolutionResult[]> {
  const maxVerify = deps.maxVerify ?? 20;
  const out: ResolutionResult[] = [];
  let verifyBudget = maxVerify;
  /*
   * `readFile` returns null both when the file is absent from head and when the whole workspace is gone.
   * Treating the latter as not-applicable would silently clear the gate, so probe the workspace first.
   */
  let workspaceProbe: Promise<boolean> | null = null;
  const workspaceReadable = async (): Promise<boolean> => {
    if (!workspaceProbe) {
      workspaceProbe = (async () => {
        const changed = await deps.source.listChangedFiles().catch(() => []);
        const probes = changed.filter((f) => f.status !== 'deleted' && f.path).slice(0, 5);
        // Nothing readable to probe (empty or delete-only diff) → assume readable.
        if (probes.length === 0) return true;
        for (const p of probes) {
          if ((await deps.source.readFile(p.path).catch(() => null)) !== null) return true;
        }
        return false;
      })();
    }
    return workspaceProbe;
  };
  // Priors usually share a base sha; query git once per sha.
  const changedSince = new Map<string, Promise<ReadonlySet<string> | null>>();
  const untouchedSince = async (p: PriorBlockingFinding): Promise<boolean> => {
    if (!p.path || !p.lastSeenHeadSha || !deps.filesChangedSince) return false;
    const sha = p.lastSeenHeadSha;
    let pending = changedSince.get(sha);
    if (!pending) {
      pending = deps.filesChangedSince(sha).catch(() => null);
      changedSince.set(sha, pending);
    }
    const changed = await pending;
    if (changed === null || changed.has(p.path)) return false;
    // Cross-file claims can be fixed in another file: if any changed file's basename appears in the claim, defer to the LLM.
    for (const f of changed) {
      const base = f.slice(f.lastIndexOf('/') + 1);
      if (base.length >= 3 && p.claim.includes(base)) return false;
    }
    return true;
  };

  for (const p of priors) {
    const base = { findingId: p.findingId, fingerprint: p.fingerprint, claim: p.claim, ...(p.path ? { path: p.path } : {}) };
    // No path (legacy rows): go straight to the LLM.
    const content = p.path ? await deps.source.readFile(p.path) : null;
    if (p.path && content === null) {
      if (!(await workspaceReadable())) {
        out.push({ ...base, status: 'still-present', method: 'workspace-unreadable' });
        continue;
      }
      // Not resolved either: the finding may still be live on its own branch.
      out.push({ ...base, status: 'not-applicable', method: 'file-absent' });
      continue;
    }
    if (await untouchedSince(p)) {
      out.push({ ...base, status: 'still-present', method: 'file-unchanged' });
      continue;
    }
    if (verifyBudget <= 0) {
      out.push({ ...base, status: 'still-present', method: 'verify-capped' });
      continue;
    }
    verifyBudget -= 1;
    const { status, reason, newIssue } = await verifyResolution(deps, p);
    out.push({ ...base, status, method: p.anchorText ? 'llm-verify' : 'no-anchor', ...(reason ? { reason } : {}), ...(newIssue ? { newIssue } : {}) });
  }
  return out;
}
