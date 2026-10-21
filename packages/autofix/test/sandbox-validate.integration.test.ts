import { DockerSandboxBackend, runProcess, type ExecRequest, type SandboxSpec } from '@reviewbot/sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runValidationInSandbox } from '../src/index.js';

const IMAGE = 'alpine:3.24';
const backend = new DockerSandboxBackend();

function spec(): SandboxSpec {
  return { image: IMAGE, network: { mode: 'none' }, resources: { cpus: 1, memoryMb: 256, pids: 64, diskMb: 64 }, maxLifetimeSeconds: 120 };
}

const cmd = (argv: string[], purpose: ExecRequest['purpose']): ExecRequest => ({ argv, purpose, timeoutMs: 20_000, maxOutputBytes: 200_000 });

describe('runValidationInSandbox', () => {
  beforeAll(async () => {
    await runProcess('docker', ['pull', IMAGE], { timeoutMs: 120_000 });
  }, 130_000);

  afterAll(async () => undefined);

  it('铺 patched 仓库 → 全部命令过 → passed', async () => {
    const outcome = await runValidationInSandbox({
      backend,
      spec: spec(),
      files: [
        { path: 'app.sh', content: 'echo built' },
        { path: 'test.sh', content: 'grep -q built app.sh' }, // relies on the file put in by putFile
      ],
      commands: [cmd(['sh', 'app.sh'], 'build'), cmd(['sh', 'test.sh'], 'test')],
    });
    expect(outcome.status).toBe('passed');
    expect(outcome.results.map((r) => r.passed)).toEqual([true, true]);
  });

  it('某命令失败 → partial;全失败 → failed', async () => {
    const partial = await runValidationInSandbox({
      backend,
      spec: spec(),
      files: [{ path: 'ok.sh', content: 'true' }],
      commands: [cmd(['sh', 'ok.sh'], 'build'), cmd(['sh', '-c', 'exit 3'], 'test')],
    });
    expect(partial.status).toBe('partial');
    const failed = await runValidationInSandbox({
      backend,
      spec: spec(),
      files: [],
      commands: [cmd(['sh', '-c', 'exit 1'], 'lint'), cmd(['sh', '-c', 'exit 2'], 'test')],
    });
    expect(failed.status).toBe('failed');
  });

  it('无命令 → not-run(空探测不误判通过)', async () => {
    const outcome = await runValidationInSandbox({ backend, spec: spec(), files: [], commands: [] });
    expect(outcome.status).toBe('not-run');
  });
});
