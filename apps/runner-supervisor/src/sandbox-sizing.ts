import { sql, type Db } from '@reviewbot/db';
import type { SandboxBackend, SandboxHandle, SandboxUsage } from '@reviewbot/sandbox';

/**
 * Measured sandbox sizes: a repo's next sandbox starts at its last peaks (with headroom) and grows in place
 * on OOM or full disk. Unmeasured repos start from their ecosystem default.
 */
export type SandboxKind = 'validation' | 'agent';

export interface MeasuredSize {
  memoryPeakMb: number;
  diskPeakMb: number;
  samples: number;
}

export interface SizeBounds {
  minMemoryMb: number;
  maxMemoryMb: number;
  minDiskMb: number;
  maxDiskMb: number;
}

const HEADROOM = 1.3;
/** A big run is remembered, but fades: each new run keeps at least 90 % of the stored peak. */
const DECAY = 0.9;

export async function loadSizing(db: Db, repositoryId: string, kind: SandboxKind): Promise<MeasuredSize | undefined> {
  const row = await db
    .selectFrom('sandbox_sizing')
    .select(['memory_peak_mb', 'disk_peak_mb', 'samples'])
    .where('repository_id', '=', repositoryId)
    .where('kind', '=', kind)
    .executeTakeFirst();
  return row ? { memoryPeakMb: row.memory_peak_mb, diskPeakMb: row.disk_peak_mb, samples: row.samples } : undefined;
}

export async function recordSizing(
  db: Db,
  key: { tenantId: string; repositoryId: string; kind: SandboxKind },
  peak: { memoryPeakMb: number; diskPeakMb: number },
): Promise<void> {
  const memory = Math.max(1, Math.ceil(peak.memoryPeakMb));
  const disk = Math.max(1, Math.ceil(peak.diskPeakMb));
  await db
    .insertInto('sandbox_sizing')
    .values({ tenant_id: key.tenantId, repository_id: key.repositoryId, kind: key.kind, memory_peak_mb: memory, disk_peak_mb: disk })
    .onConflict((oc) =>
      oc.columns(['repository_id', 'kind']).doUpdateSet({
        memory_peak_mb: sql<number>`greatest(excluded.memory_peak_mb, round(sandbox_sizing.memory_peak_mb * ${DECAY}::numeric)::int)`,
        disk_peak_mb: sql<number>`greatest(excluded.disk_peak_mb, round(sandbox_sizing.disk_peak_mb * ${DECAY}::numeric)::int)`,
        samples: sql<number>`sandbox_sizing.samples + 1`,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/** The toolchains a tree needs, from its root manifests. */
export async function detectStacks(readFile: (path: string) => Promise<string | null>): Promise<Set<string>> {
  const markers: [string, string][] = [
    ['pubspec.yaml', 'dart'],
    ['Cargo.toml', 'rust'],
    ['package.json', 'node'],
    ['go.mod', 'go'],
    ['pom.xml', 'java'],
    ['build.gradle', 'java'],
    ['build.gradle.kts', 'java'],
    ['pyproject.toml', 'python'],
  ];
  const found = await Promise.all(markers.map(async ([file, stack]) => ((await readFile(file)) !== null ? stack : undefined)));
  return new Set(found.filter((s): s is string => s !== undefined));
}

/** First-run size by ecosystem: dart/flutter and rust analyzers and linkers are the hungry ones. */
function defaults(stacks: ReadonlySet<string>): { memoryMb: number; diskMb: number } {
  if (stacks.has('dart') || stacks.has('rust')) return { memoryMb: 4096, diskMb: 8192 };
  if (stacks.has('node') || stacks.has('go') || stacks.has('java')) return { memoryMb: 2048, diskMb: 6144 };
  return { memoryMb: 1024, diskMb: 4096 };
}

const roundUp = (mb: number, step: number): number => Math.ceil(mb / step) * step;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Where a sandbox starts: measured peaks with headroom, else the ecosystem default; within bounds. */
export function initialSize(
  measured: MeasuredSize | undefined,
  stacks: ReadonlySet<string>,
  bounds: SizeBounds,
): { memoryMb: number; diskMb: number } {
  const d = defaults(stacks);
  const memoryMb = measured ? roundUp(measured.memoryPeakMb * HEADROOM, 256) : d.memoryMb;
  const diskMb = measured ? roundUp(measured.diskPeakMb * HEADROOM, 512) : d.diskMb;
  return {
    memoryMb: clamp(memoryMb, bounds.minMemoryMb, bounds.maxMemoryMb),
    diskMb: clamp(diskMb, bounds.minDiskMb, bounds.maxDiskMb),
  };
}

/** Swap next to a memory limit: half of it, a buffer for short peaks. */
export const swapFor = (memoryMb: number): number => Math.floor(memoryMb / 2);

/** A slot this close to its limit counts as full. */
const FULL_MARGIN_MB = 64;

/** Output that says the sandbox's disk limit was hit. */
export function ranOutOfDisk(output: string): boolean {
  return /No space left on device|Disk quota exceeded|ENOSPC|EDQUOT/i.test(output);
}

/**
 * Grows a sandbox after a command failed for want of room: memory after an OOM kill, disk after a
 * full disk — doubled, up to the bounds. Returns whether it grew (the caller then retries once).
 */
export async function growAfterFailure(
  backend: SandboxBackend,
  handle: SandboxHandle,
  failure: { oomKilled: boolean; outOfDisk: boolean },
  bounds: SizeBounds,
): Promise<boolean> {
  if (!backend.usage || !backend.resize) return false;
  const u = await backend.usage(handle);
  // A full slot is also seen in its usage: tools report a failed write in their own words
  // (busybox says "I/O error"), but what they wrote stays in the slot.
  const full = failure.outOfDisk || (u.diskMb !== undefined && (u.diskUsedMb ?? 0) >= u.diskMb - FULL_MARGIN_MB);
  const memoryMb = failure.oomKilled ? Math.min(bounds.maxMemoryMb, u.memoryMb * 2) : u.memoryMb;
  const diskMb = full && u.diskMb !== undefined ? Math.min(bounds.maxDiskMb, u.diskMb * 2) : u.diskMb;
  if (memoryMb === u.memoryMb && diskMb === u.diskMb) return false;
  await backend.resize(handle, {
    ...(memoryMb !== u.memoryMb ? { memoryMb, swapMb: swapFor(memoryMb) } : {}),
    ...(diskMb !== u.diskMb && diskMb !== undefined ? { diskMb } : {}),
  });
  return true;
}

/** The peaks to remember from a finished sandbox. */
export function peaksOf(u: SandboxUsage): { memoryPeakMb: number; diskPeakMb: number } {
  return { memoryPeakMb: u.memoryPeakMb, diskPeakMb: u.diskPeakMb ?? u.diskUsedMb ?? 0 };
}
