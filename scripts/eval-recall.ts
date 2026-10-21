/**
 * Single-round recall eval: runs `produceReview` (no publish) on one commit and matches the output
 * against issues known to exist there, using the cross-review matcher (`createLlmFindingMatcher`).
 *
 * Usage (needs `gh auth login` and LLM_* in the root .env):
 *   pnpm eval:recall <repo> <prNumber> <commitSha> <gold.json> [trials]
 * gold.json: [{ "path": "...", "line": 123, "claim": "..." }] (line on that commit)
 * EVAL_SKILLS_EXCLUDE=a,b drops platform checklists; EVAL_FAST_MAP=1 forces the small-change path;
 * EVAL_ONLY_PATHS=a,b limits the evaluated files.
 *
 * Read-only: gh api + a temporary clone.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { resolveModelSourceFromEnv } from '@reviewbot/agent-pi';
import { runGit } from '@reviewbot/git-repository';
import { uuidv7 } from '@reviewbot/ids';
import { loadPlatformSkills, loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import { createLlmFindingMatcher, produceReview, type ReviewOrchestratorDeps } from '@reviewbot/review-orchestrator';
import { resolveProfile } from '@reviewbot/review-profile';
import {
  applyPathFilter,
  classifyNonReviewable,
  cloneRepository,
  plannedScopeFor,
  prepareWorkspace,
} from '@reviewbot/review-runtime';
import { loadEnv } from './load-env.js';

loadEnv();

interface Gold {
  path: string;
  line: number;
  claim: string;
  category?: string;
}

interface Reported {
  id: string;
  path: string;
  line?: number;
  category: string;
  claim: string;
  anchor: string;
  published: boolean;
  /** Why it was not published (verify verdict / publish decision). */
  why?: string;
}

function gh<T>(path: string): T {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as T;
}

function lineOf(content: string | null, anchorText: string | undefined): number | undefined {
  if (!content || !anchorText) return undefined;
  const first = anchorText.split('\n').find((l) => l.trim().length > 0)?.trim();
  if (!first) return undefined;
  const idx = content.split('\n').findIndex((l) => l.includes(first));
  return idx >= 0 ? idx + 1 : undefined;
}

