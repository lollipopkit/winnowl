import { describe, expect, it } from 'vitest';
import {
  byteLimit,
  directorySizeMb,
  dockerCreateArgs,
  dockerExecTimedOut,
  orphanNamesToRemove,
  assertOrphanAgeCutoff,
  parseDockerCreatedAt,
  MAX_SANDBOX_LIFETIME_MS,
  ORPHAN_AGE_CUTOFF_MS,
} from '../src/index.js';
import type { SandboxSpec } from '../src/index.js';

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: 'alpine:3.24',
    network: { mode: 'none' },
    resources: { cpus: 1, memoryMb: 512, pids: 128, diskMb: 256 },
    ...over,
  };
}

describe('docker 沙盒容器回收(2026-07-31 live 泄漏)', () => {
  it('--rm:容器 sleep 到期即自删,不留 Exited 残骸', () => {
    const args = dockerCreateArgs('rvb-1', spec({ maxLifetimeSeconds: 2400 }), {});
    expect(args).toContain('--rm');
    // The container runs sleep <lifetime>; without --rm it would linger after exiting.
    expect(args.slice(-2)).toEqual(['sleep', '2400']);
  });

  it('workspace=disk:匿名卷替代 tmpfs,其余加固项不变', () => {
    const args = dockerCreateArgs('rvb-1', spec({ resources: { cpus: 1, memoryMb: 512, pids: 128, diskMb: 256, workspace: 'disk' } }), {});
    expect(args).toEqual(expect.arrayContaining(['--mount', 'type=volume,dst=/workspace', '--read-only', '--rm']));
    expect(args.some((a) => a.startsWith('/workspace:'))).toBe(false);
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/tmp:rw,noexec,size=64m,mode=1777']));
  });

  it('scratchMb sizes /tmp (validation keeps toolchain HOME and caches there)', () => {
    const args = dockerCreateArgs('rvb-1', spec({ resources: { cpus: 1, memoryMb: 4096, pids: 128, diskMb: 2048, scratchMb: 2048 } }), {});
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/tmp:rw,noexec,size=2048m,mode=1777', '--read-only']));
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/workspace:rw,noexec,size=2048m,mode=1777']));
  });

  it('writableExec lets builds run what they compile from /workspace and /tmp', () => {
    const args = dockerCreateArgs('rvb-1', spec({ writableExec: true }), {});
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/workspace:rw,exec,size=256m,mode=1777', '--tmpfs', '/tmp:rw,exec,size=64m,mode=1777']));
  });

  it('owner label: set from the creator, and a caller cannot forge it through spec.labels', () => {
    const args = dockerCreateArgs('rvb-1', spec({ labels: { 'winnowl.owner': 'forged', team: 'x' } }), {}, 65534, 'worker-1');
    const labels = args.flatMap((a, i) => (args[i - 1] === '--label' ? [a] : []));
    expect(labels).toContain('winnowl.owner=worker-1');
    expect(labels).not.toContain('winnowl.owner=forged');
    expect(labels).toContain('team=x');
  });

  it('归属标签:孤儿清理据此认出"我们的容器",不误删宿主上别的容器', () => {
    const args = dockerCreateArgs('rvb-1', spec(), {});
    const at = args.indexOf('winnowl.sandbox=review');
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe('--label');
  });

  it('既有加固项不因重构丢失(cap-drop/no-new-privileges/read-only/tmpfs/资源限额)', () => {
    const args = dockerCreateArgs('rvb-1', spec(), {});
    expect(args).toEqual(
      expect.arrayContaining([
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        '65534:65534',
        '--read-only',
      ]),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        '--pids-limit',
        '128',
        '--memory',
        '512m',
        '--memory-swap',
        '512m',
        '--cpus',
        '1',
      ]),
    );
    expect(args.join(' ')).toContain('/workspace:rw,noexec,size=256m,mode=1777');
  });

  it('does not let callers replace reserved sandbox ownership labels', () => {
    const args = dockerCreateArgs(
      'rvb-1',
      spec({
        labels: { 'winnowl.sandbox': 'untrusted', 'winnowl.owner': 'untrusted', team: 'core' },
      }),
      {},
    );
    expect(args).toContain('winnowl.sandbox=review');
    expect(args).not.toContain('winnowl.sandbox=untrusted');
    expect(args).not.toContain('winnowl.owner=untrusted');
    expect(args).toContain('team=core');
  });

  it('孤儿筛选:只删创建早于阈值的(在途容器不能误杀)', () => {
    const now = Date.parse('2026-07-31T10:00:00Z');
    const ps = [
      `rvb-old\t2026-07-31 08:30:00 +0000 UTC`, // 1.5 h old -> orphan
      `rvb-recent\t2026-07-31 09:50:00 +0000 UTC`, // 10 min old -> may still be running
    ].join('\n');
    expect(orphanNamesToRemove(ps, now - 60 * 60_000)).toEqual(['rvb-old']);
  });

  // The owner label separates a dead process's leftovers (removed at once) from a live runner's sandboxes (never touched).
  it('孤儿筛选:创建者已不在心跳窗口 → 立刻删(不看年龄)', () => {
    const now = Date.parse('2026-07-31T10:00:00Z');
    const ps = [
      `rvb-dead-owner	2026-07-31 09:57:00 +0000 UTC	worker-gone`, // 3 min old, but the owner is gone
      `rvb-live-owner	2026-07-31 09:57:00 +0000 UTC	worker-alive`, // in use by another live runner
    ].join('\n');
    expect(orphanNamesToRemove(ps, now - 60 * 60_000, new Set(['worker-alive']))).toEqual([
      'rvb-dead-owner',
    ]);
  });

  it('孤儿筛选:没有 liveOwners 时退回纯年龄判据(旧行为)', () => {
    const now = Date.parse('2026-07-31T10:00:00Z');
    const ps = [`rvb-recent	2026-07-31 09:57:00 +0000 UTC	worker-gone`].join('\n');
    expect(orphanNamesToRemove(ps, now - 60 * 60_000)).toEqual([]);
  });

  // With an owner label only liveness counts, not age: sandboxes live up to 100 min.
  it('孤儿筛选:创建者还活着 → 再老也不删', () => {
    const now = Date.parse('2026-07-31T10:00:00Z');
    const ps = [
      `rvb-live\t2026-07-31 07:30:00 +0000 UTC	worker-alive`, // 2.5 h old, far past the cutoff
      `rvb-dead\t2026-07-31 09:59:00 +0000 UTC	worker-gone`, // 1 min old, but the owner is gone
    ].join('\n');
    expect(orphanNamesToRemove(ps, now - 60 * 60_000, new Set(['worker-alive']))).toEqual([
      'rvb-dead',
    ]);
  });

  it('孤儿筛选:格式异常/时间解析失败一律跳过(宁可漏删,不可误删)', () => {
    const now = Date.parse('2026-07-31T10:00:00Z');
    const ps = ['rvb-nodate', '\t2026-07-31 08:00:00 +0000 UTC', 'rvb-bad\tnot-a-date', ''].join(
      '\n',
    );
    expect(orphanNamesToRemove(ps, now - 60 * 60_000)).toEqual([]);
  });

  // `Date.parse` misreads zone abbreviations (CST as US Central) or returns NaN; only the numeric offset is reliable.
  it('CreatedAt 解析:取数字偏移,忽略时区缩写', () => {
    expect(new Date(parseDockerCreatedAt('2026-10-07 12:00:00 +0800 CST')).toISOString()).toBe(
      '2026-10-07T04:00:00.000Z',
    );
    expect(new Date(parseDockerCreatedAt('2026-10-07 12:00:00 +0530 IST')).toISOString()).toBe(
      '2026-10-07T06:30:00.000Z',
    );
    expect(new Date(parseDockerCreatedAt('2026-10-07 12:00:00 -0700 PDT')).toISOString()).toBe(
      '2026-10-07T19:00:00.000Z',
    );
    expect(new Date(parseDockerCreatedAt('2026-10-07 04:00:00 +0000 UTC')).toISOString()).toBe(
      '2026-10-07T04:00:00.000Z',
    );
    expect(parseDockerCreatedAt('not-a-date')).toBeNaN();
  });

  it('带缩写的 CreatedAt 也参与年龄判据(旧实现在这里会整批漏删)', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    const ps = [`rvb-cst	2026-10-07 08:00:00 +0800 CST`].join('\n'); // = 00:00Z, 12 h ago
    expect(orphanNamesToRemove(ps, now - 60 * 60_000)).toEqual(['rvb-cst']);
    expect(orphanNamesToRemove(ps, now - 24 * 60 * 60_000)).toEqual([]);
  });

  it('年龄阈值由沙盒最长寿命推出,且必须严格大于它', () => {
    expect(ORPHAN_AGE_CUTOFF_MS).toBeGreaterThan(MAX_SANDBOX_LIFETIME_MS);
    expect(() => assertOrphanAgeCutoff(MAX_SANDBOX_LIFETIME_MS)).toThrow(/maximum sandbox lifetime/);
    expect(() => assertOrphanAgeCutoff(ORPHAN_AGE_CUTOFF_MS)).not.toThrow();
  });
});

