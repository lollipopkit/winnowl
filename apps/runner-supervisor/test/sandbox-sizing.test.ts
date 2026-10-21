import { describe, expect, it } from 'vitest';
import type { SandboxBackend, SandboxResize, SandboxUsage } from '@reviewbot/sandbox';
import { detectStacks, growAfterFailure, initialSize, peaksOf, ranOutOfDisk, swapFor } from '../src/sandbox-sizing.js';
import { projectsOf } from '../src/sandbox-fix.js';

const bounds = { minMemoryMb: 1024, maxMemoryMb: 6144, minDiskMb: 2048, maxDiskMb: 16_384 };

describe('sandbox sizing', () => {
  it('starts from measured peaks with headroom, else from the ecosystem default, within bounds', () => {
    expect(initialSize(undefined, new Set(['dart']), bounds)).toEqual({ memoryMb: 4096, diskMb: 8192 });
    expect(initialSize(undefined, new Set(['node']), bounds)).toEqual({ memoryMb: 2048, diskMb: 6144 });
    expect(initialSize(undefined, new Set(), bounds)).toEqual({ memoryMb: 1024, diskMb: 4096 });
    // 1000 × 1.3 → 1300 → 1536 (256 steps); disk 3000 × 1.3 → 3900 → 4096 (512 steps).
    expect(initialSize({ memoryPeakMb: 1000, diskPeakMb: 3000, samples: 2 }, new Set(['dart']), bounds)).toEqual({ memoryMb: 1536, diskMb: 4096 });
    expect(initialSize({ memoryPeakMb: 100, diskPeakMb: 10, samples: 1 }, new Set(), bounds)).toEqual({ memoryMb: 1024, diskMb: 2048 });
    expect(initialSize({ memoryPeakMb: 9000, diskPeakMb: 90_000, samples: 1 }, new Set(), bounds)).toEqual({ memoryMb: 6144, diskMb: 16_384 });
  });

  it('detects stacks from root manifests', async () => {
    const files: Record<string, string> = { 'pubspec.yaml': 'name: x', 'Cargo.toml': '[package]' };
    expect([...(await detectStacks(async (p) => files[p] ?? null))].sort()).toEqual(['dart', 'rust']);
  });

  it('tells a full disk from other failures', () => {
    expect(ranOutOfDisk('write /tmp/x: no space left on device')).toBe(true);
    expect(ranOutOfDisk('error: Disk quota exceeded (os error 122)')).toBe(true);
    expect(ranOutOfDisk('test failed')).toBe(false);
  });

  it('grows memory after an OOM kill and disk after a full disk, doubling up to the bounds', async () => {
    let u: SandboxUsage = { cpus: 2, memoryMb: 4096, swapMb: 2048, diskMb: 10_000, memoryUsedMb: 0, memoryPeakMb: 3900, oomKills: 1 };
    const calls: SandboxResize[] = [];
    const backend = {
      usage: async () => u,
      resize: async (_h: unknown, req: SandboxResize) => {
        calls.push(req);
        u = { ...u, memoryMb: req.memoryMb ?? u.memoryMb, diskMb: req.diskMb ?? u.diskMb };
        return u;
      },
    } as unknown as SandboxBackend;
    const h = { id: 'rvb-1', containerId: 'a/rvb-1' };
    expect(await growAfterFailure(backend, h, { oomKilled: true, outOfDisk: false }, bounds)).toBe(true);
    expect(calls.at(-1)).toEqual({ memoryMb: 6144, swapMb: swapFor(6144) });
    // At the ceiling: nothing left to grow, the command is not retried.
    expect(await growAfterFailure(backend, h, { oomKilled: true, outOfDisk: false }, bounds)).toBe(false);
    expect(await growAfterFailure(backend, h, { oomKilled: false, outOfDisk: true }, bounds)).toBe(true);
    expect(calls.at(-1)).toEqual({ diskMb: 16_384 });
    expect(await growAfterFailure(backend, h, { oomKilled: false, outOfDisk: false }, bounds)).toBe(false);
    // A full slot is seen in its usage even when the output does not say so.
    u = { ...u, diskMb: 4096, diskUsedMb: 4090 };
    expect(await growAfterFailure(backend, h, { oomKilled: false, outOfDisk: false }, bounds)).toBe(true);
    expect(calls.at(-1)).toEqual({ diskMb: 8192 });
    expect(peaksOf({ ...u, diskPeakMb: 7000 })).toEqual({ memoryPeakMb: 3900, diskPeakMb: 7000 });
  });

  it('validates the projects a change touches: the nearest directory with a manifest', async () => {
    const files = new Set(['package.json', 'flutter_app/pubspec.yaml', 'crates/a/Cargo.toml']);
    const read = async (p: string) => (files.has(p) ? 'x' : null);
    expect(await projectsOf(['flutter_app/lib/main.dart', 'flutter_app/lib/x/y.dart', 'crates/a/src/lib.rs', 'README.md'], read)).toEqual(['', 'crates/a', 'flutter_app']);
    expect(await projectsOf(['docs/a.md'], async () => null)).toEqual([]);
  });
});
