import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentPoolSandboxBackend } from '@reviewbot/sandbox';
import { agentToken, createSandboxBackend, sandboxCapacity } from '../src/sandbox-backend.js';

const logger = { info: () => undefined, warn: () => undefined };

describe('sandbox backend selection', () => {
  it('SANDBOX_BACKEND=agents builds the host pool and sizes the sandbox lane from its slots', () => {
    const env = {
      SANDBOX_BACKEND: 'agents',
      SANDBOX_AGENTS: 'sandbox-1=http://100.1.2.3:8790=8,hel=http://100.4.5.6:8790=4',
      SANDBOX_AGENT_SECRET: 's3cret',
      APP_VERSION: 'abc',
    };
    expect(sandboxCapacity(env)).toBe(12);
    const { sandbox } = createSandboxBackend({ workerId: 'w1', logger, env });
    expect(sandbox).toBeInstanceOf(AgentPoolSandboxBackend);
    expect((sandbox as AgentPoolSandboxBackend).capacity).toBe(12);
    expect(() =>
      createSandboxBackend({ workerId: 'w1', logger, env: { ...env, SANDBOX_AGENT_SECRET: '' } }),
    ).toThrow(/SANDBOX_AGENT_SECRET/);
    expect(sandboxCapacity({})).toBe(1);
  });

  it('derives per-host agent tokens; the agent is configured with their sha256', () => {
    const token = agentToken('s3cret', 'vie');
    expect(token).toBe(createHmac('sha256', 's3cret').update('vie').digest('hex'));
    expect(agentToken('s3cret', 'hel')).not.toBe(token);
    expect(createHash('sha256').update(token).digest('hex')).toMatch(/^[0-9a-f]{64}$/);
  });
});
