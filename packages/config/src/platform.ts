/**
 * Platform operator settings editable in the console: platform-wide cost/behaviour decisions, not
 * per-repo config. Resolution is DB, then env, then default; the env path stays so rollback switches
 * do not depend on the console being healthy.
 */

export interface PlatformSettingDef {
  key: string;
  /** Read when the DB has no value. */
  env: string;
  /** The first value is the default. */
  values: readonly string[];
  /** Shown in the console. */
  description: string;
}

export const PLATFORM_SETTINGS = [
  {
    key: 'review.finding_match',
    env: 'REVIEW_FINDING_MATCH',
    values: ['llm', 'off'],
    description:
      'How a finding from an earlier review round is recognised as the same defect in a later one. "llm" asks the model once per round (text only, no code reads); "off" falls back to exact fingerprint equality, which misses the same defect whenever the model rephrases its claim — and has no working fallback at all for non-English claims.',
  },
  {
    key: 'review.dedup',
    env: 'LLM_DEDUP',
    values: ['token', 'embedding', 'llm'],
    description:
      'Duplicate collapsing among candidates within a single round. "token" is free word-overlap; "embedding" needs LLM_EMBED_MODEL and costs one embedding call per candidate; "llm" clusters in one call but forces a barrier before verification, losing pipeline overlap.',
  },
  {
    key: 'review.max_turns',
    env: 'REVIEW_MAX_TURNS',
    values: ['200', 'auto', '25', '50', '100', '400'],
    description:
      'How many turns the exploration agent gets before the run is abandoned. A model that converges finalises in a handful of turns regardless; the ceiling only matters for one that circles, and the whole cost of those turns is spent before the run fails. "auto" keeps the adaptive budget: the profile baseline (42 / 70 / 112 turns for conservative / balanced / thorough) scaled by change risk — halved for docs-only or generated code, up to 2.75× when the diff touches auth, migrations, public APIs or dependency manifests. That lands between 21 and 308 turns, and on 70 for a default repository with an ordinary diff.',
  },
  // Stage wall clocks in minutes. The maxima (20 + 35 + 25 + 10 = 90) must stay below the sandbox
  // `EXEC_TIMEOUT_MS` (95 min, review-in-sandbox.ts); raise that too when adding larger values.
  {
    key: 'review.stage_budget.map',
    env: 'REVIEW_STAGE_BUDGET_MAP',
    values: ['5', '2', '10', '20', 'off'],
    description:
      'Minutes the map stage gets to produce the scope list. Measured on live: median 27s, p95 65s, worst 232s — so 5 minutes only ever cuts off a model that is going in circles, and cutting it there rather than at the 95-minute total means the run fails early instead of burning the whole budget for nothing.',
  },
  {
    key: 'review.stage_budget.dig',
    env: 'REVIEW_STAGE_BUDGET_DIG',
    values: ['15', '5', '10', '25', '35', 'off'],
    description:
      'Minutes for the whole dig stage, not per scope — the number of scopes is the model’s decision, so a per-scope allowance would hand it the total. Measured on live: median 110s, p95 979s. On expiry the scope in flight keeps what it collected and the rest are skipped, showing up as incomplete coverage.',
  },
  {
    key: 'review.stage_budget.verify',
    env: 'REVIEW_STAGE_BUDGET_VERIFY',
    values: ['9', '5', '15', '25', 'off'],
    description:
      'Minutes for verification, counted from the first candidate rather than from the start of the review (verify overlaps dig, so counting from the start would charge it for exploration). Measured on live: median 127s, p95 299s. Candidates left unverified are dropped rather than published, and counted so the gap is visible.',
  },
  {
    key: 'review.stage_budget.synthesis',
    env: 'REVIEW_STAGE_BUDGET_SYNTHESIS',
    values: ['3', '1', '5', '10', 'off'],
    description:
      'Minutes for the cross-scope synthesis pass. Measured on live: median 26s, p95 53s, worst 359s.',
  },
  {
    key: 'review.stale_rounds',
    env: 'REVIEW_STALE_ROUNDS',
    values: ['3', 'off', '2', '5', '10'],
    description:
      'How many consecutive review rounds a finding can go without being rediscovered before it is archived as stale, provided the file it was anchored to changed in the meantime. Findings only ever left the active set by explicit judgement — fixed, retracted, or dismissed by a user — so anything nobody judged stayed active forever: one pull request had accumulated 541 of them, well past the 120 that fit in the cross-round matching prompt, so the same defect kept opening new rows every round. Both conditions are required: exploration is stochastic, and a round that did not look at that code is not evidence the problem is gone. Archiving is reversible — a finding reported again returns to the active set — and a finding that still blocks the merge gate is never archived. "off" disables it.',
  },
  // Independent of `review.session_reuse`: only forks the map transcript into each dig; digs stay
  // concurrent and isolated, and verify is untouched.
  {
    key: 'review.dig_context',
    env: 'REVIEW_DIG_CONTEXT',
    values: ['fresh', 'fork-map'],
    description:
      'What each area review starts from. "fresh" starts every one with an empty conversation, so it re-reads whatever it needs — the shape that has been running. "fork-map" gives all of them the mapping pass\'s conversation as a shared, identical prefix, which is what makes a prompt cache hit possible; siblings still cannot see each other. Whether that is cheaper depends entirely on the gateway caching that prefix: if it does, the shared part costs a fraction of its input price, and if it does not, the same large prefix is paid at full price once per area. Check the cacheRead figures in the review log before turning it on.',
  },
  {
    key: 'review.subagents',
    env: 'REVIEW_SUBAGENTS',
    values: ['off', '2', '3', '4', '6'],
    description:
      'How many questions the review of one area may investigate at the same time. Reviewing an area is one long serial conversation — read, think, read, think — and on this gateway a single stream runs at the same speed whether one or eight are open, so the time an area takes is essentially the tokens it writes divided by one stream. Splitting the next few independent questions across that many helpers divides the waiting by roughly the same number. The helpers cannot see the conversation that started them and cannot start helpers of their own; anything they find is submitted as if the area review found it, and what they spend counts against the same cost cap. "off" keeps one conversation per area.',
  },
  {
    key: 'review.session_reuse',
    env: 'REVIEW_SESSION_REUSE',
    values: ['0', '1'],
    description:
      'Reuse the map+dig session transcript for verification instead of starting fresh. Cheaper via prompt cache on the shared prefix; costs context isolation between stages.',
  },
  {
    key: 'billing.public_repo',
    env: 'BILLING_PUBLIC_REPO',
    values: ['full', 'x10', 'free'],
    description:
      'How work on public repositories counts against a tenant’s monthly quota. "full" bills it like any other repository. "x10" counts it at one tenth, which is the same as giving public repositories ten times the quota. "free" does not count it at all. Cost, tokens and review count are discounted together — discounting only the money would still stop a project at the review-count limit. The daily circuit breaker and the per-run cost cap are unaffected: those guard the platform’s actual bill, not the tenant’s allowance. A repository whose visibility is unknown is billed as private.',
  },
  {
    key: 'fix.validation',
    env: 'FIX_VALIDATION',
    // Off by default: a validation sandbox is the largest one, so it is an explicit choice.
    values: ['off', 'on'],
    description:
      'Whether a fix is installed, linted, built and tested in a validation sandbox before its pull request is opened; the outcome is added to the pull request as a note and never blocks it. Only takes effect where a validation image is deployed (VALIDATION_SANDBOX_IMAGE); without one there is nothing to run. A validation sandbox is sized from what the repository needed before (up to 6 GiB), so turning it off frees sandbox host capacity. Applies from the next fix delivery.',
  },
  // Off until the eval says otherwise.
  {
    key: 'agent.sandbox',
    env: 'AGENT_SANDBOX',
    values: ['off', 'on'],
    description:
      "Whether the fix agent works inside a sandbox with the repository's toolchains: it edits the code there and may run commands (install, build, test) to check its change; every command is reviewed outside the sandbox first and recorded. The finished change is validated in the same sandbox, so the separate fix validation is not used. Needs a validation image (VALIDATION_SANDBOX_IMAGE). Applies from the next fix.",
  },
  {
    key: 'review.auto_continue_rounds',
    env: 'REVIEW_AUTO_CONTINUE_ROUNDS',
    values: ['20', '0', '5', '50'],
    description:
      'How many further rounds a review starts on its own when files of the same head are still unreviewed (the files-per-round limit, or a stage wall clock / cost cap cut the round short). Each round must cover at least one new file, or the chain stops, so a section the model cannot finish does not loop. Every round goes through the usual quota checks. 0 = only a push or the status-comment checkbox continues.',
  },
  {
    key: 'review.verify_votes',
    env: 'LLM_VERIFY_VOTES',
    values: ['1', '3', '5'],
    description:
      'How many independent verifications each candidate gets before it is published. With more than one, the votes are combined conservatively: a candidate needs the majority to confirm it, so a single verifier that is wrongly convinced cannot publish a false positive on its own. Verification cost scales with the number: 3 votes cost three times the verify spend. With stage models configured for verify, each vote goes to the next model in the list.',
  },
  {
    key: 'review.dig_concurrency',
    env: 'LLM_DIG_CONCURRENCY',
    values: ['2', '1', '4', '6', '8'],
    description:
      'How many areas of one pull request are reviewed at the same time. Total parallel model calls multiply: runner concurrency × this × review.subagents. More areas at once only finishes sooner when the model gateway serves more parallel streams without slowing each one down; the review wall clock (review.stage_budget.dig) is shared by all areas either way.',
  },
  {
    key: 'review.verify_concurrency',
    env: 'LLM_VERIFY_CONCURRENCY',
    values: ['8', '4', '12', '16'],
    description:
      'How many candidates are verified at the same time within one review. Verification overlaps exploration, so this adds to the dig parallelism rather than replacing it. Lower it when the gateway rate-limits; candidates left unverified at the verify wall clock are dropped.',
  },
  {
    key: 'review.fast_map',
    env: 'REVIEW_FAST_MAP',
    values: ['1', '0'],
    description:
      'Small changes (at most 3 files and 120 changed lines) skip the mapping pass and are reviewed as one area. "0" maps every change, which costs one extra model conversation per small review and does not change what is examined.',
  },
  {
    key: 'review.max_tool_calls',
    env: 'REVIEW_MAX_TOOL_CALLS',
    values: ['auto', '24', '40', '80', '120'],
    description:
      'Soft limit on tool calls (file reads, searches) per exploration conversation; past it the agent is asked to finish with what it has. This is the main cost control of a review. "auto" uses the profile baseline (24 / 40 / 80 for conservative / balanced / thorough) scaled by change risk, the same way review.max_turns scales.',
  },
  {
    key: 'knowledge.select',
    env: 'KNOWLEDGE_SELECT_ENABLED',
    values: ['1', '0'],
    description:
      'Whether learnings and rules for a review are picked by a model call when there are many of them. "1" injects all of them when there are few (see knowledge.inject_all_threshold) and otherwise asks the model which apply to this change. "0" never calls the model and keeps them ordered by how well their path matches the changed files, which costs nothing but may inject unrelated ones.',
  },
  {
    key: 'knowledge.inject_all_threshold',
    env: 'KNOWLEDGE_SELECT_INJECT_ALL_THRESHOLD',
    values: ['12', '6', '24', '50'],
    description:
      'At or below this many applicable learnings and rules, all of them are injected into the review without a selection call.',
  },
  {
    key: 'knowledge.select_cap',
    env: 'KNOWLEDGE_SELECT_CAP',
    values: ['60', '30', '100', '200'],
    description:
      'The most learnings and rules sent to the selection call. Mandatory ones and ones without a path always stay; beyond the cap the rest are dropped by path match, then by specificity. A higher cap makes the selection call longer and more expensive.',
  },
  {
    key: 'knowledge.global_auto_propose',
    env: 'GLOBAL_LEARNING_AUTO_PROPOSE',
    values: ['off', 'on'],
    description:
      'Whether each finished review is checked for a lesson that applies to every project. A candidate is drafted, voted on by the panel (knowledge.global_panel) and stored as proposed; it only takes effect after a platform operator approves it under Global learnings. Spend is platform cost and is not charged to the tenant. Applies from the next finished review.',
  },
  {
    key: 'knowledge.global_panel',
    env: 'GLOBAL_LEARNING_PANEL',
    values: ['tiers', 'registry'],
    description:
      'Which models vote on a proposed global learning. "tiers" gives one vote to each model tier (quality, balanced, cheap); a tier without its own model uses the default model, so with a single model all votes come from it. "registry" gives one vote to every enabled model in the model table, so the panel follows that table; each vote is one model call.',
  },
  {
    key: 'post_merge.enabled',
    env: 'POST_MERGE_ENABLED',
    values: ['0', '1'],
    description:
      'Whether the actions after a merge (documentation updates, follow-up issues) run at all. Off for the whole platform because follow-up issues were opened on nearly every merge; a repository that turns on actions.post_merge still gets nothing while this is "0".',
  },
  {
    key: 'security.dep_scan',
    env: 'DEP_SCAN_ENABLED',
    values: ['1', '0'],
    description:
      'Whether a review that touches a dependency manifest or lockfile runs osv-scanner and turns the known vulnerabilities into findings. It runs no repository code; a failure never blocks the review. "0" skips the scan.',
  },
  {
    key: 'security.static_scan',
    env: 'SECURITY_STATIC_SCAN',
    values: ['1', '0'],
    description:
      'Whether the scheduled security scan runs semgrep and gitleaks over the default branch before the security agent reads it. gitleaks results keep the rule and location only; the matched secret is never stored. "0" leaves the agent with its own reading and osv-scanner.',
  },
  {
    key: 'security.issue_channel',
    env: 'SECURITY_ISSUE_CHANNEL',
    values: ['0', '1'],
    description:
      'Whether security scan results are also opened as issues in the repository, one per finding and never twice. An issue is visible to every collaborator, and to everyone on a public repository, so exploit details are withheld unless security.issue_disclosure is "full".',
  },
  {
    key: 'security.issue_disclosure',
    env: 'SECURITY_ISSUE_DISCLOSURE',
    values: ['public', 'full'],
    description:
      'What a security issue contains. "public" gives the location and the problem without exploit details. "full" includes them, which anyone who can read the issue can then use.',
  },
  {
    key: 'security.issue_min_severity',
    env: 'SECURITY_ISSUE_MIN_SEVERITY',
    values: ['high', 'critical', 'medium', 'low', 'info'],
    description: 'The lowest severity that is opened as a security issue.',
  },
  {
    key: 'byok.enabled',
    env: 'BYOK_ENABLED',
    values: ['1', '0'],
    description:
      'Whether reviews use the model keys that users, repositories and organizations brought themselves. "0" sends every review through the platform key and its quota, whatever is configured.',
  },
  {
    key: 'quota.warn_ratio',
    env: 'QUOTA_WARN_RATIO',
    values: ['0.8', '0.5', '0.9', '0'],
    description:
      'Share of a monthly quota at which the tenant is notified, once per billing period, so there is time to upgrade or switch to their own key. "0" sends no warning; the notice when the quota runs out is sent either way.',
  },
] as const satisfies readonly PlatformSettingDef[];

