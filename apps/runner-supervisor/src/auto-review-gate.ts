import type { EffectiveRepositoryConfig } from '@reviewbot/config';
import { botMention, isOwnBotLogin } from '@reviewbot/domain';
import { matchesGlob } from '@reviewbot/knowledge';
import { partitionIgnoredPaths, skipReasonByPath } from '@reviewbot/review-runtime';
import type { AutoReviewSkip } from './status-comment.js';

/**
 * Per-repo `reviews.auto` gate, decided before clone. Returns the skip reason (logged only) and whether
 * to post a status comment. Manual triggers (command / status-comment checkbox) bypass the auto-only
 * checks (draft, target branch, bot author, pause, label); `enabled=false` and `ignore_authors` still apply.
 */
export interface AutoReviewGateInput {
  state: string;
  draft: boolean;
  author: string | null;
  authorIsBot: boolean;
  paused: boolean;
  targetBranch: string | null;
  /** Target branch of the stack root; a mid-stack target is an implementation detail. */
  effectiveBaseBranch: string | null;
  /** The forge's default branch; with empty `base_branches` only PRs into it are reviewed. */
  defaultBranch: string;
  labels: readonly string[];
  auto: EffectiveRepositoryConfig['reviews']['auto'];
  isManual: boolean;
}

export function autoReviewSkip(input: AutoReviewGateInput): { log: string; status?: AutoReviewSkip } | null {
  const { auto, isManual, author } = input;
  // A PR closed or merged while queued no longer needs a review. The manual path already replied in the
  // conversation; skip silently here, since commenting on a closed PR is noise.
  if (input.state !== 'open') return { log: `change request 已${input.state}` };
  if (!auto.enabled) return { log: 'reviews.auto.enabled=false' };
  // Draft only blocks automatic reviews; an explicit request on a draft is the earliest useful review.
  if (!isManual && input.draft && !auto.drafts) {
    return { log: 'draft PR 且 reviews.auto.drafts=false', status: { code: 'draft' } };
  }
  if (!isManual && input.effectiveBaseBranch && !matchesBaseBranch(auto.base_branches, input.effectiveBaseBranch, input.defaultBranch)) {
    const stackNote =
      input.effectiveBaseBranch === input.targetBranch ? '' : `(stack 根,本 PR 直接 base 为 ${input.targetBranch})`;
    return {
      log: `target 分支 ${input.effectiveBaseBranch}${stackNote} 不在 reviews.auto.base_branches(空=默认分支 ${input.defaultBranch})`,
      status: {
        code: 'base-branch',
        branch: input.effectiveBaseBranch,
        ...(auto.base_branches.length === 0 ? { defaultBranch: input.defaultBranch } : {}),
      },
    };
  }
  /*
   * Unknown author: no automatic review. The row can exist before the author arrives (GitHub's opened event
   * can come late), and ignore_authors and the bot-author checks below would otherwise pass silently.
   * Manual requests are unaffected.
   */
  if (!isManual && !author) return { log: '作者尚未登记(等 opened),暂不自动评审' };
  if (auto.ignore_authors.length > 0 && author && auto.ignore_authors.includes(author)) {
    return { log: `作者 ${author} 在 reviews.auto.ignore_authors` };
  }
  /*
   * Our own PRs are never reviewed automatically, regardless of config: bot PRs (post-merge, stacked fix)
   * could lead to more bot PRs in a paid loop, e.g. if someone turns off `ignore_bot_authors` for dependabot.
   * Manual review stays available; a human in the loop breaks the cycle.
   */
  if (!isManual && author && isOwnBotLogin(author)) {
    return { log: `${author} 是 bot 自己开的 PR(自动 review 恒跳过,防自我循环;${botMention()} review 仍可手动触发)` };
  }
  /*
   * Third-party bot PRs (dependabot, renovate, ...) are skipped by default, configurable. Uses the forge's
   * `author_is_bot`, falling back to the GitHub `<name>[bot]` suffix when null; undecidable counts as human.
   */
  if (!isManual && auto.ignore_bot_authors && author && input.authorIsBot) {
    return { log: `作者 ${author} 是 bot(reviews.auto.ignore_bot_authors 默认开;设 false 可评审依赖更新这类 PR)` };
  }
  if (!isManual && input.paused) {
    return { log: '本 CR 已被 `@bot pause` 暂停自动 review(`@bot resume` 恢复;manual 恒可用)', status: { code: 'paused' } };
  }
  if (
    !isManual &&
    auto.required_labels.length > 0 &&
    !auto.required_labels.some((l) => input.labels.includes(l))
  ) {
    return {
      log: `PR label 未命中 reviews.auto.required_labels(需至少一个:${auto.required_labels.join(', ')})`,
      status: { code: 'labels', required: auto.required_labels },
    };
  }
  return null;
}

/** Empty `base_branches`: the default branch only; entries are globs (`release/*`, `**` = any branch). */
export function matchesBaseBranch(baseBranches: readonly string[], branch: string, defaultBranch: string): boolean {
  if (baseBranches.length === 0) return branch === defaultBranch;
  return baseBranches.some((glob) => matchesGlob(glob, branch));
}

/**
 * `max_changed_files` counts reviewable files only: `ignored_paths` and path-detectable generated / vendored
 * files (`skip_generated`) are excluded, since lockfiles and `*.g.dart` can number in the hundreds.
 * Without a clone, header markers and base `.gitattributes` are unknown, so those files still count.
 */
export function countReviewablePaths(
  paths: readonly string[],
  reviews: Pick<EffectiveRepositoryConfig['reviews'], 'ignored_paths' | 'skip_generated'>,
): number {
  const { kept } = partitionIgnoredPaths(
    paths.map((path) => ({ path, status: 'modified' })),
    reviews.ignored_paths,
  );
  return reviews.skip_generated ? kept.filter((f) => skipReasonByPath(f.path) === undefined).length : kept.length;
}
