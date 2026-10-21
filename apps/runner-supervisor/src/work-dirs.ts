import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Reclaims orphaned review work dirs (`winnowl-work-*`, `winnowl-git-*`) left in /tmp when the process
 * was SIGKILLed before its finally ran. Same rule as sandbox `sweepOrphans`:
 * - the name carries the creator workerId and that worker is past the heartbeat window → delete now;
 * - no workerId in the name → by age only, since deleting a dir still in use makes a review read empty files.
 * Names look like `winnowl-work-<workerId>-<random>`; the owner is between the prefix and the last `-`.
 */
export const WORK_DIR_PREFIXES = ['winnowl-work-', 'winnowl-git-'] as const;

export interface OrphanDirCandidate {
  name: string;
  /** Creation time (ms); `Number.NaN` when unknown. */
  createdAtMs: number;
}

/** Which dirs to delete. Pure so the liveness/age boundaries are deterministically testable. */
export function orphanDirsToRemove(
  candidates: readonly OrphanDirCandidate[],
  now: number,
  olderThanMs: number,
  liveOwners: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const prefix = WORK_DIR_PREFIXES.find((p) => c.name.startsWith(p));
    if (!prefix) continue;
    const owner = ownerOf(c.name, prefix);
    if (owner !== undefined) {
      if (!liveOwners.has(owner)) out.push(c.name);
      continue;
    }
    // No owner: age only, and never delete when the age is unknown.
    if (Number.isFinite(c.createdAtMs) && now - c.createdAtMs >= olderThanMs) out.push(c.name);
  }
  return out;
}

/** `winnowl-work-<owner>-<mkdtemp suffix>` → owner; no suffix separator → unowned (legacy format). */
function ownerOf(name: string, prefix: string): string | undefined {
  const rest = name.slice(prefix.length);
  const cut = rest.lastIndexOf('-');
  if (cut <= 0) return undefined;
  return rest.slice(0, cut);
}

/** Deletes orphans in the tmp dir; never throws (cleanup must not break startup). Returns the count. */
export async function sweepOrphanWorkDirs(
  tmpRoot: string,
  liveOwners: ReadonlySet<string>,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<number> {
  const entries = await readdir(tmpRoot, { withFileTypes: true }).catch(() => []);
  const candidates: OrphanDirCandidate[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !WORK_DIR_PREFIXES.some((p) => e.name.startsWith(p))) continue;
    const st = await stat(join(tmpRoot, e.name)).catch(() => null);
    candidates.push({ name: e.name, createdAtMs: st ? st.birthtimeMs || st.mtimeMs : Number.NaN });
  }
  const doomed = orphanDirsToRemove(candidates, now, olderThanMs, liveOwners);
  for (const name of doomed) await rm(join(tmpRoot, name), { recursive: true, force: true }).catch(() => undefined);
  return doomed.length;
}
