import { describe, expect, it } from 'vitest';
import { dockerCreateArgs, parseCgroupSample, parseScratchReport, ScratchSlotPool, ScratchSlotsExhaustedError } from '../src/index.js';
import type { SandboxSpec, ScratchQuota, ScratchReport } from '../src/index.js';

/** The host's quota service: records limits, reports usage the test sets. */
class FakeQuota implements ScratchQuota {
  readonly limits = new Map<number, number>();
  readonly used = new Map<number, number>();
  hostFreeMb = 100_000;
  async setLimit(slot: number, mb: number): Promise<void> {
    this.limits.set(slot, mb);
  }
  async report(): Promise<ScratchReport> {
    const slots = new Map<number, { usedMb: number; limitMb: number }>();
    for (const [slot, limitMb] of this.limits) slots.set(slot, { usedMb: this.used.get(slot) ?? 0, limitMb });
    return { slots, hostFreeMb: this.hostFreeMb };
  }
}

// `true` accepts any arguments and succeeds: clearing a slot "works" without docker.
const pool = (slots = 2, quota = new FakeQuota(), poolMb = 10_240, maxSlotMb = 8192) =>
  new ScratchSlotPool({ root: '/srv/winnowl-scratch/', slots, poolMb, maxSlotMb, quota, image: 'winnowl:latest', docker: 'true' });
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('ScratchSlotPool', () => {
  it('hands out each slot once with its own limit, gives it back after clearing, and reports what is free', async () => {
    const quota = new FakeQuota();
    const p = pool(2, quota);
    expect(await p.acquire('rvb-a', 2048)).toBe(0);
    expect(await p.acquire('rvb-b', 4096)).toBe(1);
    expect(quota.limits).toEqual(new Map([[0, 2048], [1, 4096]]));
    await expect(p.acquire('rvb-c', 1024)).rejects.toBeInstanceOf(ScratchSlotsExhaustedError);
    expect(p.free()).toBe(0);
    expect(p.freeMb()).toBe(10_240 - 6144);
    p.release('rvb-a');
    await settle();
    expect(p.free()).toBe(1);
    expect(await p.acquire('rvb-c', 1024)).toBe(0);
    expect(p.dir(1)).toBe('/srv/winnowl-scratch/slot-1');
  });

  it('the limits of the slots in use stay within the pool, and one slot within its maximum', async () => {
    const p = pool(3);
    await p.acquire('rvb-a', 8192);
    await expect(p.acquire('rvb-b', 4096)).rejects.toBeInstanceOf(ScratchSlotsExhaustedError);
    await expect(p.acquire('rvb-b', 9000)).rejects.toThrow(/at most 8192 MiB/);
    expect(await p.acquire('rvb-b', 2048)).toBe(1);
  });

  it('grows a slot in place while room is left, never below what it holds', async () => {
    const quota = new FakeQuota();
    const p = pool(2, quota);
    const slot = await p.acquire('rvb-a', 2048);
    await p.resize('rvb-a', 6144);
    expect(quota.limits.get(slot)).toBe(6144);
    await expect(p.resize('rvb-a', 12_000)).rejects.toThrow(/at most/);
    await p.acquire('rvb-b', 4096);
    await expect(p.resize('rvb-a', 8000)).rejects.toBeInstanceOf(ScratchSlotsExhaustedError);
    quota.used.set(slot, 3000);
    await expect(p.resize('rvb-a', 2048)).rejects.toThrow(/already holds 3000 MiB/);
    await p.resize('rvb-a', 3072);
    expect(await p.usage('rvb-a')).toEqual({ limitMb: 3072, usedMb: 3000, peakMb: 3000 });
  });

  it('grants no more than the disk under the sparse image can still hold', async () => {
    const quota = new FakeQuota();
    const p = pool(3, quota, 50_000, 40_000);
    quota.hostFreeMb = 4096 + 10_000; // reserve + 10 GiB
    await p.acquire('rvb-a', 6000);
    // 6000 promised and unwritten: 4000 left for others.
    await expect(p.acquire('rvb-b', 5000)).rejects.toBeInstanceOf(ScratchSlotsExhaustedError);
    expect(await p.acquire('rvb-b', 4000)).toBe(1);
  });

  it('frees the slots of sandboxes that are gone and keeps the ones a restart found running', async () => {
    const quota = new FakeQuota();
    const p = pool(3, quota);
    quota.limits.set(2, 3000);
    await p.adopt(2, 'rvb-old');
    await p.acquire('rvb-live', 1024);
    await p.acquire('rvb-dead', 1024);
    p.reconcile(new Set(['rvb-live', 'rvb-old']));
    await settle();
    expect(p.free()).toBe(1);
    expect(await p.usage('rvb-old')).toMatchObject({ limitMb: 3000 });
    expect(await p.acquire('rvb-new', 1024)).toBe(1);
  });

  it('a slot that cannot be cleared is not handed out', async () => {
    const p = new ScratchSlotPool({ root: '/x', slots: 1, poolMb: 1024, maxSlotMb: 1024, quota: new FakeQuota(), image: 'i', docker: 'false' });
    await expect(p.acquire('rvb-a', 512)).rejects.toThrow(/could not clear scratch slot 0/);
    expect(p.free()).toBe(1);
    expect(p.freeMb()).toBe(1024);
  });

  it('parses the quota service report', () => {
    expect(parseScratchReport(['slot 0 2048 4194304', 'slot 3 0 1048576', 'hostfree 52428800'])).toEqual({
      slots: new Map([
        [0, { usedMb: 2, limitMb: 4096 }],
        [3, { usedMb: 0, limitMb: 1024 }],
      ]),
      hostFreeMb: 51_200,
    });
  });
});

