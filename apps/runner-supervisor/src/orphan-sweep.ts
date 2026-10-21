import { tmpdir } from 'node:os';
import type { Db } from '@reviewbot/db';
import { listLiveWorkerIds } from '@reviewbot/queue';
import { ORPHAN_AGE_CUTOFF_MS } from '@reviewbot/sandbox';
import type { Logger } from 'pino';
import type { createSandboxBackend } from './sandbox-backend.js';
import { sweepOrphanWorkDirs } from './work-dirs.js';

/**
 * Removes what dead runners left behind (sandboxes, workspaces, work dirs) once at startup and the
 * sandboxes periodically; returns the periodic timer to clear on shutdown.
 */
export async function startOrphanSweeps({
  db,
  logger,
  sandbox,
}: {
  db: Db;
  logger: Logger;
  sandbox: ReturnType<typeof createSandboxBackend>['sandbox'];
}): Promise<NodeJS.Timeout> {
  /*
   * Startup sweep of sandboxes left by a SIGKILLed process: those whose creator label points at a worker
   * outside the heartbeat window are deleted immediately (they still spend LLM quota); unlabelled legacy
   * containers only after 60 min (> the 40 min sandbox lifetime).
   * If the live-worker set cannot be read, skip the round instead of assuming only we are alive: a wrong
   * set would delete other runners' sandboxes on shared hosts.
   */
  const liveWorkerIds = await listLiveWorkerIds(db).catch((err: unknown) => {
    logger.warn(
      { err: (err as Error)?.message },
      'worker 存活集合读取失败:跳过本轮孤儿清理(周期清理会重试)',
    );
    return null;
  });
  if (sandbox.sweepOrphans && liveWorkerIds) {
    const swept = await sandbox.sweepOrphans(ORPHAN_AGE_CUTOFF_MS, liveWorkerIds).catch((err) => {
      logger.warn({ err: (err as Error)?.message }, '孤儿沙盒清理失败(不影响启动)');
      return 0;
    });
    if (swept > 0) logger.info({ swept }, '启动清理:已回收遗留的 review 沙盒容器');
  }
  /*
   * The same sweep, periodically: sandboxes and workspaces of a dead runner still spend LLM quota, and an
   * agent draining for a deploy would wait for them. Owners whose heartbeat stopped are swept within one interval.
   */
  const ORPHAN_SWEEP_MS = 5 * 60_000;
  const timer = setInterval(() => {
    if (!sandbox.sweepOrphans) return;
    void listLiveWorkerIds(db)
      .then((live) => sandbox.sweepOrphans!(ORPHAN_AGE_CUTOFF_MS, live))
      .then((swept) => {
        if (swept > 0) logger.info({ swept }, 'orphan sweep: removed sandboxes / workspaces of dead runners');
      })
      .catch((err) => logger.warn({ err: (err as Error)?.message }, 'orphan sweep failed'));
  }, ORPHAN_SWEEP_MS);
  timer.unref();
  /*
   * Same for local work dirs (head worktree and clone) left in /tmp: dead owner → delete now; legacy
   * names without an owner → after 60 min.
   */
  if (liveWorkerIds) {
    const swept = await sweepOrphanWorkDirs(tmpdir(), liveWorkerIds, ORPHAN_AGE_CUTOFF_MS).catch(
      (err) => {
        logger.warn({ err: (err as Error)?.message }, '孤儿工作目录清理失败(不影响启动)');
        return 0;
      },
    );
    if (swept > 0) logger.info({ swept }, '启动清理:已回收遗留的 review 工作目录');
  }
  return timer;
}