describe('Docker exec timeout classification', () => {
  it('does not classify an OOM-killed process as a timeout solely because it exited 137', () => {
    expect(
      dockerExecTimedOut({
        code: 137,
        processTimedOut: false,
        durationMs: 500,
        timeoutMs: 60_000,
        oomKilled: true,
      }),
    ).toBe(false);
  });

  it('classifies a watchdog SIGKILL at the requested deadline as a timeout', () => {
    expect(
      dockerExecTimedOut({
        code: 137,
        processTimedOut: false,
        durationMs: 59_000,
        timeoutMs: 60_000,
        oomKilled: false,
      }),
    ).toBe(true);
  });

  /*
   * The in-container `timeout -s KILL` yields only 137. 124 (GNU timeout) and 143 (SIGTERM) come from
   * the user's own command and must not be labelled as timeouts.
   */
  it('124/143 是用户命令自己的退出码,不算超时', () => {
    for (const code of [124, 143]) {
      expect(
        dockerExecTimedOut({
          code,
          processTimedOut: false,
          durationMs: 60_000,
          timeoutMs: 60_000,
          oomKilled: false,
        }),
      ).toBe(false);
    }
  });

  it('早于死线的 137 不算超时(命令自己发 SIGKILL / 被别的东西杀了)', () => {
    expect(
      dockerExecTimedOut({
        code: 137,
        processTimedOut: false,
        durationMs: 1_000,
        timeoutMs: 60_000,
        oomKilled: false,
      }),
    ).toBe(false);
  });
});

describe('directorySizeMb(disk 工作区拷入前的大小检查)', () => {
  it('按 du 计算并向上取整到 MiB', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'rvb-du-'));
    await writeFile(join(dir, 'f'), Buffer.alloc(3 * 1024 * 1024 + 1));
    try {
      expect(await directorySizeMb(dir)).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('byteLimit(disk 工作区经 HTTP 拷入时的大小上限)', () => {
  it('passes data under the limit and cuts the output past it without erroring upstream', async () => {
    const { Readable } = await import('node:stream');
    const collect = async (chunks: Buffer[], max: number) => {
      const limit = byteLimit(max);
      const out: Buffer[] = [];
      limit.on('data', (c: Buffer) => out.push(c));
      const ended = new Promise((r) => limit.on('end', r));
      Readable.from(chunks).pipe(limit);
      await ended;
      return { bytes: Buffer.concat(out).length, exceeded: limit.exceeded === true };
    };
    expect(await collect([Buffer.alloc(10), Buffer.alloc(10)], 20)).toEqual({ bytes: 20, exceeded: false });
    expect(await collect([Buffer.alloc(10), Buffer.alloc(10), Buffer.alloc(10)], 15)).toEqual({ bytes: 10, exceeded: true });
  });
});
