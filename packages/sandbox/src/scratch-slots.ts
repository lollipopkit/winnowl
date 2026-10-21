import { createConnection } from 'node:net';
import { runProcess } from './exec.js';

/**
 * The host's disk-quota service (installed by `deploy/scratch-slots.sh`): the one root step, behind a
 * unix socket that accepts two commands (set a slot's limit, report usage).
 */
export interface ScratchQuota {
  setLimit(slot: number, mb: number): Promise<void>;
  report(): Promise<ScratchReport>;
}

export interface ScratchReport {
  /** slot index -> usage and limit (MiB). */
  slots: Map<number, { usedMb: number; limitMb: number }>;
  /** Free space of the disk under the sparse scratch image (MiB). */
  hostFreeMb: number;
}

/** One line in, lines out, `ok` or `error <why>` last. */
export class SocketScratchQuota implements ScratchQuota {
  constructor(private readonly socketPath: string) {}

  async setLimit(slot: number, mb: number): Promise<void> {
    await this.call(`limit ${slot} ${Math.ceil(mb)}`);
  }

  async report(): Promise<ScratchReport> {
    return parseScratchReport(await this.call('report'));
  }

  private call(line: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      let out = '';
      const timer = setTimeout(() => sock.destroy(new Error('scratch quota service did not answer in time')), 15_000);
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.end(`${line}\n`));
      sock.on('data', (chunk: string) => (out += chunk));
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.on('close', () => {
        clearTimeout(timer);
        const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
        const last = lines.pop() ?? '';
        if (last === 'ok') resolve(lines);
        else reject(new Error(`scratch quota service: ${last.replace(/^error\s*/, '') || 'no answer'}`));
      });
    });
  }
}

/** `slot <i> <used KiB> <limit KiB>` and `hostfree <KiB>` lines. */
export function parseScratchReport(lines: readonly string[]): ScratchReport {
  const slots = new Map<number, { usedMb: number; limitMb: number }>();
  let hostFreeMb = 0;
  for (const line of lines) {
    const p = line.split(/\s+/);
    if (p[0] === 'slot' && p.length === 4) {
      slots.set(Number(p[1]), { usedMb: Math.ceil(Number(p[2]) / 1024), limitMb: Math.floor(Number(p[3]) / 1024) });
    } else if (p[0] === 'hostfree' && p.length === 2) {
      hostFreeMb = Math.floor(Number(p[1]) / 1024);
    }
  }
  return { slots, hostFreeMb };
}

/** Kept free on the disk under the scratch image regardless of slot promises (logs, images). */
const HOST_RESERVE_MB = 4096;
const REPORT_TTL_MS = 2_000;

interface Held {
  sandbox: string;
  limitMb: number;
  usedMb: number;
  peakMb: number;
}

/**
 * Disk-quota slots on a sandbox host: `<root>/slot-<i>` directories, each an xfs project with a
 * per-sandbox limit. `/workspace` is `<slot>/w` and, for build sandboxes, `/tmp` is `<slot>/t`.
 *
 * The sum of limits in use stays within `poolMb`, and limits can grow at run time. The image is
 * sparse, so a grant is refused when the disk's free space would not cover what slots may still write.
 *
 * Slots are cleared before handing out and after release, in a throwaway container running as the
 * sandbox user (who owns everything a sandbox wrote). Shared by every backend of one agent.
 */
export class ScratchSlotPool {
  private readonly inUse = new Map<number, Held>();
  /** Being cleared after release; not handed out until done. */
  private readonly clearing = new Set<number>();
  private last: { at: number; report: ScratchReport } | undefined;

  constructor(
    private readonly o: {
      root: string;
      slots: number;
      /** Sum of limits of slots in use (MiB). */
      poolMb: number;
      /** Largest limit of one slot (MiB). */
      maxSlotMb: number;
      quota: ScratchQuota;
      /** Any image with `sh` and `find` (the sandbox image). */
      image: string;
      docker?: string;
      runAsUser?: number;
    },
  ) {}

  get size(): number {
    return this.o.slots;
  }

  free(): number {
    return this.o.slots - this.inUse.size - this.clearing.size;
  }

  /** MiB a new or growing slot can get now: the unpromised pool, bounded by what the disk can still hold. */
  freeMb(): number {
    const promised = [...this.inUse.values()].reduce((n, h) => n + h.limitMb, 0);
    const pool = this.o.poolMb - promised;
    if (!this.last) return Math.max(0, pool);
    const unwritten = [...this.inUse.values()].reduce((n, h) => n + Math.max(0, h.limitMb - h.usedMb), 0);
    return Math.max(0, Math.min(pool, this.last.report.hostFreeMb - unwritten - HOST_RESERVE_MB));
  }

  /** MiB at the last report; undefined before one. */
  hostFreeMb(): number | undefined {
    return this.last?.report.hostFreeMb;
  }

  dir(slot: number): string {
    return `${this.o.root.replace(/\/+$/, '')}/slot-${slot}`;
  }

