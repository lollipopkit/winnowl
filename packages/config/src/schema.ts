import { z } from 'zod';

/**
 * `.winnowl.yaml` schema. Every object is `.strict()`, `parse({})` yields the full default config, and
 * every field has an English `.describe()` that feeds both the JSON Schema and the console docs.
 */

const confirmationLevel = z.enum(['hypothesis', 'code-supported', 'independently-verified', 'tool-confirmed']);

const severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const autoReviews = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe(
        'Review pull requests automatically. Turning this off also disables manual `@winnowl review`.',
      ),
    drafts: z.boolean().default(false).describe('Also review draft pull requests.'),
    base_branches: z
      .array(z.string())
      .default([])
      .describe(
        'Only review pull requests targeting these base branches. Entries are globs (`release/*`; `**` matches any branch). Empty = the repository’s default branch, as set on the forge.',
      ),
    ignore_authors: z
      .array(z.string())
      .default([])
      .describe('Skip pull requests opened by these accounts (e.g. other bots).'),
    ignore_bot_authors: z
      .boolean()
      .default(true)
      .describe(
        'Skip pull requests opened by a bot. On by default: a review of a bot’s pull request usually reviews generated output nobody is going to change, and it costs the same as a review of hand-written code. Turn it off to review dependency bumps and the like. This does not affect an explicit `@winnowl review`, and the bot never auto-reviews its own pull requests regardless — that loops.',
      ),
    required_labels: z
      .array(z.string())
      .default([])
      .describe('If set, only review pull requests carrying at least one of these labels.'),
    pause_after_reviewed_commits: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Stop re-reviewing after this many reviewed commits on one pull request. 0 = no limit.',
      ),
    max_changed_files: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Skip automatic review entirely when a pull request has more files to review than this. Files excluded by `ignored_paths`, generated or vendored files (`skip_generated`) and deleted files are not counted. Manual `@winnowl review` bypasses it. 0 = no limit (large pull requests are reviewed in rounds, see `reviews.files_per_round`).',
      ),
  })
  .strict()
  .default({});

const reviewScope = z
  .object({
    analyze_related_code: z
      .boolean()
      .default(true)
      .describe('Read unchanged code the change depends on, instead of only the diff.'),
    analyze_preexisting_relevant: z
      .boolean()
      .default(true)
      .describe('Report existing problems that the change makes reachable or worse.'),
    report_preexisting_unrelated: z
      .enum(['summary', 'issue', 'off'])
      .default('summary')
      .describe(
        'What to do with existing problems unrelated to the change: fold into the summary, open an issue, or drop them.',
      ),
    auto_issue_preexisting: z
      .boolean()
      .default(false)
      .describe('Open issues for unrelated existing problems without asking.'),
    max_dependency_depth: z
      .number()
      .int()
      .min(0)
      .max(16)
      .default(4)
      .describe('How many levels of callers/callees to follow when reading related code.'),
  })
  .strict()
  .default({});

const publication = z
  .object({
    // No schema defaults for the inline quotas: unset must stay distinguishable from an explicit
    // value so the review profile's quotas apply unless the user overrides them.
    max_inline_comments: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Maximum inline comments posted per review. The rest fold into the summary. 0 = no inline comments. Unset = follow the review profile.',
      ),
    max_inline_per_file: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Maximum inline comments on a single file. Unset = 3.'),
    max_inline_nitpicks: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Maximum inline nitpick comments per review, counted separately from max_inline_comments. Unset = follow the review profile.',
      ),
    summary_overflow: z
      .boolean()
      .default(true)
      .describe(
        'List findings that exceeded the inline budget in the summary instead of dropping them.',
      ),
    min_confirmation: confirmationLevel
      .default('independently-verified')
      .describe('Minimum evidence level a finding must reach to be posted inline.'),
    show_unverified_risks: z
      .boolean()
      .default(true)
      .describe('Include high-impact risks that could not be confirmed, in a folded section.'),
    show_suppressed_details: z
      .boolean()
      .default(false)
      .describe('Include what was suppressed or deduplicated, for auditing the noise filter.'),
    committable_suggestions: z
      .boolean()
      .default(true)
      .describe(
        'Attach one-click committable suggestions to inline comments when the replacement is verified against the current lines.',
      ),
    committable_suggestion_max_lines: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe(
        'Largest replacement a committable suggestion may span. Bigger changes go through `@winnowl fix` instead.',
      ),
  })
  .strict()
  .default({});