async function main(): Promise<void> {
  const [repo, prArg, commitSha, goldPath, trialsArg] = process.argv.slice(2);
  if (!repo || !prArg || !commitSha || !goldPath) {
    throw new Error('用法: pnpm eval:recall <repo> <prNumber> <commitSha> <gold.json> [trials]');
  }
  const pr = Number(prArg);
  const trials = Number(trialsArg ?? 1);
  const gold = JSON.parse(readFileSync(goldPath, 'utf8')) as Gold[];
  const modelSource = resolveModelSourceFromEnv();
  if (!modelSource) throw new Error('无法解析模型来源 —— 检查 .env 的 LLM_*');

  const loaded = await loadPromptBundles(['mapper', 'reviewer', 'synthesizer', 'verifier', 'refuter']);
  const bundles = {
    mapper: loaded.mapper as PromptBundle,
    reviewer: loaded.reviewer as PromptBundle,
    synthesizer: loaded.synthesizer as PromptBundle,
    verifier: loaded.verifier as PromptBundle,
    refuter: loaded.refuter as PromptBundle,
  };
  const budget = resolveProfile('balanced').exploreBudget;
  const excluded = new Set((process.env.EVAL_SKILLS_EXCLUDE ?? '').split(',').filter(Boolean));
  const skills = (await loadPlatformSkills()).filter((s) => !excluded.has(s.name));
  console.log(`skills: ${skills.map((s) => s.name).join(', ')}`);
  const matcher = createLlmFindingMatcher({
    model: modelSource.model,
    streamFn: modelSource.streamFn,
    budget: { maxTurns: 2, maxToolCalls: 2 },
  });
  const baseSha = gh<{ base: { sha: string } }>(`repos/${repo}/pulls/${pr}`).base.sha;

  const cloneRoot = await mkdtemp(join(tmpdir(), 'recall-eval-'));
  const gitDir = join(cloneRoot, 'repo');
  await cloneRepository(`https://github.com/${repo}.git`, gitDir);
  await runGit(gitDir, ['fetch', 'origin', `pull/${pr}/head`]);

  const summary: { trial: number; candidates: number; published: number; foundCandidates: number; foundPublished: number; ms: number }[] = [];
  try {
    for (let trial = 1; trial <= trials; trial += 1) {
      const ws = await prepareWorkspace({
        gitDir,
        baseSha,
        headSha: commitSha,
        headWorktreeDir: join(cloneRoot, `head-${trial}`),
      });
      const started = Date.now();
      try {
        // Same generated/binary/LFS split as live, without the repo's ignored_paths.
        const headDir = join(cloneRoot, `head-${trial}`);
        const only = process.env.EVAL_ONLY_PATHS?.split(',').filter(Boolean);
        const filtered = await applyPathFilter(ws, [], async (paths) => {
          const reasons = new Map(await classifyNonReviewable({ paths, headDir, gitDir, baseSha }));
          if (only) for (const p of paths) if (!only.includes(p) && !reasons.has(p)) reasons.set(p, 'generated');
          return reasons;
        });
        const lfsPointerPaths = filtered.ignoredFiles.flatMap((f) =>
          'reason' in f && f.reason === 'lfs-pointer' ? [f.path] : [],
        );
        console.log(`reviewing ${filtered.changedFiles.length} file(s); skipped ${filtered.ignoredFiles.length}: ${filtered.ignoredFiles.slice(0, 10).map((f) => f.path).join(', ')}`);
        const deps: ReviewOrchestratorDeps = {
          source: filtered.wsView.source,
          ...(lfsPointerPaths.length > 0 ? { lfsPointerPaths } : {}),
          ...(process.env.EVAL_LANGUAGE ? { language: process.env.EVAL_LANGUAGE } : {}),
          ...(process.env.EVAL_FAST_MAP === '1'
            ? { plannedScopes: [plannedScopeFor(filtered.changedFiles.map((f) => f.path))] }
            : {}),
          model: modelSource.model,
          streamFn: modelSource.streamFn,
          bundles,
          budget,
          newId: () => uuidv7(),
          isChangedLine: filtered.wsView.isChangedLine,
          readHeadLines: ws.readHeadLines,
          skills,
          noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
          publishContext: {} as ReviewOrchestratorDeps['publishContext'],
          publishTarget: {
            tenantId: '',
            repositoryId: '',
            changeRequest: { id: '', repositoryId: '', nativeId: '', number: pr, kind: 'pull-request' },
            changeRequestId: '',
            revisionId: '',
            revisionSha: commitSha,
            providerHostId: '',
            expectedHeadSha: commitSha,
          },
        };
        let produced: Awaited<ReturnType<typeof produceReview>>;
        try {
          produced = await produceReview(deps);
        } catch (e) {
          // An unfinished trial counts as finding nothing instead of voiding the set.
          console.log(`\n=== trial ${trial}: failed — ${(e as Error).message}`);
          summary.push({ trial, candidates: 0, published: 0, foundCandidates: 0, foundPublished: 0, ms: Date.now() - started });
          continue;
        }
        const stagedById = new Map(produced.staged.map((s) => [s.candidate.id, s]));
        const reported: Reported[] = [];
        for (const c of produced.ledger.candidates) {
          const staged = stagedById.get(c.id);
          const line = lineOf(await ws.source.readFile(c.path), c.primaryAnchorText);
          reported.push({
            id: c.id,
            path: c.path,
            ...(line !== undefined ? { line } : {}),
            category: c.category,
            claim: c.claim,
            anchor: c.primaryAnchorText ?? '',
            published: staged?.decision.status === 'confirmed',
            why: staged
              ? `${staged.verdict.decision ?? ''}/${staged.verdict.confirmation}/${staged.verdict.severity}${staged.refuterUpheld === false ? '/refuter-not-upheld' : ''}${staged.verdict.incompleteReason ? ` — not finished: ${staged.verdict.incompleteReason}` : ''}${staged.verdict.rationale ? ` — ${staged.verdict.rationale.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`
              : 'not staged (deduplicated or unverified)',
          });
        }
        const matched = await matcher(
          reported.map((r) => ({ id: r.id, category: r.category, claim: r.claim, path: r.path, codeWindow: r.anchor })),
          gold.map((g, i) => ({
            findingId: `g${i}`,
            category: g.category ?? 'correctness',
            claim: g.claim,
            fingerprint: `g${i}`,
            path: g.path,
          })),
        );
        const goldOf = (r: Reported) => matched.get(r.id)?.priorFindingId;
        const hits = (i: number, onlyPublished: boolean) =>
          reported.filter((r) => goldOf(r) === `g${i}` && (!onlyPublished || r.published));
        console.log(`\n=== trial ${trial}: ${reported.length} candidates, ${reported.filter((r) => r.published).length} published ===`);
        const outcomeOf = new Map(produced.ledger.scopeOutcomes.map((o) => [o.scopeId, o]));
        for (const scope of produced.ledger.scopes) {
          const o = outcomeOf.get(scope.id);
          const focus = scope.focus?.map((f) => `${f.path.split('/').pop()}:${f.startLine}-${f.endLine}`).join(' ') ?? '';
          console.log(`  scope ${o?.status ?? 'not run'} cands=${o?.candidateIds.length ?? 0} ${scope.title} ${focus}`);
        }
        for (const r of reported) {
          console.log(
            `  ${r.published ? '[pub]' : '[   ]'} ${goldOf(r) ?? '  '} ${r.path}:${r.line ?? '?'} ${r.claim.slice(0, 160)}${r.published ? '' : `  (${r.why})`}`,
          );
        }
        console.log('  gold:');
        gold.forEach((g, i) => {
          const tag = hits(i, true).length > 0 ? 'PUB ' : hits(i, false).length > 0 ? 'CAND' : '    ';
          console.log(`  ${tag} g${i} ${g.path}:${g.line} ${g.claim.slice(0, 120)}`);
        });
        summary.push({
          trial,
          candidates: reported.length,
          published: reported.filter((r) => r.published).length,
          foundCandidates: gold.filter((_g, i) => hits(i, false).length > 0).length,
          foundPublished: gold.filter((_g, i) => hits(i, true).length > 0).length,
          ms: Date.now() - started,
        });
      } finally {
        await ws.cleanup();
      }
    }
  } finally {
    await rm(cloneRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  console.log(`\n=== summary (gold=${gold.length}) ===`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
