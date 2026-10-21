import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxSpec, SandboxBackend, SandboxHandle } from '@reviewbot/sandbox';
import {
  destroyActiveSandboxes,
  execTimeoutMs,
  runReviewInSandbox,
} from '../src/review-in-sandbox.js';
import type { CodePlane, ReviewExecutorSpec } from '@reviewbot/review-runtime';
import { classifyJobError } from '../src/supervisor.js';

/** Fake backend recording destroy calls; exec can succeed, fail or hang. */
function stubSandbox(over: Partial<SandboxBackend> = {}): SandboxBackend & { destroyed: string[] } {
  const destroyed: string[] = [];
  const base = {
    destroyed,
    create: async (): Promise<SandboxHandle> => ({ id: 'rvb-test', containerId: 'c1' }),
    copyInto: async () => undefined,
    putFile: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false }),
    getArtifact: async () => ({
      path: '/workspace/output.json',
      content: JSON.stringify({ findings: [] }),
      bytes: 2,
    }),
    destroy: async (h: SandboxHandle) => {
      destroyed.push(h.id);
    },
  };
  return { ...base, ...over } as SandboxBackend & { destroyed: string[] };
}

const SPEC = {} as unknown as ReviewExecutorSpec;
/** A workspace in this process: its head worktree is copied into the sandbox. */
const WT = {
  location: { kind: 'local', headDir: '/tmp/wt', gitDir: '/tmp/git' },
  dispose: async () => undefined,
} as unknown as CodePlane;
const deps = (sandbox: SandboxBackend): Parameters<typeof runReviewInSandbox>[2] => ({
  sandbox,
  image: 'winnowl:latest',
  resources: { cpus: 1, memoryMb: 512, pids: 128, diskMb: 256 },
  log: () => undefined,
});