const reviews = z
  .object({
    auto: autoReviews,
    profile: z
      .enum(['conservative', 'balanced', 'thorough'])
      .default('balanced')
      .describe('How much to spend per review and how aggressively to suppress low-value findings.'),
    scope: reviewScope,
    publication,
    auto_approve: z
      .boolean()
      .default(true)
      .describe('Approve the pull request when nothing blocking was found.'),
    block_preexisting: z
      .boolean()
      .default(false)
      .describe(
        'Let problems that this change did not introduce block as well. Off by default: pre-existing problems are reported but never block.',
      ),
    dependency_gate: z
      .enum(['critical', 'high', 'off'])
      .default('high')
      .describe(
        'Severity at which a newly introduced dependency advisory blocks. Pre-existing advisories are reported but never block.',
      ),
    reviewers: z
      .object({
        mode: z
          .enum(['off', 'suggest', 'request'])
          // Requesting reviewers writes to someone else's pull request; repositories opt in.
          .default('suggest')
          .describe(
            '`suggest` lists suggested reviewers in the status comment; `request` also requests them on the pull request, once, and only when it has no reviewers yet; `off` does neither.',
          ),
        max: z.number().int().min(1).max(5).default(2).describe('How many reviewers to suggest or request.'),
      })
      .strict()
      .default({})
      .describe(
        'Suggest reviewers from the people who most recently changed the files this pull request touches. The author, bots and accounts without write access are never suggested.',
      ),
    skip_generated: z
      .boolean()
      .default(true)
      .describe(
        'Do not review generated, vendored or binary files: those marked `linguist-generated` / `linguist-vendored` in the base branch `.gitattributes`, lockfiles, well-known generator outputs (`*.g.dart`, `*.pb.go`, `generated/`, `vendor/`) and files whose header says they are generated. Skipped files are listed in the summary.',
      ),
    files_per_round: z
      .number()
      .int()
      .min(0)
      .default(300)
      .describe(
        'Review at most this many files per round. Larger pull requests are reviewed in rounds: the next push, or the checkbox in the status comment, continues with the files not yet reviewed, and the pull request is not approved until every file has been reviewed. Counted after `ignored_paths` and `skip_generated`. 0 = review everything in one round.',
      ),
    ignored_paths: z
      .array(z.string())
      .default([
        '**/vendor/**',
        '**/dist/**',
        '**/*.min.js',
        '**/*.min.css',
        '**/*.map',
        '**/__snapshots__/**',
        '**/*.lock',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',
        '**/yarn.lock',
        '**/go.sum',
        '**/*.png',
        '**/*.jpg',
        '**/*.jpeg',
        '**/*.gif',
        '**/*.webp',
        '**/*.ico',
        '**/*.svg',
        '**/*.woff',
        '**/*.woff2',
        '**/*.ttf',
        '**/*.eot',
        '**/*.pdf',
      ])
      .describe(
        'Globs excluded from review entirely. Setting this replaces the default list rather than adding to it.',
      ),
  })
  .strict()
  .default({});

const pathInstruction = z
  .object({
    path: z.string().describe('Glob the instruction applies to, e.g. `src/api/**`.'),
    instructions: z
      .string()
      .describe('What reviewers should pay attention to in files matching the glob.'),
  })
  .strict();

const astInstruction = z
  .object({
    language: z.string().describe('Language the AST query is written for, e.g. `typescript`.'),
    query: z.string().describe('AST pattern that selects the code the instruction applies to.'),
    instructions: z.string().describe('What to check on the matched code.'),
  })
  .strict();

const instructions = z
  .object({
    paths: z
      .array(pathInstruction)
      .default([])
      .describe('Extra review instructions scoped by path.'),
    ast: z
      .array(astInstruction)
      .default([])
      .describe('Extra review instructions scoped by AST pattern.'),
  })
  .strict()
  .default({});

const tools = z
  .object({
    auto_detect: z
      .boolean()
      .default(true)
      .describe('Detect build, lint and test commands from the repository.'),
    commands: z
      .object({
        setup: z
          .array(z.string())
          .default([])
          .describe('Commands that install dependencies before anything else runs.'),
        build: z.array(z.string()).default([]).describe('Build commands.'),
        lint: z.array(z.string()).default([]).describe('Lint commands.'),
        test: z.array(z.string()).default([]).describe('Test commands.'),
      })
      .strict()
      .default({})
      .describe('Explicit commands. They win over anything auto-detected.'),
    enabled: z.array(z.string()).default([]).describe('Analyzers to force on.'),
    disabled: z.array(z.string()).default([]).describe('Analyzers to force off.'),
  })
  .strict()
  .default({});

