import { describe, expect, it } from 'vitest';
import type { CommandRunResult } from '@reviewbot/command-gate';
import { buildActionsCommandTools } from '../src/commands.js';
// @ts-expect-error plain JS shipped with the action
import { commandEnv } from '../../../action/command-env.mjs';

const ok = (stdout: string): CommandRunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false, durationMs: 1200 });
// Never reached: these commands are settled by the rules.
const judge = { model: undefined as never, streamFn: undefined as never };

function tools(run: (cmd: string) => Promise<CommandRunResult>) {
  const log: string[] = [];
  const [tool] = buildActionsCommandTools({ socketPath: '/x.sock', task: 'Review a pull request', judge, log: (l) => log.push(l), run: (_s, c) => run(c) });
  const call = async (command: string) => {
    const r = await tool!.execute('id', { command, purpose: 'test' });
    return (r.content[0] as { text: string }).text;
  };
  return { call, log };
}

describe('run_command in GitHub Actions', () => {
  it('runs what the gate allows and refuses the rest without running it', async () => {
    const ran: string[] = [];
    const { call, log } = tools(async (c) => (ran.push(c), ok('passed')));
    expect(await call('npm test')).toContain('exit code 0');
    expect(await call('npm publish')).toMatch(/^Command denied \(rule\)/);
    expect(ran).toEqual(['npm test']);
    expect(log).toEqual(['run_command [allow] npm test', 'run_command [deny] npm publish']);
  });

  it('runs one command at a time', async () => {
    let active = 0;
    let peak = 0;
    const { call } = tools(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return ok('');
    });
    await Promise.all([call('npm test'), call('npm run lint'), call('ls')]);
    expect(peak).toBe(1);
  });

  it('reports a host failure as not run', async () => {
    const { call } = tools(async () => {
      throw new Error('command host: HTTP 409 another command is running');
    });
    expect(await call('npm test')).toBe('Command not run: command host: HTTP 409 another command is running');
  });
});

describe('commandEnv: what review commands see of the runner', () => {
  it('keeps toolchain variables and drops credentials and runner internals', () => {
    const env = commandEnv(
      {
        PATH: '/opt/hostedtoolcache/node/bin:/usr/bin',
        JAVA_HOME: '/usr/lib/jvm/17',
        HOME: '/nonexistent/runner',
        CARGO_HOME: '/nonexistent/runner/.cargo',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'x',
        GITHUB_TOKEN: 'x',
        LLM_API_KEY: 'x',
        NPM_TOKEN: 'x',
        MY_SECRET: 'x',
        AWS_SECRET_ACCESS_KEY: 'x',
        SSH_AUTH_SOCK: '/tmp/agent',
        INPUT_LLM_API_KEY: 'x',
        GPG_PASSPHRASE: 'x',
        DEPLOY_KEY: 'x',
        GH_PAT: 'x',
        DATABASE_URL: 'x',
        SENTRY_DSN: 'x',
        NPM_REGISTRY: 'https://ci:hunter2@npm.example.com/',
        GOFLAGS: '-mod=mod',
      },
      'winnowl-cmd',
    );
    expect(env).toEqual({
      PATH: '/opt/hostedtoolcache/node/bin:/usr/bin',
      JAVA_HOME: '/usr/lib/jvm/17',
      GOFLAGS: '-mod=mod',
      CARGO_HOME: '/home/winnowl-cmd/.cargo',
      HOME: '/home/winnowl-cmd',
      USER: 'winnowl-cmd',
      LOGNAME: 'winnowl-cmd',
      CI: 'true',
    });
  });
});
