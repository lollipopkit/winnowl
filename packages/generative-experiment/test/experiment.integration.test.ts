import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandboxBackend, runProcess, type SandboxHandle } from '@reviewbot/sandbox';
import { resetScratch, runOverlayExperiment } from '../src/index.js';

const IMAGE = 'alpine:3.24';
const backend = new DockerSandboxBackend();

// Requires Docker.
describe('generative experiment', () => {
  let handle: SandboxHandle;

  beforeAll(async () => {
    await runProcess('docker', ['pull', IMAGE], { timeoutMs: 120_000 });
    handle = await backend.create({
      image: IMAGE,
      network: { mode: 'none' },
      resources: { cpus: 1, memoryMb: 256, pids: 64, diskMb: 64 },
      maxLifetimeSeconds: 120,
    });
  });

  afterAll(async () => {
    await backend.destroy(handle);
  });

  it('临时测试在 overlay 运行,pristine source 不被修改', async () => {
    await backend.putFile(handle, { path: '/workspace/pristine.py', content: 'original content\n' });

    const result = await runOverlayExperiment(backend, handle, {
      testPath: 'repro.sh',
      testContent: 'echo BUG_REPRODUCED\n',
      command: { argv: ['sh', '/workspace/scratch/repro.sh'], purpose: 'confirm', timeoutMs: 10_000, maxOutputBytes: 4096 },
      assertions: [{ kind: 'stdout-contains', value: 'BUG_REPRODUCED' }],
    });

    expect(result.confirmed).toBe(true);
    expect(result.observation.stdout).toContain('BUG_REPRODUCED');

    const pristine = await backend.getArtifact(handle, '/workspace/pristine.py');
    expect(pristine.content).toBe('original content\n');

    await resetScratch(backend, handle);
    const check = await backend.exec(handle, { argv: ['sh', '-c', 'test -d /workspace/scratch'], purpose: 'inspect', timeoutMs: 5000, maxOutputBytes: 1024 });
    expect(check.exitCode).not.toBe(0);
    const stillThere = await backend.getArtifact(handle, '/workspace/pristine.py');
    expect(stillThere.content).toBe('original content\n');
  });
});
