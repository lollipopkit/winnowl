import { randomUUID } from 'node:crypto';
import type { Db } from '@reviewbot/db';
import { botMention, reviewTriggerCheckbox, type ChangeRequestRef } from '@reviewbot/domain';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { escapeStructural, publishTopLevelComment } from '@reviewbot/publisher';
import { runnerSetupMessage } from './executor-error.js';
import { loadEffectiveConfig } from '@reviewbot/review-runtime';
import { botMessages } from './locale.js';

/**
 * Status comment on the PR when config blocks an auto review: states the reason plus a checkbox that
 * triggers a review. One per PR (kind=status), rewritten in place. Only for reasons a person can
 * override (draft, too many files, paused, label, target branch); not for closed PRs, reviews disabled
 * or bot-authored PRs.
 */
export type AutoReviewSkip =
  | { code: 'draft' }
  | { code: 'too-many-files'; count: number; limit: number }
  | { code: 'paused' }
  | { code: 'pause-after'; count: number }
  | { code: 'labels'; required: readonly string[] }
  /** `defaultBranch` is only given when `base_branches` is empty (= repo default branch). */
  | { code: 'base-branch'; branch: string; defaultBranch?: string };

/** What the status comment reports after a review round (merge risk + walkthrough). */
export interface ReviewedSummary {
  headSha: string;
  /** Blocking items on the gate; `severe` = any critical / high. */
  blocking: { count: number; severe: boolean };
  nitpicks: number;
  /** Changes remain unreviewed after this round (unfinished, unclaimed, or deferred). */
  incomplete: boolean;
  /** Whether the result was posted as a review/comment; if not, do not say "see review". */
  resultsPosted: boolean;
  /**
   * Files reviewed / remaining. `deferred` = left for the next round by `reviews.files_per_round`;
   * `unfinished` = should have finished this round but did not (wall clock / cost gate / unclaimed).
   * They are worded differently so `unfinished` does not suggest a nonexistent limit. Remaining → "continue" checkbox.
   */
  files: { reviewed: number; deferred: number; unfinished: number };
  /** The next round for this head was started automatically (review-continue.ts); no checkbox then. */
  continuing?: boolean;
  walkthrough: { title: string; summary: string }[];
  /** Suggested reviewers (`requested` = requested on the PR this round); see review-reviewers.ts. */
  reviewers?: { logins: string[]; requested: boolean };
}

export interface StatusCommentTarget {
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
}

export interface StatusCommentDeps {
  db: Db;
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
}

const KIND = 'status';

function alert(title: string, lines: readonly string[]): string {
  return [`> [!IMPORTANT]`, `> **${title}**`, '>', ...lines.map((l) => (l ? `> ${l}` : '>'))].join('\n');
}

const inline = (text: string): string => escapeStructural(text).replace(/\s*\n\s*/g, ' ').trim();

