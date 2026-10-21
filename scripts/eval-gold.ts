/**
 * Builds a gold dataset from CodeRabbit review comments on a public repo's PRs. Read-only (`gh api`).
 *
 * Usage (needs `gh auth login`):
 *   pnpm eval:gold [repo] [maxPrs]
 *   pnpm eval:gold lollipopkit/flutter_server_box 30
 */
import { execFileSync } from 'node:child_process';
import { goldFromReviewComments, type GhReviewComment, type EvalFinding } from '@reviewbot/eval';

const repo = process.argv[2] ?? 'lollipopkit/flutter_server_box';
const maxPrs = Number(process.argv[3] ?? 30);

function gh<T>(path: string): T {
  const out = execFileSync('gh', ['api', path, '--paginate'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // gh --paginate emits one JSON array per page, newline-separated.
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => JSON.parse(line) as T[]) as unknown as T;
}

interface Pr { number: number; merged_at: string | null }

function main(): void {
  console.log(`# Gold dataset — ${repo}(只读;绝不写回)\n`);
  const prs = gh<Pr[]>(`repos/${repo}/pulls?state=closed&per_page=100`).filter((p) => p.merged_at).slice(0, maxPrs);
  console.log(`已 merge PR 采样:${prs.length}\n`);

  const perPr: { pr: number; gold: EvalFinding[] }[] = [];
  for (const pr of prs) {
    let comments: GhReviewComment[] = [];
    try {
      comments = gh<GhReviewComment[]>(`repos/${repo}/pulls/${pr.number}/comments?per_page=100`);
    } catch {
      continue;
    }
    const gold = goldFromReviewComments(comments);
    if (gold.length > 0) perPr.push({ pr: pr.number, gold });
  }

  const all = perPr.flatMap((p) => p.gold);
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const f of all) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }

  console.log(`gold findings 总数:${all.length}(含 CodeRabbit 评论的 PR:${perPr.length})`);
  console.log(`按类别:${JSON.stringify(byCategory)}`);
  console.log(`按严重度:${JSON.stringify(bySeverity)}\n`);
  console.log('下一步(需 LLM 预算):对每 PR 的 diff 跑本仓 review → computeMetrics/checkThresholds → §45 阈值报告。');
  console.log('gold 明细(JSON,可存本地报告):');
  console.log(JSON.stringify(perPr, null, 2));
}

main();
