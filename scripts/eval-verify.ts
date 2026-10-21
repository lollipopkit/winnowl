/**
 * Verify precision eval: runs verifier + refuter (`verifyCandidate`) on labelled claims.
 * Labels: `real` = a reported issue on the commit it was reported on; `false` = the same claim on the
 * commit that fixed it, or a manually confirmed false positive. Labels are noisy; review disagreements.
 *
 * Usage (needs `gh auth login` and LLM_* in the root .env):
 *   pnpm eval:verify <repo> <prNumber> <cases.json> [runs]
 * cases.json: [{ commit, path, claim, anchor, category, severity, expected: 'real' | 'false' }]
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
import type { FindingCategory, Severity } from '@reviewbot/findings';
import { runGit } from '@reviewbot/git-repository';
import { loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import { resolveProfile } from '@reviewbot/review-profile';
import { cloneRepository, prepareWorkspace } from '@reviewbot/review-runtime';
import { verifyCandidate } from '@reviewbot/verification';
import { loadEnv } from './load-env.js';

loadEnv();

interface Case {
  commit: string;
  path: string;
  claim: string;
  anchor: string;
  category: string;
  severity: string;
  expected: 'real' | 'false';
  note?: string;
}

function gh<T>(path: string): T {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as T;
}

async function main(): Promise<void> {
  const [repo, prArg, casesPath, runsArg] = process.argv.slice(2);
  if (!repo || !prArg || !casesPath) throw new Error('用法: pnpm eval:verify <repo> <prNumber> <cases.json> [runs]');
  const pr = Number(prArg);
  const runs = Number(runsArg ?? 1);
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as Case[];
  const modelSource = resolveModelSourceFromEnv();
  if (!modelSource) throw new Error('无法解析模型来源 —— 检查 .env 的 LLM_*');
  const loaded = await loadPromptBundles(['verifier', 'refuter']);
  const bundles = { verifier: loaded.verifier as PromptBundle, refuter: loaded.refuter as PromptBundle };
  const budget = resolveProfile('balanced').exploreBudget;
  const baseSha = gh<{ base: { sha: string } }>(`repos/${repo}/pulls/${pr}`).base.sha;

  const root = await mkdtemp(join(tmpdir(), 'verify-eval-'));
  const gitDir = join(root, 'repo');
  await cloneRepository(`https://github.com/${repo}.git`, gitDir);
  await runGit(gitDir, ['fetch', 'origin', `pull/${pr}/head`]);

  const rows: { expected: string; accepted: number; runs: number; claim: string; commit: string }[] = [];
  try {
    for (const [i, c] of cases.entries()) {
      const ws = await prepareWorkspace({ gitDir, baseSha, headSha: c.commit, headWorktreeDir: join(root, `ws-${i}`) });
      let accepted = 0;
      let completed = 0;
      try {
        for (let r = 0; r < runs; r += 1) {
          const v = await verifyCandidate(
            { source: ws.source, model: modelSource.model, streamFn: modelSource.streamFn, bundles, budget },
            {
              id: `case-${i}-${r}`,
              claim: c.claim,
              category: c.category as FindingCategory,
              suspectedSeverity: c.severity as Severity,
              primaryAnchorText: c.anchor,
              changeRelationHypothesis: 'introduced',
              path: c.path,
            },
          );
          // Infrastructure failures are not verdicts; skip them.
          if (v.verdict.incomplete) {
            console.log(`[n/a] #${i} ${c.expected} @${c.commit.slice(0, 7)} → verifier did not finish (${v.verdict.incompleteReason ?? '?'})`);
            continue;
          }
          completed += 1;
          const ok = v.verdict.decision === 'accept';
          if (ok) accepted += 1;
          const tag = ok === (c.expected === 'real') ? 'ok ' : 'BAD';
          console.log(
            `[${tag}] #${i} ${c.expected} @${c.commit.slice(0, 7)} → ${v.verdict.decision}/${v.verdict.confirmation}${v.refutation ? ` refuter=${v.refutation.decision}` : ''}`,
          );
          console.log(`      claim: ${c.claim.slice(0, 140)}`);
          if (v.verdict.rationale) console.log(`      why: ${v.verdict.rationale.replace(/\s+/g, ' ').slice(0, 600)}`);
        }
      } finally {
        await ws.cleanup();
      }
      rows.push({ expected: c.expected, accepted, runs: completed, claim: c.claim.slice(0, 80), commit: c.commit.slice(0, 7) });
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  const real = rows.filter((r) => r.expected === 'real');
  const fake = rows.filter((r) => r.expected === 'false');
  const sum = (xs: typeof rows, f: (r: (typeof rows)[number]) => number) => xs.reduce((n, r) => n + f(r), 0);
  console.log('\n=== summary ===');
  console.log(`real accepted:   ${sum(real, (r) => r.accepted)}/${sum(real, (r) => r.runs)}`);
  console.log(`false accepted:  ${sum(fake, (r) => r.accepted)}/${sum(fake, (r) => r.runs)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
