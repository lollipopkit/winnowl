/**
 * Gold dataset eval: for merged PRs, groups CodeRabbit gold by `original_commit_id` and runs
 * `produceReview` (no publish) on each reviewed commit, then feeds computeMetrics/checkThresholds.
 * Per-commit because issues fixed later in the PR are absent from the final head, so reviewing the
 * head would count true negatives as misses.
 *
 * Usage (needs `gh auth login` and LLM_* in the root .env):
 *   pnpm eval:gold:run [repo] <prNumber...>
 *   pnpm eval:gold:run lollipopkit/flutter_server_box 1229 1220 1200
 *
 * Read-only: gh api + a temporary clone.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { resolveModelSourceFromEnv } from '@reviewbot/agent-pi';
import {
  checkThresholds,
  computeMetrics,
  goldFromReviewComments,
  groupCodeRabbitCommentsByCommit,
  type CaseResult,
  type EvalFinding,
  type GhReviewComment,
} from '@reviewbot/eval';
import { runGit } from '@reviewbot/git-repository';
import { uuidv7 } from '@reviewbot/ids';
import { loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import { ReviewIncompleteError, coerceCategory, produceReview, type ReviewOrchestratorDeps } from '@reviewbot/review-orchestrator';
import { resolveProfile } from '@reviewbot/review-profile';
import { cloneRepository, collectPatches, prepareWorkspace } from '@reviewbot/review-runtime';
import { loadEnv } from './load-env.js';

loadEnv();

function gh<T>(path: string): T {
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as T;
}

interface PrDetail {
  number: number;
  merged: boolean;
  base: { sha: string };
}

async function main(): Promise<void> {
  const repo = process.argv[2] ?? 'lollipopkit/flutter_server_box';
  const prNumbers = process.argv.slice(3).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (prNumbers.length === 0) {
    throw new Error('用法: pnpm eval:gold:run <repo> <prNumber...>(至少指定一个已合并 PR 号)');
  }

  const modelSource = resolveModelSourceFromEnv();
  if (!modelSource) {
    throw new Error('无法解析模型来源 —— 检查 .env 的 LLM_PROVIDER/LLM_MODEL/LLM_BASE_URL/LLM_API_KEY/LLM_ALLOWED_BASE_URLS');
  }

  const loaded = await loadPromptBundles(['mapper', 'reviewer', 'synthesizer', 'verifier', 'refuter']);
  const bundles = {
    mapper: loaded.mapper as PromptBundle,
    reviewer: loaded.reviewer as PromptBundle,
    synthesizer: loaded.synthesizer as PromptBundle,
    verifier: loaded.verifier as PromptBundle,
    refuter: loaded.refuter as PromptBundle,
  };
  const budget = resolveProfile('balanced').exploreBudget;

  const cloneRoot = await mkdtemp(join(tmpdir(), 'gold-eval-'));
  const gitDir = join(cloneRoot, 'repo');
  console.log(`# Gold dataset 真实评估 —— ${repo}(只读 clone,不写回)\n`);
  console.log(`克隆 ${repo} → ${gitDir} ...`);
  await cloneRepository(`https://github.com/${repo}.git`, gitDir);

  const results: CaseResult[] = [];
  const skippedNoGold: number[] = [];
  const skippedUnreachable: { label: string; reason: string }[] = [];
  const skippedIncomplete: { label: string; reason: string }[] = [];

  for (const n of prNumbers) {
    console.log(`\n=== PR #${n} ===`);
    const pr = gh<PrDetail>(`repos/${repo}/pulls/${n}`);
    if (!pr.merged) {
      console.log('未合并,跳过');
      continue;
    }

    const comments = gh<GhReviewComment[]>(`repos/${repo}/pulls/${n}/comments?per_page=100`);
    // key '' = comments without a commit; they cannot be located and are skipped.
    const groups = [...groupCodeRabbitCommentsByCommit(comments)].filter(([sha]) => sha !== '');
    if (groups.length === 0) {
      console.log('无可定位 commit 的 CodeRabbit 评论,跳过');
      skippedNoGold.push(n);
      continue;
    }

    // GitHub keeps this ref after merge, and its ancestry holds every intermediate commit.
    await runGit(gitDir, ['fetch', 'origin', `pull/${n}/head`]);

    for (const [commitSha, groupComments] of groups) {
      const gold = goldFromReviewComments(groupComments);
      const short = commitSha.slice(0, 7);
      if (gold.length === 0) {
        console.log(`\n--- PR #${n} 评审轮 ${short}:${groupComments.length} 条评论均无可识别 gold 信号,跳过 ---`);
        continue;
      }
      const label = `${n}@${short}`;
      console.log(`\n--- PR #${n} 评审轮 ${short}(gold=${gold.length} 条)---`);

      const headWorktreeDir = join(cloneRoot, `head-${n}-${short}`);
      let ws: Awaited<ReturnType<typeof prepareWorkspace>>;
      try {
        ws = await prepareWorkspace({ gitDir, baseSha: pr.base.sha, headSha: commitSha, headWorktreeDir });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.log(`该轮 commit 本地不可达(可能被 force-push 覆盖),跳过:${reason}`);
        skippedUnreachable.push({ label, reason });
        continue;
      }
      try {
        const deps: ReviewOrchestratorDeps = {
          source: ws.source,
          model: modelSource.model,
          streamFn: modelSource.streamFn,
          bundles,
          budget,
          newId: () => uuidv7(),
          isChangedLine: ws.isChangedLine,
          readHeadLines: ws.readHeadLines,
          filePatches: collectPatches(ws.readPatch, ws.changedFiles.map((f) => f.path)),
          // Publish-only fields; produceReview never touches them.
          noiseBudget: { maxInlineComments: Number.MAX_SAFE_INTEGER, maxInlinePerFile: Number.MAX_SAFE_INTEGER, maxInlineNits: Number.MAX_SAFE_INTEGER },
          publishContext: {} as ReviewOrchestratorDeps['publishContext'],
          publishTarget: {
            tenantId: '',
            repositoryId: '',
            changeRequest: { id: '', repositoryId: '', nativeId: '', number: n, kind: 'pull-request' },
            changeRequestId: '',
            revisionId: '',
            revisionSha: commitSha,
            providerHostId: '',
            expectedHeadSha: commitSha,
          },
        };

        const produced = await produceReview(deps);
        // Only confirmed findings count. Raw LLM categories must be coerced or matchFinding never matches.
        const publishable = produced.staged.filter((s) => s.decision.status === 'confirmed');
        const producedFindings: EvalFinding[] = publishable.map((s) => ({
          category: coerceCategory(s.candidate.category),
          severity: s.verdict.severity,
          path: s.candidate.path,
        }));

        results.push({ caseId: `${repo}#${label}`, expected: gold, produced: producedFindings });
        console.log(`gold=${gold.length} 条,produced(通过 verify 且判定发布)=${producedFindings.length} 条`);
        console.log('  gold:', JSON.stringify(gold));
        console.log(
          '  produced:',
          JSON.stringify(
            publishable.map((s) => ({
              path: s.candidate.path,
              category: coerceCategory(s.candidate.category),
              rawCategory: s.candidate.category,
              severity: s.verdict.severity,
              claim: s.candidate.claim.slice(0, 80),
            })),
          ),
        );
      } catch (e) {
        if (e instanceof ReviewIncompleteError) {
          console.log(`探索未完成(网关/模型故障,不计入指标):${e.message}`);
          skippedIncomplete.push({ label, reason: e.message });
        } else {
          throw e;
        }
      } finally {
        await ws.cleanup();
      }
    }
  }

  await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);

  console.log(`\n无可定位 commit 的 gold 跳过(整个 PR):${skippedNoGold.join(',') || '无'}`);
  console.log(`评审轮 commit 本地不可达跳过:${skippedUnreachable.map((s) => s.label).join(',') || '无'}`);
  console.log(`探索未完成跳过(不计入指标):${skippedIncomplete.map((s) => s.label).join(',') || '无'}`);

  if (results.length === 0) {
    console.log('\n无可比对样本(全部跳过),未计算指标。');
    return;
  }

  const metrics = computeMetrics(results);
  console.log('\n=== §45.5 指标(precision/recall/FP,按严重度)===');
  console.log(JSON.stringify(metrics, null, 2));

  const check = checkThresholds(metrics);
  console.log('\n=== §45.7 发布门槛(FP 阈值部分;anchor/重复发布/sandbox/contract/按类别 recall 未在此驱动脚本内收集)===');
  console.log(JSON.stringify(check, null, 2));

  // Machine-readable line: merge CaseResults across parallel batches before computeMetrics (metrics do not average).
  console.log('\n=== RAW_CASE_RESULTS_JSON ===');
  console.log(JSON.stringify(results));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
