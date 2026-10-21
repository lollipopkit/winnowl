import { describe, expect, it } from 'vitest';
import type { ExecRequest, ExecResult, SandboxBackend } from '@reviewbot/sandbox';
import { runTreeValidation } from '../src/index.js';

const result = (exitCode: number, oomKilled = false): ExecResult => ({
  exitCode,
  stdout: '',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  durationMs: 1,
  ...(oomKilled ? { oomKilled: true } : {}),
  evidence: { image: 'i', runtime: 'runc', argv: [], purpose: 'test', exitCode, timedOut: false, durationMs: 1 },
});

describe('runTreeValidation growing the sandbox', () => {
  it('a command that failed for want of room runs once more after the sandbox grew; usage is recorded before destroy', async () => {
    const runs: string[] = [];
    const events: string[] = [];
    let first = true;
    const backend = {
      create: async () => ({ id: 'rvb-1', containerId: 'rvb-1' }),
      exec: async (_h: unknown, req: ExecRequest) => {
        runs.push(req.argv.join(' '));
        if (first) {
          first = false;
          return result(137, true);
        }
        return result(0);
      },
      destroy: async () => void events.push('destroy'),
    } as unknown as SandboxBackend;
    const outcome = await runTreeValidation({
      backend,
      spec: { image: 'i', network: { mode: 'none' }, resources: { cpus: 1, memoryMb: 1024, pids: 64, diskMb: 1024 } },
      deliverTree: async () => undefined,
      readFile: async () => null,
      tools: { auto_detect: false, commands: { test: ['make test'] } },
      grow: async (_h, res) => {
        events.push(`grow oom=${res.oomKilled === true}`);
        return true;
      },
      beforeDestroy: async () => void events.push('record'),
    });
    expect(runs).toEqual(['sh -lc make test', 'sh -lc make test']);
    expect(outcome.status).toBe('passed');
    expect(events).toEqual(['grow oom=true', 'record', 'destroy']);
  });
});
