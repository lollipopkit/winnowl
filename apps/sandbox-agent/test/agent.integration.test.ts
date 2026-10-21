import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DockerSandboxBackend, HttpSandboxBackend, type SandboxSpec } from '@reviewbot/sandbox';
import { DockerAgentRuntime } from '../src/runtime.js';
import { buildAgent } from '../src/server.js';

const IMAGE = 'alpine:3.24';
const TOKEN = 'integration-token';
const spec: SandboxSpec = {
  image: IMAGE,
  network: { mode: 'none' },
  resources: { cpus: 1, memoryMb: 256, pids: 64, diskMb: 64 },
  maxLifetimeSeconds: 300,
};

const dockerUp = await new DockerSandboxBackend().isAvailable();

describe.skipIf(!dockerUp)('sandbox-agent on real docker (via HttpSandboxBackend)', () => {
  let app: FastifyInstance;
  let backend: HttpSandboxBackend;

  beforeAll(async () => {
    app = await buildAgent({
      runtime: new DockerAgentRuntime({ egressNetwork: 'unused-egress-network' }),
      tokenSha256: createHash('sha256').update(TOKEN).digest('hex'),
      allowedImages: new Set([IMAGE]),
      version: 'it',
      quiet: true,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    backend = new HttpSandboxBackend({
      baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
      token: TOKEN,
      ownerId: 'it-worker',
    });
  });
  afterAll(async () => app?.close());

  it('copies a tree in, runs commands, moves files, and destroys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-it-'));
    mkdirSync(join(dir, 'pkg'));
    writeFileSync(join(dir, 'pkg', 'a.txt'), 'hello from the worktree\n');

    const handle = await backend.create(spec);
    try {
      expect((await backend.health()).sandboxes).toBeGreaterThanOrEqual(1);
      await backend.copyInto(handle, dir, '/workspace/worktree');
      const cat = await backend.exec(handle, {
        argv: ['cat', '/workspace/worktree/pkg/a.txt'],
        purpose: 'inspect',
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
      });
      expect(cat.exitCode).toBe(0);
      expect(cat.stdout).toBe('hello from the worktree\n');

      const fail = await backend.exec(handle, {
        argv: ['sh', '-c', 'echo oops >&2; exit 3'],
        purpose: 'inspect',
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
      });
      expect(fail.exitCode).toBe(3);
      expect(fail.stderr).toContain('oops');

      await backend.putFile(handle, { path: '/workspace/input.json', content: '{"x":1}' });
      expect((await backend.getArtifact(handle, '/workspace/input.json')).content).toBe('{"x":1}');
    } finally {
      await backend.destroy(handle);
    }
    // Destroying twice is fine (already gone).
    await backend.destroy(handle);
  });
});
