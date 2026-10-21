import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import { DockerSandboxBackend, runProcess, type SandboxSpec } from '@reviewbot/sandbox';
import { AgentSandbox, commandOutputText, repoPath } from '../src/agent-sandbox.js';
import { buildAgentSandboxTools } from '../src/agent-tools.js';
import { changedFiles, createSandboxFixProducer, validateInSandbox } from '../src/sandbox-fix.js';

// Needs Docker (pnpm test:integration). A small image with what the agent sandbox relies on (GNU tar:
// busybox tar cannot read the pax headers macOS's bsdtar writes when the tests run on a Mac).
const IMAGE = 'winnowl-agent-sandbox-test:local';
const backend = new DockerSandboxBackend();
const bounds = { minMemoryMb: 128, maxMemoryMb: 512, minDiskMb: 64, maxDiskMb: 1024 };

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-sandbox-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'math.sh'), 'add() { echo $(( $1 - $2 )); }\n');
  writeFileSync(join(dir, 'test.sh'), '. ./src/math.sh\n[ "$(add 2 3)" = 5 ] && echo ok || { echo "add 2 3 gave $(add 2 3)"; exit 1; }\n');
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  // A worktree's `.git` is a file pointing at a repository that is not in the sandbox.
  writeFileSync(join(dir, '.git'), 'gitdir: /srv/clones/x/.git/worktrees/head\n');
  return dir;
}

const spec: SandboxSpec = {
  image: IMAGE,
  network: { mode: 'none' },
  resources: { cpus: 1, memoryMb: 128, pids: 256, diskMb: 512, workspace: 'disk' },
  maxLifetimeSeconds: 600,
};

async function open(judgeVerdict: 'allow' | 'deny' = 'deny', idleShrinkMs = 60_000) {
  const dir = repo();
  return AgentSandbox.open({
    backend,
    spec,
    deliverTree: (h, dest) => backend.copyInto(h, dir, dest),
    base: { cpus: 1, memoryMb: 128 },
    work: { cpus: 1, memoryMb: 256 },
    diskMb: 512,
    bounds,
    task: 'Fix add() in src/math.sh so that test.sh passes.',
    judge: async () => ({ verdict: judgeVerdict, reason: `judge says ${judgeVerdict}` }),
    idleShrinkMs,
  } as Parameters<typeof AgentSandbox.open>[0]);
}