const sandboxNetwork = z
  .object({
    // No default: unset means the platform decides; any default would read as the repository's own
    // choice and override the platform's network policy.
    mode: z
      .enum(['none', 'package-registry-only', 'allowlist', 'full'])
      .optional()
      .describe(
        'Network access for commands run against your code. Can only tighten what the platform allows (package registries); unset leaves it to the platform.',
      ),
    ecosystems: z
      .array(z.string())
      .default([])
      .describe(
        'Package ecosystems allowed to reach their registries when mode is `package-registry-only`.',
      ),
    hosts: z.array(z.string()).default([]).describe('Hosts allowed when mode is `allowlist`.'),
    ports: z
      .array(z.number().int().min(1).max(65535))
      .default([])
      .describe('Ports allowed when mode is `allowlist`.'),
  })
  .strict()
  .default({});

const sandbox = z
  .object({
    runner: z
      .enum(['platform', 'actions'])
      .default('platform')
      .describe(
        'Where reviews run: on the platform, or in this repository\'s GitHub Actions (needs the winnowl workflow; never falls back to the platform).',
      ),
    labels: z
      .array(z.string())
      .default([])
      .describe('Runner labels required to pick up this repository.'),
    network: sandboxNetwork,
    // No defaults either: a value here caps what the platform grants, so only a value the
    // repository wrote may do that.
    resources: z
      .object({
        cpu: z.number().int().min(1).optional().describe('CPU cores (at most).'),
        memory_mb: z.number().int().min(256).optional().describe('Memory in MB (at most).'),
        disk_mb: z.number().int().min(256).optional().describe('Disk in MB (at most).'),
        timeout_seconds: z.number().int().min(1).optional().describe('Wall-clock limit for a single run (at most).'),
      })
      .strict()
      .default({})
      .describe('Caps on the isolated environment your commands run in; unset leaves each to the platform.'),
    secrets: z
      .array(z.string())
      .default([])
      .describe(
        'Names of stored secrets exposed to commands. Values live in the console, never in this file.',
      ),
  })
  .strict()
  .default({});

const chat = z
  .object({
    enabled: z.boolean().default(true).describe('Respond to comments on pull requests and issues.'),
    require_mention: z
      .boolean()
      .default(true)
      .describe('Only respond when the comment mentions the bot.'),
    allow_run_command: z
      .boolean()
      .default(true)
      .describe(
        '`run <command>` runs a shell command (build, lint, test, …) in a sandbox on the pull request head and posts the output. People with write access or above can use it; the command is reviewed before it runs.',
      ),
  })
  .strict()
  .default({});

const actions = z
  .object({
    // `require_confirmation=false` is a standing admin authorisation (only admins can change config);
    // writes still go only to bot-namespace stacked branches, and merge/approve stay forbidden.
    autofix: z
      .object({
        enabled: z.boolean().default(true).describe('Allow `@winnowl fix` to produce fixes.'),
        require_confirmation: z
          .boolean()
          .default(true)
          .describe(
            'Require a human to confirm before a fix is executed. Setting false pre-authorizes the repository.',
          ),
        delivery: z
          .array(z.enum(['artifact', 'stacked-change-request']))
          .default(['artifact', 'stacked-change-request'])
          .describe(
            'How fixes may be delivered: as a downloadable patch, or as a separate pull request. Your branch is never written to either way.',
          ),
      })
      .strict()
      .default({}),
    create_issue: z
      .object({
        enabled: z.boolean().default(true).describe('Allow the bot to open issues.'),
        require_confirmation: z
          .boolean()
          .default(true)
          .describe('Require a human to confirm before an issue is opened.'),
      })
      .strict()
      .default({}),
    post_merge: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe('Run follow-up work after a pull request merges.'),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

const knowledge = z
  .object({
    repository_docs: z
      .boolean()
      .default(true)
      .describe(
        'Use the repository’s AGENTS.md / CLAUDE.md (root, and those in directories the change touches) as background on its conventions. They are read from the target branch, so edits to them in a pull request take effect after it merges.',
      ),
    historical_prs: z.boolean().default(true).describe('Use past pull requests as review context.'),
    learnings: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Carry decisions made in review into later reviews.'),
        require_repo_admin_approval: z
          .boolean()
          .default(true)
          .describe(
            'Rules proposed in comments by people without admin or maintain access wait for approval. Off: every repository rule proposed in a comment applies at once — on a public repository anyone who can comment then shapes later reviews. Organization rules and rules drafted by the bot always need approval.',
          ),
        auto_propose: z
          .boolean()
          .default(true)
          .describe(
            'Draft rule proposals once the same feedback repeats. Proposals still need approval.',
          ),
        auto_propose_threshold: z
          .number()
          .int()
          .min(1)
          .default(3)
          .describe('How many times feedback must repeat before a rule is proposed.'),
        auto_propose_from_review: z
          .boolean()
          .default(true)
          .describe('Also draft rule proposals from review results. Uses quota.'),
      })
      .strict()
      .default({}),
    memory: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe(
            'Keep working notes about this repository, drafted from reviews and from comments addressed to the bot. Notes are hints, not rules. Uses quota.',
          ),
        require_approval: z
          .boolean()
          .default(true)
          .describe(
            'Notes drafted from comments by people without admin or maintain access wait for approval in the inbox. Off: they apply at once.',
          ),
      })
      .strict()
      .default({}),
    related_repositories: z
      .array(z.string())
      .default([])
      .describe('Repositories whose contracts this one depends on.'),
  })
  .strict()
  .default({});

