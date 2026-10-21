/**
 * Cross-round finding identity. Strong fingerprints include LLM-rewritten claim and code window, so they
 * drift between rounds, and token-Dice cannot separate paraphrases from unrelated claims; an LLM decides.
 * Code only validates reported ids and enforces 1:1. When the LLM gives no verdict, fall back to
 * strong-fingerprint equality.
 */
import { runAgentInvocation, Type, type AgentBudget, type Model, type Static, type StreamFn } from '@reviewbot/agent-pi';

/** `id` is the candidate id. */
export interface MatchSubject {
  id: string;
  category: string;
  claim: string;
  path: string;
  /** primaryAnchorText. */
  codeWindow: string;
  fingerprint?: string;
}

/** `findingId` is the findings primary key. */
export interface MatchPrior {
  findingId: string;
  category: string;
  claim: string;
  fingerprint: string;
  path?: string;
  /** anchor_text of the latest occurrence. */
  codeWindow?: string;
}

export type MatchMethod = 'llm' | 'fingerprint';

export interface FindingMatch {
  priorFindingId: string;
  priorFingerprint: string;
  method: MatchMethod;
}

export interface FindingMatcherDeps {
  model: Model<string>;
  streamFn: StreamFn;
  budget: AgentBudget;
  /** Link equal strong fingerprints without asking the LLM (saves tokens). Default false. */
  fastPath?: boolean;
  /** Cap on current + prior items in the prompt; lower-relevance priors are dropped and reported via onTruncate. */
  maxItems?: number;
  onTruncate?: (dropped: number) => void;
}

/** candidate id → matched prior. */
export type FindingMatches = ReadonlyMap<string, FindingMatch>;

export type FindingMatcher = (
  subjects: readonly MatchSubject[],
  priors: readonly MatchPrior[],
  opts?: { onTruncate?: (dropped: number) => void },
) => Promise<FindingMatches>;

export function createLlmFindingMatcher(deps: FindingMatcherDeps): FindingMatcher {
  return (subjects, priors, opts) =>
    matchPriorFindings(subjects, priors, {
      ...deps,
      // Call-site callback wins so the truncation count reaches this review's outcome.
      ...(opts?.onTruncate ? { onTruncate: opts.onTruncate } : {}),
    });
}

const LINKS_SCHEMA = Type.Object({
  links: Type.Array(
    Type.Object({
      currentId: Type.String({ description: 'id from "Current findings"' }),
      priorId: Type.String({ description: 'id from "Previously reported"' }),
      reason: Type.String({
        description: 'one short sentence: the shared triggering input and wrong result, i.e. why fixing the prior also fixes this one',
      }),
    }),
  ),
});

const MATCH_SYSTEM = [
  'You decide which of the findings reported in THIS round are the SAME defect as one already reported in an EARLIER round of review on the same pull request.',
  'Same defect = same root cause and same behavior. It counts as the same defect even when:',
  '  - the wording is completely rewritten (a different reviewer pass phrases it differently);',
  '  - the code was edited, refactored, or MOVED TO A DIFFERENT FILE.',
  'It is NOT the same defect when two findings merely touch the same file, the same function, or the same general topic.',
  'Test every link: if the earlier finding were fixed exactly as it describes, would the current finding go away too?',
  'If not — a different triggering input, a different missing guard, a different wrong result — they are different defects,',
  'even in the same few lines. A new edge case found in code that was just changed to fix an earlier finding is a NEW defect.',
  'Be conservative: only link what you are confident about. When unsure, leave it unlinked —',
  'a wrong link hides a real new issue, while a missing link only costs a duplicate report.',
  'Each current finding links to at most one prior, and each prior to at most one current.',
].join('\n');

const MATCH_TASK = 'Link current findings to the earlier ones they repeat, then call `submit_links`.';

/**
 * Ranks priors by relevance to this round so the size cap keeps the likely matches:
 * same file first, then same category, then load order (most recent occurrence first).
 * No semantic similarity here: that would need another LLM call or token-Dice, which cannot rank paraphrases.
 */
function recallPriors(subjects: readonly MatchSubject[], priors: readonly MatchPrior[]): MatchPrior[] {
  const subjectPaths = new Set(subjects.map((s) => s.path));
  const subjectCategories = new Set(subjects.map((s) => s.category));
  const score = (p: MatchPrior): number =>
    (p.path !== undefined && subjectPaths.has(p.path) ? 2 : 0) + (subjectCategories.has(p.category) ? 1 : 0);
  // Stable sort keeps load order (recent first) among equal scores.
  return [...priors].sort((a, b) => score(b) - score(a));
}

