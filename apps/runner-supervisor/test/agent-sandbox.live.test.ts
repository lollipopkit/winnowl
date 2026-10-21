import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveModelSourceFromEnv } from '@reviewbot/agent-pi';
import { HttpSandboxBackend, type SandboxSpec } from '@reviewbot/sandbox';
import { AgentSandbox, REPO_DIR } from '../src/agent-sandbox.js';
import { buildAgentSandboxTools } from '../src/agent-tools.js';
import { createSandboxFixProducer, validateInSandbox } from '../src/sandbox-fix.js';

/**
 * The sandbox fix agent end to end on a real sandbox host with a real model (opt-in, never in CI):
 *   AGENT_SANDBOX_LIVE=1 SANDBOX_AGENT_URL=http://<host>:8790 SANDBOX_AGENT_TOKEN=… \
 *   VALIDATION_SANDBOX_IMAGE=ghcr.io/lollipopkit/polyglot-ci:latest LLM_PROVIDER=… LLM_MODEL=… LLM_BASE_URL=… LLM_API_KEY=… \
 *     pnpm vitest run --project unit apps/runner-supervisor/test/agent-sandbox.live.test.ts
 * A small Node project with a bug and a failing test; installing its dev dependency goes through
 * the host's registry proxy.
 */
const env = process.env;
const live = env.AGENT_SANDBOX_LIVE && env.SANDBOX_AGENT_URL && env.SANDBOX_AGENT_TOKEN && env.LLM_MODEL ? describe : describe.skip;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-live-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'agent-live', version: '1.0.0', type: 'module', scripts: { test: 'node --test test/' }, devDependencies: { 'is-number': '7.0.0' } }, null, 2),
  );
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  // The bug: the average of an empty list is NaN instead of 0, and it divides by length - 1.
  writeFileSync(join(dir, 'src', 'stats.js'), 'export function average(xs) {\n  const sum = xs.reduce((a, b) => a + b, 0);\n  return sum / (xs.length - 1);\n}\n');
  writeFileSync(
    join(dir, 'test', 'stats.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport isNumber from 'is-number';\nimport { average } from '../src/stats.js';\n\ntest('average', () => {\n  assert.equal(average([2, 4, 6]), 4);\n  assert.equal(average([]), 0);\n  assert.ok(isNumber(average([1])));\n});\n",
  );
  return dir;
}

live('sandbox fix agent (live)', () => {
  it('fixes the bug in the sandbox, checks it with the tests, and the validation passes', async () => {
    const model = resolveModelSourceFromEnv();
    expect(model).not.toBeNull();
    const backend = new HttpSandboxBackend({ baseUrl: env.SANDBOX_AGENT_URL!, token: env.SANDBOX_AGENT_TOKEN!, ownerId: 'agent-sandbox-live-test' });
    const proxy = 'http://registry-proxy:3128';
    const spec: SandboxSpec = {
      image: env.VALIDATION_SANDBOX_IMAGE ?? 'ghcr.io/lollipopkit/polyglot-ci:latest',
      network: { mode: 'package-registry-only', ecosystems: ['npm', 'github'] },
      env: { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' },
      resources: { cpus: 1, memoryMb: 1024, pids: 1024, diskMb: 2048, workspace: 'disk' },
      maxLifetimeSeconds: 30 * 60,
    };
    const dir = project();
    const commands: string[] = [];
    const box = await AgentSandbox.open({
      backend,
      spec,
      deliverTree: (h, dest) => backend.copyInto(h, dir, dest),
      base: { cpus: 1, memoryMb: 512 },
      work: { cpus: 2, memoryMb: 2048 },
      diskMb: 2048,
      bounds: { minMemoryMb: 512, maxMemoryMb: 4096, minDiskMb: 1024, maxDiskMb: 4096 },
      task: 'Fix average() in src/stats.js of the repository agent-live: the tests in test/ fail.',
      judge: model!,
      idleShrinkMs: 5_000,
      log: (m, d) => console.log(m, d),
    });
    try {
      const tools = buildAgentSandboxTools(box, ['src/stats.js']).map((t) =>
        t.name === 'run_command'
          ? {
              ...t,
              execute: async (...args: Parameters<typeof t.execute>) => {
                const r = await t.execute(...args);
                commands.push(`${(args[1] as { command: string }).command} → ${JSON.stringify(r.details)}`);
                return r;
              },
            }
          : t,
      );
      const produce = createSandboxFixProducer({
        model: model!.model,
        streamFn: model!.streamFn,
        box,
        tools,
        context: 'Finding: average() returns wrong results (divides by length - 1; the empty list gives NaN instead of 0). Install the dev dependencies before running the tests.',
      });
      const fix = await produce({ plan: { kind: 'autofix', findingIds: [], constraints: [], expectedFiles: ['src/stats.js'], publicApiChangesAllowed: false, validationCommands: [] } } as never);
      console.log('commands:\n' + commands.join('\n'));
      console.log('patch:\n' + fix.patch);
      expect(fix.modifiedFiles).toEqual(['src/stats.js']);
      expect(commands.some((c) => c.includes('"exitCode":0'))).toBe(true);

      const outcome = await validateInSandbox(box, box.source([]).readFile, undefined);
      console.log('validation', outcome.status, outcome.results.map((r) => `${r.command}: ${r.passed}`));
      expect(outcome.status).toBe('passed');
      expect(REPO_DIR).toBe('/workspace/repo');
    } finally {
      const usage = await box.close();
      console.log('usage', JSON.stringify(usage));
    }
  }, 900_000);
});