export function createStatusComment(deps: StatusCommentDeps): {
  skipped: (target: StatusCommentTarget, skip: AutoReviewSkip) => Promise<void>;
  requested: (target: StatusCommentTarget, login: string) => Promise<void>;
  denied: (target: StatusCommentTarget, login: string) => Promise<void>;
  reviewing: (target: StatusCommentTarget) => Promise<void>;
  reviewed: (target: StatusCommentTarget, summary: ReviewedSummary) => Promise<void>;
  /** `error` picks the reason shown (runner setup); others get the generic text and a retry box. */
  failed: (target: StatusCommentTarget, error?: unknown) => Promise<void>;
} {
  /** `fresh`: rewrite even if unchanged; reposting is what resets a ticked checkbox. */
  async function publish(
    target: StatusCommentTarget,
    render: (m: ReturnType<typeof botMessages>['status'], all: ReturnType<typeof botMessages>) => string,
    fresh = false,
    mentions?: readonly string[],
  ) {
    const cr = await deps.db
      .selectFrom('change_requests as cr')
      .innerJoin('repositories as r', 'r.id', 'cr.repository_id')
      .select(['cr.native_id', 'cr.number', 'cr.kind', 'r.provider_host_id'])
      .where('cr.id', '=', target.changeRequestId)
      .where('cr.tenant_id', '=', target.tenantId)
      .executeTakeFirst();
    if (!cr) return;
    const changeRequest: ChangeRequestRef = {
      id: target.changeRequestId,
      repositoryId: target.repositoryId,
      nativeId: cr.native_id,
      number: cr.number,
      kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
    };
    const language = (await loadEffectiveConfig(deps.db, target.tenantId, target.repositoryId)).language;
    const provider = await deps.buildProvider(target.repositoryId);
    await publishTopLevelComment(
      { db: deps.db, discussions: provider.discussions, fetchCurrentHeadSha: async () => '' },
      {
        tenantId: target.tenantId,
        repositoryId: target.repositoryId,
        changeRequest,
        changeRequestId: target.changeRequestId,
        providerHostId: cr.provider_host_id,
        kind: KIND,
        bodyMarkdown: render(botMessages(language).status, botMessages(language)),
        ...(mentions ? { mentions } : {}),
        ...(fresh ? { fingerprint: randomUUID() } : {}),
      },
    );
  }

  const withTrigger = (m: ReturnType<typeof botMessages>['status'], head: string, label = m.trigger()) =>
    `${head}\n\n${reviewTriggerCheckbox(label)}\n\n${m.commandHint({ bot: botMention() })}`;

  return {
    skipped: (target, skip) =>
      publish(target, (m) => {
        const reason =
          skip.code === 'draft'
            ? m.draft()
            : skip.code === 'too-many-files'
              ? m.tooManyFiles({ count: skip.count, limit: skip.limit })
              : skip.code === 'paused'
                ? m.paused({ bot: botMention() })
                : skip.code === 'pause-after'
                  ? m.pauseAfter({ count: skip.count })
                  : skip.code === 'labels'
                    ? m.labels({ labels: skip.required.map((l) => `\`${l}\``).join(', ') })
                    : skip.defaultBranch !== undefined
                      ? m.notDefaultBranch({ branch: skip.branch, defaultBranch: skip.defaultBranch })
                      : m.baseBranch({ branch: skip.branch });
        return withTrigger(m, alert(m.skippedTitle(), [reason]));
      }),
    // The login is always the actor who ticked the box; a bare `@login` would only notify them about their own click.
    requested: (target, login) =>
      publish(target, (m) => alert(m.requestedTitle(), [m.requested({ login: `\`@${login}\`` })])),
    /* Posted at both start and end of a review, rewritten in place as it progresses. */
    reviewing: (target) => publish(target, (m) => alert(m.reviewingTitle(), [m.reviewing()])),
    reviewed: (target, s) =>
      publish(target, (m) => {
        const risk = s.blocking.count > 0
          ? s.blocking.severe
            ? m.riskHigh()
            : m.riskMedium()
          : s.incomplete
            ? m.riskUnknown()
            : m.riskLow();
        const reasons = [
          s.blocking.count > 0 ? m.riskBlocking({ count: s.blocking.count }) : m.riskNoBlocking(),
          ...(s.nitpicks > 0 ? [m.riskNits({ count: s.nitpicks })] : []),
          ...(s.incomplete ? [m.riskIncomplete()] : []),
        ];
        const remaining = s.files.deferred + s.files.unfinished;
        const partial = remaining > 0;
        // Once the next round runs on its own, the unfinished files are simply the next round's.
        const unfinished = s.files.unfinished > 0 && s.continuing !== true;
        const head = alert(!partial ? m.doneTitle() : unfinished ? m.unfinishedTitle() : m.partialTitle(), [
          !partial
            ? (s.resultsPosted ? m.done : m.doneQuiet)({ sha: s.headSha.slice(0, 7) })
            : (s.continuing ? m.continuing : unfinished ? m.unfinished : m.partial)({ reviewed: s.files.reviewed, remaining }),
          '',
          `**${m.mergeRisk()}:** ${risk} · ${reasons.join(' · ')}`,
          // Backticks: a bare `@login` notifies them, turning a suggestion into a request.
          ...(s.reviewers
            ? [
                '',
                `**${s.reviewers.requested ? m.requestedReviewers() : m.suggestedReviewers()}:** ${s.reviewers.logins.map((l) => `\`@${l}\``).join(', ')}`,
              ]
            : []),
        ]);
        // Model-written walkthrough is untrusted: escape structure and fold to one line so it cannot close the block or add headings.
        const walk =
          s.walkthrough.length > 0
            ? [
                '',
                // Blank line after the quote, or GitHub merges the details block into it.
                '',
                '<details>',
                `<summary>📝 ${m.walkthrough()}</summary>`,
                '',
                ...s.walkthrough.map((w) => `- **${inline(w.title)}**: ${inline(w.summary)}`),
                '',
                '</details>',
              ].join('\n')
            : '';
        if (partial && s.continuing) return `${head}${walk}`;
        return withTrigger(m, `${head}${walk}`, partial ? m.continueTrigger() : m.reviewAgain());
      }),
    /** Terminal failure: don't leave "reviewing" hanging; includes a retry checkbox. */
    // A runner-setup failure needs a change in the repository or a workflow re-run; the box would not help.
    failed: (target, error) =>
      publish(target, (m, all) => {
        const reason = runnerSetupMessage(all.runnerSetup, error);
        return reason ? alert(m.failedTitle(), [reason]) : withTrigger(m, alert(m.failedTitle(), [m.failedText()]));
      }),
    denied: (target, login) =>
      // Deliberate ping: the actor gets no other feedback that their request was refused.
      publish(target, (m) => withTrigger(m, alert(m.deniedTitle(), [m.denied({ login })])), true, [login]),
  };
}
