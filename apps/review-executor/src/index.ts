import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import type { ReviewProgress } from '@reviewbot/review-orchestrator';
import { executorErrorReport, type ReviewExecutorSpec } from '@reviewbot/review-runtime';
import { runExecutor } from './run.js';

// All fetches go through the egress squid (relay + allowlisted hosts only); must be set before any fetch.
const egressProxy = process.env.SANDBOX_EGRESS_PROXY;
if (egressProxy) {
  setGlobalDispatcher(new ProxyAgent(egressProxy));
}

/**
 * Batch program run inside the review sandbox (no secrets, read-only rootfs, locked network): reads
 * the spec and worktree, runs the review, writes the result. On sandbox hosts the spec carries
 * relay tokens instead of keys; the control plane publishes the result.
 */
async function main(): Promise<void> {
  const inputPath = process.env.INPUT_PATH ?? process.argv[2];
  const outputPath = process.env.OUTPUT_PATH ?? process.argv[3];
  const worktreePath = process.env.WORKTREE_PATH ?? process.argv[4];
  if (!inputPath || !outputPath || !worktreePath) {
    throw new Error(
      'review-executor 需 INPUT_PATH / OUTPUT_PATH / WORKTREE_PATH(env 或 argv[2..4])',
    );
  }

  const spec = JSON.parse(await readFile(inputPath, 'utf8')) as ReviewExecutorSpec;

  // Progress goes to a file the control plane polls via `docker exec cat`; write-then-rename keeps
  // reads atomic.
  const progressPath = process.env.PROGRESS_PATH ?? '/workspace/progress.json';
  const writeProgress = (p: ReviewProgress): void => {
    const tmp = `${progressPath}.tmp`;
    void writeFile(tmp, JSON.stringify({ ...p, at: new Date().toISOString() }), 'utf8')
      .then(() => rename(tmp, progressPath))
      .catch(() => undefined);
  };

  // The control plane signals cancellation with a sentinel file.
  const cancelPath = process.env.CANCEL_PATH ?? '/workspace/cancel';

  const abort = new AbortController();
  const watch = setInterval(() => {
    if (existsSync(cancelPath)) abort.abort();
  }, 2_000);
  const output = await runExecutor({
    spec,
    worktreePath,
    onProgress: writeProgress,
    isCancelled: () => existsSync(cancelPath),
    abortSignal: abort.signal,
    ...(process.env.SPANS_PATH ? { spansPath: process.env.SPANS_PATH } : {}),
  }).finally(() => clearInterval(watch));
  await writeFile(outputPath, JSON.stringify(output), 'utf8');
}

main().catch((err) => {
  // The control plane classifies failures from stderr; failureKind picks its retry backoff.
  process.stderr.write(JSON.stringify(executorErrorReport(err)) + '\n');
  process.exit(1);
});
