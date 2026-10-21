import type { Db } from '@reviewbot/db';
import { runGit } from '@reviewbot/git-repository';

/**
 * Where repository instructions are read from, so a PR author cannot change the instructions used
 * to review that PR. A stacked PR's base is another unmerged PR, so it uses the stack root's target.
 */
export interface TrustedBaseInput {
  baseSha: string;
  /** Set only for stacked PRs. */
  stackRootBranch?: string;
}

/**
 * Fallback when the provider gives no native stack base (other forges, hand-made stacks).
 * Depth is capped at 10 to survive cycles in bad data.
 */
export async function resolveStackRootTargetBranch(
  db: Db,
  changeRequestId: string,
  ownTarget: string | null,
): Promise<string | null> {
  let currentId = changeRequestId;
  let target = ownTarget;
  for (let depth = 0; depth < 10; depth += 1) {
    const row = await db
      .selectFrom('change_requests')
      .select(['stacked_on_change_request_id'])
      .where('id', '=', currentId)
      .executeTakeFirst();
    const parentId = row?.stacked_on_change_request_id;
    if (!parentId) return target;
    const parent = await db
      .selectFrom('change_requests')
      .select(['id', 'target_branch'])
      .where('id', '=', parentId)
      .executeTakeFirst();
    if (!parent) return target;
    currentId = parent.id;
    target = parent.target_branch;
  }
  return target;
}

/** Undefined for a non-stacked PR; prefers the native `stack_base_ref`. */
export async function stackRootBranchOf(db: Db, changeRequestId: string): Promise<string | undefined> {
  const cr = await db
    .selectFrom('change_requests')
    .select(['stack_base_ref', 'stacked_on_change_request_id', 'target_branch'])
    .where('id', '=', changeRequestId)
    .executeTakeFirst();
  if (!cr) return undefined;
  if (cr.stack_base_ref) return cr.stack_base_ref;
  if (!cr.stacked_on_change_request_id) return undefined;
  return (await resolveStackRootTargetBranch(db, changeRequestId, cr.target_branch)) ?? undefined;
}

/** null when the stack root branch is missing: callers then read no repo instructions rather than the parent PR's. */
export async function resolveTrustedSha(gitDir: string, input: TrustedBaseInput): Promise<string | null> {
  if (input.stackRootBranch === undefined) return input.baseSha;
  // The refs/ prefix keeps the branch name from being parsed as an option.
  for (const ref of [`refs/remotes/origin/${input.stackRootBranch}`, `refs/heads/${input.stackRootBranch}`]) {
    try {
      const { stdout } = await runGit(gitDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      const sha = stdout.trim();
      if (sha) return sha;
    } catch {
      // try the next ref
    }
  }
  return null;
}