describe('AgentSandbox (docker)', () => {
  const boxes: AgentSandbox[] = [];
  beforeAll(async () => {
    const r = await runProcess('docker', ['build', '-q', '-t', IMAGE, '-'], {
      input: 'FROM alpine:3.24\nRUN apk add --no-cache git ripgrep tar && mkdir -m 1777 /workspace\n',
      timeoutMs: 300_000,
    });
    if (r.code !== 0) throw new Error(r.stderr);
  }, 320_000);
  afterAll(async () => {
    for (const b of boxes) await b.close().catch(() => undefined);
  });

  it('reads, searches, edits and runs commands in its own copy; the change is a git diff', async () => {
    const box = await open('allow');
    boxes.push(box);
    const src = box.source(['src/math.sh']);
    expect(await src.readFile('src/math.sh')).toContain('$1 - $2');
    expect(await src.readFile('../../etc/passwd')).toBeNull();
    expect((await src.searchCode('ADD()'))[0]).toMatchObject({ path: 'src/math.sh', line: 1 });
    expect((await src.searchSymbol!('add')).map((h) => h.path).sort()).toEqual(['src/math.sh', 'test.sh']);

    const failing = await box.runCommand('sh test.sh', { purpose: 'run the test' });
    // A repository script goes to the judge (here: allows).
    expect(failing.decision).toMatchObject({ verdict: 'allow', decidedBy: 'judge', rule: 'script' });
    expect(failing.result?.exitCode).toBe(1);
    expect(commandOutputText(failing)).toContain('add 2 3 gave -1');

    const tools = buildAgentSandboxTools(box, ['src/math.sh']);
    const edit = tools.find((t) => t.name === 'edit_file')!;
    const r = await edit.execute('1', { path: 'src/math.sh', old: '$1 - $2', new: '$1 + $2' } as never, undefined as never, undefined as never);
    expect(JSON.stringify(r)).toContain('edited src/math.sh');
    expect((await box.runCommand('sh test.sh')).result?.stdout.trim()).toBe('ok');
    // What commands write is not part of the change (ignored or not).
    await box.runCommand('mkdir -p out && echo x > out/log && echo y > notes.txt');

    const patch = await box.diff();
    expect(changedFiles(patch)).toEqual(['src/math.sh']);
    expect(patch).toContain('+add() { echo $(( $1 + $2 )); }');
  }, 120_000);

  it('the gate decides before anything runs: rules deny, the judge decides the rest', async () => {
    const box = await open('deny');
    boxes.push(box);
    const pushed = await box.runCommand('git push origin HEAD');
    expect(pushed).toMatchObject({ decision: { verdict: 'deny', decidedBy: 'rule', rule: 'git-out' } });
    expect(pushed.result).toBeUndefined();
    const judged = await box.runCommand('strace ls', { purpose: 'see syscalls' });
    expect(judged.decision).toMatchObject({ verdict: 'deny', decidedBy: 'judge', reason: 'judge says deny' });
    expect(commandOutputText(judged)).toBe('Command denied (review): judge says deny');
  }, 120_000);

  it('grows to the work size for a command and shrinks back once idle', async () => {
    const box = await open('allow', 300);
    boxes.push(box);
    expect((await backend.usage(box.handle)).memoryMb).toBe(128);
    await box.runCommand('sleep 1 &  wait');
    await box.runCommand('true');
    expect((await backend.usage(box.handle)).memoryMb).toBe(256);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await backend.usage(box.handle)).memoryMb).toBe(128);
  }, 120_000);

  it('the sandbox fix producer returns the diff the agent left, and validation runs in the same sandbox', async () => {
    const box = await open();
    boxes.push(box);
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('edit_file', { path: 'src/math.sh', old: '$1 - $2', new: '$1 + $2' })),
      faux.assistant(faux.toolCall('run_command', { command: 'sh test.sh', purpose: 'check the fix' })),
      faux.assistant(faux.toolCall('finish_fix', { summary: 'subtract → add', residualRisks: [], confidence: 0.9 })),
    ]);
    const produce = createSandboxFixProducer({
      model: faux.model,
      streamFn: faux.streamFn,
      box,
      tools: buildAgentSandboxTools(box, ['src/math.sh']),
      context: 'Finding: add() subtracts.',
    });
    const fix = await produce({ plan: { kind: 'autofix', findingIds: [], constraints: [], expectedFiles: ['src/math.sh'], publicApiChangesAllowed: false, validationCommands: [] } } as never);
    expect(fix).toMatchObject({ modifiedFiles: ['src/math.sh'], confidence: 0.9 });
    expect(fix.patch).toContain('+add() { echo $(( $1 + $2 )); }');

    // Platform commands can run in a project directory of the repository.
    expect((await box.runPlatform(['pwd'], 10_000, 'test', 'src')).stdout.trim()).toBe('/workspace/repo/src');
    // A file a command left is gone before validation; the agent's change stays.
    await box.runCommand('echo scratch > notes.txt');
    const outcome = await validateInSandbox(box, box.source([]).readFile, { auto_detect: false, commands: { test: ['sh test.sh && test ! -e notes.txt'] } });
    expect(outcome.status).toBe('passed');
  }, 120_000);
});

describe('repoPath', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['/workspace/repo/src/a.ts', 'src/a.ts'],
    ['./x/../y', 'y'],
    ['../etc/passwd', null],
    ['a/../../b', null],
    ['', null],
  ])('%s → %s', (input, want) => {
    expect(repoPath(input)).toBe(want);
  });
});