/**
 * Platform-vetted agent tool plugins. `enabled` is a lattice field (merge.ts): an explicit false at
 * any layer wins. Plugins without platform credentials are silently not loaded.
 */
const plugins = z
  .object({
    /** Endpoint is fixed to api.exa.ai and not configurable. */
    exa: z
      .object({
        enabled: z.boolean().default(true).describe('Allow web search as review evidence.'),
      })
      .strict()
      .default({}),
    /** Endpoint is fixed to context7.com and not configurable. */
    context7: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Allow official library documentation lookup as review evidence.'),
      })
      .strict()
      .default({}),
    /** Official package registries only; fixed endpoints, no key. */
    registry: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Allow package registry lookups (versions, metadata) as review evidence.'),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

const mergeGate = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Also fail the review check run while a blocking finding stands, so branch protection can hold the merge. The review itself always requests changes for blocking findings, whether or not this is on.',
      ),
    block_on_severity: severity
      .array()
      .default(['critical', 'high'])
      .describe(
        'Severities that must be fixed before merging (critical and high are shown as Critical and Major, medium as Minor). A confirmed finding at one of these severities, caused by this change, makes the review request changes. Medium findings are reported without blocking unless listed here; low (Trivial) findings are nitpicks and never block.',
      ),
    // Must be a level findings can actually reach, else no finding ever blocks; keep in sync with
    // DEFAULT_GATE in review-checks.ts.
    minimum_confirmation: confirmationLevel
      .default('independently-verified')
      .describe('Evidence level a finding must reach before it is allowed to block.'),
    require_review_complete: z
      .boolean()
      .default(false)
      .describe('Block while a review is still running or ended incomplete.'),
  })
  .strict()
  .default({});

const privacy = z
  .object({
    artifact_retention_days: z
      .number()
      .int()
      .min(0)
      .default(30)
      .describe('Days to keep produced artifacts (patches, logs). 0 = delete immediately.'),
    transcript_retention_days: z
      .number()
      .int()
      .min(0)
      .default(30)
      .describe('Days to keep review transcripts. 0 = delete immediately.'),
    allow_external_model_provider: z
      .boolean()
      .default(true)
      .describe(
        'Allow reviews to use an external model provider. Turn off to require a self-hosted one.',
      ),
  })
  .strict()
  .default({});

/** Cross-repo analysis, configured on the producer repo. Off by default: it uses quota and opens issues in consumers. */
const crossRepo = z
  .object({
    analyze: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            'When this repository’s contracts change, analyze the impact on dependent repositories and open issues there. Uses quota.',
          ),
      })
      .strict()
      .default({}),
  })
  .strict()
  .default({});

export const repositoryConfigSchema = z
  .object({
    version: z.literal(1).default(1).describe('Config format version. Always 1.'),
    language: z
      .string()
      .default('en')
      .describe(
        'Language for review output (`en`, `zh`, `zh-Hant`, `ja`, `ko`, `es`, `fr`, `de`, `pt`, `ru`). Common regional aliases are canonicalized; unknown values fall back to English.',
      ),
    reviews,
    instructions,
    tools,
    sandbox,
    chat,
    actions,
    knowledge,
    plugins,
    merge_gate: mergeGate,
    privacy,
    cross_repo: crossRepo,
  })
  .strict();

export type EffectiveRepositoryConfig = z.infer<typeof repositoryConfigSchema>;