describe('cgroup samples', () => {
  it('counts anon + shmem (not page cache) and the OOM kills', () => {
    const stat = 'anon 104857600\nfile 900000000\nshmem 10485760\nkernel 1000\n';
    const events = 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n';
    expect(parseCgroupSample(stat + events)).toEqual({ usedMb: 110, oomKills: 1 });
  });
});

describe('dockerCreateArgs swap', () => {
  it('memory-swap is memory plus the swap the spec asks for (none by default)', () => {
    const base = { image: 'i', network: { mode: 'none' as const }, resources: { cpus: 1, memoryMb: 1024, pids: 64, diskMb: 1024 } };
    expect(dockerCreateArgs('rvb-1', base, {})).toEqual(expect.arrayContaining(['--memory-swap', '1024m']));
    expect(dockerCreateArgs('rvb-1', { ...base, resources: { ...base.resources, swapMb: 512 } }, {})).toEqual(
      expect.arrayContaining(['--memory-swap', '1536m']),
    );
  });
});

describe('dockerCreateArgs with a scratch slot', () => {
  const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
    image: 'winnowl:latest',
    network: { mode: 'none' },
    resources: { cpus: 1, memoryMb: 512, pids: 64, diskMb: 1024, workspace: 'disk' },
    ...over,
  });
  const scratch = { slot: 3, dir: '/srv/winnowl-scratch/slot-3' };

  it('mounts the slot as /workspace and labels the sandbox with it; /tmp stays a small noexec tmpfs', () => {
    const args = dockerCreateArgs('rvb-1', spec(), {}, 65534, 'w1', scratch);
    expect(args).toEqual(expect.arrayContaining(['--mount', 'type=bind,src=/srv/winnowl-scratch/slot-3/w,dst=/workspace']));
    expect(args).toEqual(expect.arrayContaining(['--label', 'winnowl.scratch-slot=3']));
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/tmp:rw,noexec,size=64m,mode=1777']));
    expect(args.some((a) => a.startsWith('type=volume'))).toBe(false);
  });

  it('a sandbox that runs builds keeps /tmp in the slot too', () => {
    const args = dockerCreateArgs('rvb-1', spec({ writableExec: true }), {}, 65534, 'w1', scratch);
    expect(args).toEqual(expect.arrayContaining(['--mount', 'type=bind,src=/srv/winnowl-scratch/slot-3/t,dst=/tmp']));
    expect(args.some((a) => a.startsWith('/tmp:'))).toBe(false);
  });

  it('mounts given host directories read-only', () => {
    const args = dockerCreateArgs('rvb-1', spec(), {}, 65534, 'w1', scratch, [{ src: '/srv/ws/ws-1/head', dst: '/workspace/worktree' }]);
    expect(args).toEqual(expect.arrayContaining(['--mount', 'type=bind,src=/srv/ws/ws-1/head,dst=/workspace/worktree,readonly']));
  });

  it('a caller cannot forge the slot label', () => {
    const args = dockerCreateArgs('rvb-1', spec({ labels: { 'winnowl.scratch-slot': '0' } }), {}, 65534, 'w1');
    expect(args).not.toContain('winnowl.scratch-slot=0');
  });
});