  /** Cached briefly; also updates the peaks. */
  async refresh(force = false): Promise<void> {
    if (!force && this.last && Date.now() - this.last.at < REPORT_TTL_MS) return;
    const report = await this.o.quota.report();
    this.last = { at: Date.now(), report };
    for (const [slot, held] of this.inUse) {
      const r = report.slots.get(slot);
      if (!r) continue;
      held.usedMb = r.usedMb;
      held.peakMb = Math.max(held.peakMb, r.usedMb);
    }
  }

  /** Takes and clears a free slot; throws ScratchSlotsExhaustedError when no slot or room is free. */
  async acquire(sandbox: string, mb: number): Promise<number> {
    if (mb > this.o.maxSlotMb) throw new Error(`a sandbox may have at most ${this.o.maxSlotMb} MiB of disk (${mb} MiB requested)`);
    await this.refresh();
    let slot: number | undefined;
    for (let i = 0; i < this.o.slots; i++) {
      if (!this.inUse.has(i) && !this.clearing.has(i)) {
        slot = i;
        break;
      }
    }
    if (slot === undefined || mb > this.freeMb()) throw new ScratchSlotsExhaustedError();
    // Taken before any await: concurrent acquires see it.
    this.inUse.set(slot, { sandbox, limitMb: mb, usedMb: 0, peakMb: 0 });
    try {
      await this.clear(slot);
      await this.o.quota.setLimit(slot, mb);
    } catch (err) {
      this.inUse.delete(slot);
      throw err;
    }
    return slot;
  }

  /** Never below what it already holds. */
  async resize(sandbox: string, mb: number): Promise<void> {
    const entry = this.find(sandbox);
    if (!entry) throw new Error(`sandbox ${sandbox} has no scratch slot`);
    const [slot, held] = entry;
    if (mb > this.o.maxSlotMb) throw new Error(`a sandbox may have at most ${this.o.maxSlotMb} MiB of disk (${mb} MiB requested)`);
    await this.refresh(true);
    if (mb < held.usedMb) throw new Error(`sandbox ${sandbox} already holds ${held.usedMb} MiB on disk (${mb} MiB requested)`);
    const delta = mb - held.limitMb;
    if (delta > 0 && delta > this.freeMb()) throw new ScratchSlotsExhaustedError();
    const before = held.limitMb;
    held.limitMb = mb;
    try {
      await this.o.quota.setLimit(slot, mb);
    } catch (err) {
      held.limitMb = before;
      throw err;
    }
  }

  /** undefined without a slot. */
  async usage(sandbox: string): Promise<{ limitMb: number; usedMb: number; peakMb: number } | undefined> {
    const entry = this.find(sandbox);
    if (!entry) return undefined;
    await this.refresh();
    const { limitMb, usedMb, peakMb } = entry[1];
    return { limitMb, usedMb, peakMb };
  }

  /** Contents are removed before it can be taken again. */
  release(sandbox: string): void {
    for (const [slot, held] of this.inUse) {
      if (held.sandbox !== sandbox) continue;
      this.inUse.delete(slot);
      this.clearing.add(slot);
      void this.clear(slot)
        .catch(() => undefined)
        .finally(() => this.clearing.delete(slot));
    }
  }

  /** Releases slots of sandboxes that are gone (lifetime reached, swept, agent restarted). */
  reconcile(running: ReadonlySet<string>): void {
    for (const held of [...this.inUse.values()]) if (!running.has(held.sandbox)) this.release(held.sandbox);
  }

  /** Re-registers a slot a running sandbox holds after an agent restart. */
  async adopt(slot: number, sandbox: string): Promise<void> {
    if (slot < 0 || slot >= this.o.slots) return;
    await this.refresh(true);
    const r = this.last?.report.slots.get(slot);
    this.inUse.set(slot, { sandbox, limitMb: r?.limitMb ?? this.o.maxSlotMb, usedMb: r?.usedMb ?? 0, peakMb: r?.usedMb ?? 0 });
  }

  private find(sandbox: string): [number, Held] | undefined {
    for (const e of this.inUse) if (e[1].sandbox === sandbox) return e;
    return undefined;
  }

  private async clear(slot: number): Promise<void> {
    const user = this.o.runAsUser ?? 65534;
    const r = await runProcess(
      this.o.docker ?? 'docker',
      [
        'run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--user', `${user}:${user}`,
        '--mount', `type=bind,src=${this.dir(slot)},dst=/s`,
        '--entrypoint', 'sh',
        this.o.image,
        '-c', 'find /s -mindepth 1 -delete && mkdir -m 1777 /s/w /s/t',
      ],
      { timeoutMs: 10 * 60_000 },
    );
    if (r.code !== 0) throw new Error(`could not clear scratch slot ${slot}: ${r.stderr.trim()}`);
  }
}

/** The agent answers 503 and the pool waits for room. */
export class ScratchSlotsExhaustedError extends Error {
  readonly code = 'capacity_exhausted';
  constructor() {
    super('no free scratch slot or disk on this host');
    this.name = 'ScratchSlotsExhaustedError';
  }
}