export type PlatformSettingKey = (typeof PLATFORM_SETTINGS)[number]['key'];

const BY_KEY = new Map<string, PlatformSettingDef>(PLATFORM_SETTINGS.map((s) => [s.key, s]));

export function platformSettingDef(key: string): PlatformSettingDef | undefined {
  return BY_KEY.get(key);
}

export function isValidPlatformSetting(key: string, value: string): boolean {
  return BY_KEY.get(key)?.values.includes(value) ?? false;
}

export interface ResolvedPlatformSetting {
  key: string;
  value: string;
  source: 'database' | 'environment' | 'default';
}

/**
 * DB, then env, then default. Invalid env values are ignored rather than thrown, since this runs on
 * the review path; console writes are validated strictly.
 */
export function resolvePlatformSetting(
  key: string,
  fromDb: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPlatformSetting {
  const def = BY_KEY.get(key);
  if (!def) return { key, value: '', source: 'default' };
  if (fromDb !== undefined && def.values.includes(fromDb)) return { key, value: fromDb, source: 'database' };
  const fromEnv = env[def.env]?.trim().toLowerCase();
  if (fromEnv && def.values.includes(fromEnv)) return { key, value: fromEnv, source: 'environment' };
  return { key, value: def.values[0]!, source: 'default' };
}

export function resolveAllPlatformSettings(
  fromDb: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPlatformSetting[] {
  return PLATFORM_SETTINGS.map((s) => resolvePlatformSetting(s.key, fromDb.get(s.key), env));
}