beforeEach(() => {
  vi.stubEnv('SANDBOX_EGRESS_PROXY', 'http://egress-proxy:3128');
  vi.stubEnv('SANDBOX_EGRESS_NETWORK', 'sandbox-egress');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('review 沙盒回收(2026-07-31 live:job 完成后容器仍在跑)', () => {
  it('缺少受限 egress 配置时 fail closed', async () => {
    vi.stubEnv('SANDBOX_EGRESS_PROXY', '');
    vi.stubEnv('SANDBOX_EGRESS_NETWORK', '');
    const sandbox = stubSandbox();
    await expect(runReviewInSandbox(SPEC, WT, deps(sandbox))).rejects.toThrow(
      'requires SANDBOX_EGRESS_PROXY',
    );
  });
  it('正常跑完 → destroy 一次,且不再挂在"在途"表上', async () => {
    const sandbox = stubSandbox();
    await runReviewInSandbox(SPEC, WT, deps(sandbox));
    expect(sandbox.destroyed).toEqual(['rvb-test']);
    // Unregistered: shutdown must not destroy it again.
    expect(await destroyActiveSandboxes()).toBe(0);
  });

  it('executor 失败 → 仍然 destroy(finally 路径)', async () => {
    const sandbox = stubSandbox({
      exec: async (_h, req) =>
        req.argv[0] === 'chmod'
          ? { exitCode: 0, stdout: '', stderr: '', truncated: false }
          : { exitCode: 1, stdout: '', stderr: 'boom', truncated: false },
    });
    await expect(runReviewInSandbox(SPEC, WT, deps(sandbox))).rejects.toThrow();
    expect(sandbox.destroyed).toEqual(['rvb-test']);
    expect(await destroyActiveSandboxes()).toBe(0);
  });

  it('retains a sandbox whose normal cleanup failed so shutdown can retry it', async () => {
    let failDestroy = true;
    const sandbox = stubSandbox({
      destroy: async (h: SandboxHandle) => {
        if (failDestroy) throw new Error('temporary daemon failure');
        sandbox.destroyed.push(h.id);
      },
    });
    await runReviewInSandbox(SPEC, WT, deps(sandbox));
    failDestroy = false;
    expect(await destroyActiveSandboxes()).toBe(1);
    expect(sandbox.destroyed).toEqual(['rvb-test']);
  });

  // A wall-clock timeout is not internal_bug (not retried, misleads triage): the model did not finish in time,
  // so the run cannot count as clean.
  it('exec 超时 → ReviewIncompleteError(不是 internal_bug),且说清是超时', async () => {
    const sandbox = stubSandbox({
      exec: async (_h, req) =>
        req.argv[0] === 'chmod'
          ? { exitCode: 0, stdout: '', stderr: '', truncated: false }
          : {
              exitCode: 137,
              stdout: '',
              stderr: '',
              truncated: false,
              timedOut: true,
            },
    });
    await expect(runReviewInSandbox(SPEC, WT, deps(sandbox))).rejects.toMatchObject({
      name: 'ReviewIncompleteError',
      message: expect.stringContaining('timed out'),
      failureKind: 'timeout',
    });
    expect(sandbox.destroyed).toEqual(['rvb-test']);
  });

  // The sandbox's error classification (e.g. gateway_transport) and original message must reach the control plane,
  // which otherwise sees only "exploration incomplete" and picks the wrong backoff.
  it('executor 的 failureKind/failureDetail 过沙盒墙(否则控制面选不到对的退避档)', async () => {
    const stderr =
      'some noise from the model\n' +
      JSON.stringify({
        error: 'review exploration incomplete: mapStatus=error',
        name: 'ReviewIncompleteError',
        failureKind: 'gateway_transport',
        failureDetail: 'stream error: event: error',
      }) +
      '\n';
    const logged: Record<string, unknown>[] = [];
    const sandbox = stubSandbox({
      exec: async (_h, req) =>
        req.argv[0] === 'chmod'
          ? { exitCode: 0, stdout: '', stderr: '', truncated: false }
          : { exitCode: 1, stdout: '', stderr, truncated: false },
    });
    await expect(
      runReviewInSandbox(SPEC, WT, {
        ...deps(sandbox),
        log: (_m, d) => void logged.push(d ?? {}),
      }),
    ).rejects.toMatchObject({
      name: 'ReviewIncompleteError',
      failureKind: 'gateway_transport',
      failureDetail: 'stream error: event: error',
    });
    // The original message is logged too: the class picks the retry tier, the text is needed for triage.
    expect(logged.some((d) => d.failureDetail === 'stream error: event: error')).toBe(true);
  });

  it('executor 的 deadlineCut 过沙盒墙(否则墙钟到点的终态会被当成可重试)', async () => {
    const stderr =
      JSON.stringify({
        error: 'review exploration incomplete: 阶段墙钟到点(dig)',
        name: 'ReviewIncompleteError',
        failureKind: 'timeout',
        deadlineCut: true,
      }) + '\n';
    const sandbox = stubSandbox({
      exec: async (_h, req) =>
        req.argv[0] === 'chmod'
          ? { exitCode: 0, stdout: '', stderr: '', truncated: false }
          : { exitCode: 1, stdout: '', stderr, truncated: false },
    });
    const err = await runReviewInSandbox(SPEC, WT, deps(sandbox)).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ReviewIncompleteError', failureKind: 'timeout', deadlineCut: true });
    expect(classifyJobError(err)).toEqual({ failureClass: 'budget_exhausted', retryable: false });
  });

  it('进程关停时:在途沙盒被强拆(SIGKILL 前的 10s 宽限里 finally 跑不到,靠这条兜底)', async () => {
    // exec never returns (review running) when SIGTERM arrives.
    let release: (() => void) | undefined;
    const hang = new Promise<void>((r) => {
      release = r;
    });
    const sandbox = stubSandbox({
      exec: async () => {
        await hang;
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    const running = runReviewInSandbox(SPEC, WT, deps(sandbox)).catch(() => undefined);
    // Wait for create to finish and register (one microtask turn).
    await Promise.resolve();
    await Promise.resolve();

    expect(await destroyActiveSandboxes()).toBe(1); // shutdown destroyed the in-flight container
    expect(sandbox.destroyed).toEqual(['rvb-test']);

    release?.();
    await running;
  });

  it('seals the copied source tree before writing model-controlled input', async () => {
    const calls: string[] = [];
    const sandbox = stubSandbox({
      copyInto: async () => void calls.push('copy'),
      exec: async (_h, req) => {
        calls.push(req.argv.join(' '));
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
      putFile: async (_h, req) => void calls.push(`put:${req.path}`),
    });
    await runReviewInSandbox(SPEC, WT, deps(sandbox));
    expect(calls).toEqual([
      'copy',
      'chmod -R a-w /workspace/worktree',
      'put:/workspace/input.json',
      'node /app/apps/review-executor/dist/index.mjs',
    ]);
  });
});

/*
 * Cancellation reaches the sandbox: it cannot read `jobs.cancellation_requested`, so the control plane
 * polls the flag and writes a sentinel into the workspace; the executor checks it before each paid step.
 */
describe('review 沙盒取消(§10.7 取消位反向过墙)', () => {
  /** A hanging exec is a running review; the test decides when to release it. */
  function hangingSandbox(): {
    sandbox: SandboxBackend & { destroyed: string[] };
    puts: string[];
    release: () => void;
  } {
    const puts: string[] = [];
    let release = (): void => undefined;
    const hang = new Promise<void>((r) => {
      release = r;
    });
    const sandbox = stubSandbox({
      putFile: async (_h: SandboxHandle, req: { path: string }) => {
        puts.push(req.path);
      },
      exec: async (_h, req) => {
        if (req.argv[0] === 'chmod')
          return { exitCode: 0, stdout: '', stderr: '', truncated: false };
        await hang;
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    });
    return { sandbox, puts, release };
  }

  it('取消位置上 → 往工作区写哨兵(executor 据此在下一个花钱边界收工)', async () => {
    vi.useFakeTimers();
    try {
      const { sandbox, puts, release } = hangingSandbox();
      let cancelled = false;
      const running = runReviewInSandbox(SPEC, WT, {
        ...deps(sandbox),
        isCancelled: () => cancelled,
      }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(6_000); // not cancelled: spec only, no sentinel
      expect(puts).toEqual(['/workspace/input.json']);

      cancelled = true;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(puts).toContain('/workspace/cancel');
      // Written once: the sentinel already exists.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(puts.filter((p) => p === '/workspace/cancel')).toHaveLength(1);

      release();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it('写哨兵失败 → 下一拍重试(取消不能因为一次 exec 抖动就丢)', async () => {
    vi.useFakeTimers();
    try {
      const { sandbox, puts, release } = hangingSandbox();
      let fail = true;
      const putFile = sandbox.putFile.bind(sandbox);
      sandbox.putFile = async (h, req) => {
        if (req.path === '/workspace/cancel' && fail) {
          fail = false;
          throw new Error('exec 抖了一下');
        }
        return putFile(h, req);
      };
      const running = runReviewInSandbox(SPEC, WT, {
        ...deps(sandbox),
        isCancelled: () => true,
      }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(puts).not.toContain('/workspace/cancel');
      await vi.advanceTimersByTimeAsync(6_000);
      expect(puts).toContain('/workspace/cancel');

      release();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it('不传 isCancelled → 不起轮询(测试与回退路径零开销)', async () => {
    const reqs: string[] = [];
    const sandbox = stubSandbox({
      putFile: async (_h: SandboxHandle, req: { path: string }) => void reqs.push(req.path),
    });
    await runReviewInSandbox(SPEC, WT, deps(sandbox));
    expect(reqs).toEqual(['/workspace/input.json']);
  });
});

/*
 * The overall kill timeout is derived from the stage wall clocks: a stage deadline moves on with partial
 * results, the overall one SIGKILLs the run, so two hardcoded values would drift apart.
 */
describe('sandbox 总闸(execTimeoutMs)', () => {
  const spec = (stage: Record<string, number> | undefined, verify?: number): ReviewExecutorSpec =>
    ({
      ...(stage ? { stageBudgetMs: stage } : {}),
      ...(verify !== undefined ? { verifyBudgetMs: verify } : {}),
    }) as unknown as ReviewExecutorSpec;
  const min = (n: number): number => n * 60_000;

  it('四段都设了 → 之和 + 5 分钟余量', () => {
    // Live default stages: 5 + 15 + 3 + 9 = 32 → 37.
    expect(execTimeoutMs(spec({ map: min(5), dig: min(15), synthesis: min(3) }, min(9)))).toBe(
      min(37),
    );
  });

  it('各档拉满(20/35/10/25 = 90)→ 95,正好是硬上限', () => {
    expect(execTimeoutMs(spec({ map: min(20), dig: min(35), synthesis: min(10) }, min(25)))).toBe(
      min(95),
    );
  });

  it('之和超过硬上限 → 封顶 95,不会让一跑无限占着 worker', () => {
    expect(execTimeoutMs(spec({ map: min(60), dig: min(60), synthesis: min(60) }, min(60)))).toBe(
      min(95),
    );
  });

  it('任一段 off/缺省 → 推不出总时长,退回硬上限', () => {
    expect(execTimeoutMs(spec({ map: min(5), dig: 0, synthesis: min(3) }, min(9)))).toBe(min(95));
    expect(execTimeoutMs(spec({ map: min(5), dig: min(15) }, min(9)))).toBe(min(95));
    expect(execTimeoutMs(spec(undefined))).toBe(min(95));
  });

  it('a workspace on a sandbox host: the sandbox goes to that host and mounts the clone read-only', async () => {
    const calls: string[] = [];
    let created: SandboxSpec | undefined;
    const sandbox = stubSandbox({
      create: async (spec) => {
        created = spec;
        return { id: 'rvb-test', containerId: 'vie/c1' };
      },
      copyFromWorkspace: async (_h, ws) => void calls.push(`copy:${ws.host}/${ws.workspaceId}`),
      exec: async (_h, req) => {
        calls.push(req.argv.join(' '));
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      },
    } as Partial<SandboxBackend>);
    const remote = {
      location: { kind: 'agent', host: 'vie', workspaceId: 'ws-1' },
      dispose: async () => undefined,
    } as unknown as CodePlane;
    await runReviewInSandbox(SPEC, remote, deps(sandbox));
    expect(created?.placement).toBe('vie');
    expect(created?.mountWorkspace).toEqual({ workspaceId: 'ws-1', dest: '/workspace/worktree' });
    // No copy and no chmod: the executor is the first thing that runs.
    expect(calls.some((c) => c.startsWith('copy:') || c.startsWith('chmod'))).toBe(false);
  });
});