/** Code window collapsed to one truncated line. */
function line(id: string, category: string, path: string, claim: string, codeWindow?: string): string {
  const code = codeWindow ? ` | ${codeWindow.replace(/\s+/g, ' ').trim().slice(0, 160)}` : '';
  return `${id} | ${category} | ${path} | ${claim}${code}`;
}

/** Candidates absent from the result are new this round. Never throws; LLM failure falls back to fingerprints. */
export async function matchPriorFindings(
  subjects: readonly MatchSubject[],
  priors: readonly MatchPrior[],
  deps: FindingMatcherDeps,
): Promise<FindingMatches> {
  const out = new Map<string, FindingMatch>();
  if (subjects.length === 0 || priors.length === 0) return out;

  const priorById = new Map(priors.map((p) => [p.findingId, p]));
  const takenPriors = new Set<string>();

  let pendingSubjects = subjects;
  let pendingPriors = priors;
  if (deps.fastPath) {
    const priorByFp = new Map(priors.map((p) => [p.fingerprint, p]));
    for (const s of subjects) {
      const hit = s.fingerprint ? priorByFp.get(s.fingerprint) : undefined;
      if (!hit || takenPriors.has(hit.findingId)) continue;
      takenPriors.add(hit.findingId);
      out.set(s.id, { priorFindingId: hit.findingId, priorFingerprint: hit.fingerprint, method: 'fingerprint' });
    }
    pendingSubjects = subjects.filter((s) => !out.has(s.id));
    pendingPriors = priors.filter((p) => !takenPriors.has(p.findingId));
  }
  if (pendingSubjects.length === 0 || pendingPriors.length === 0) return out;

  const maxItems = deps.maxItems ?? 120;
  const promptSubjects = pendingSubjects;
  let promptPriors = pendingPriors;
  if (promptSubjects.length + promptPriors.length > maxItems) {
    const keepPriors = Math.max(1, maxItems - promptSubjects.length);
    const ranked = recallPriors(promptSubjects, promptPriors);
    deps.onTruncate?.(Math.max(0, promptPriors.length - keepPriors));
    promptPriors = ranked.slice(0, keepPriors);
  }

  const task = [
    MATCH_TASK,
    '',
    'Current findings (id | category | path | claim | code):',
    ...promptSubjects.map((s) => line(s.id, s.category, s.path, s.claim, s.codeWindow)),
    '',
    'Previously reported, still open (id | category | path | claim | code):',
    ...promptPriors.map((p) => line(p.findingId, p.category, p.path ?? '?', p.claim, p.codeWindow)),
  ].join('\n');

  let links: Static<typeof LINKS_SCHEMA>['links'] | undefined;
  try {
    const result = await runAgentInvocation({
      systemPrompt: MATCH_SYSTEM,
      task,
      model: deps.model,
      streamFn: deps.streamFn,
      readTools: [],
      finalization: {
        name: 'submit_links',
        description: 'Submit the current↔prior links.',
        label: 'Submit links',
        schema: LINKS_SCHEMA,
      },
      budget: deps.budget,
    });
    if (result.status === 'complete') {
      links = (result.finalization as Static<typeof LINKS_SCHEMA> | undefined)?.links;
    }
  } catch {
    links = undefined;
  }

  if (links === undefined) {
    const priorByFp = new Map(pendingPriors.map((p) => [p.fingerprint, p]));
    for (const s of pendingSubjects) {
      const hit = s.fingerprint ? priorByFp.get(s.fingerprint) : undefined;
      if (!hit || takenPriors.has(hit.findingId)) continue;
      takenPriors.add(hit.findingId);
      out.set(s.id, { priorFindingId: hit.findingId, priorFingerprint: hit.fingerprint, method: 'fingerprint' });
    }
    return out;
  }

  // The model may report unknown ids or link several currents to one prior: validate and keep the first link (1:1).
  const subjectIds = new Set(promptSubjects.map((s) => s.id));
  for (const l of links) {
    if (!subjectIds.has(l.currentId) || out.has(l.currentId)) continue;
    const prior = priorById.get(l.priorId);
    if (!prior || takenPriors.has(prior.findingId)) continue;
    takenPriors.add(prior.findingId);
    out.set(l.currentId, { priorFindingId: prior.findingId, priorFingerprint: prior.fingerprint, method: 'llm' });
  }
  return out;
}
