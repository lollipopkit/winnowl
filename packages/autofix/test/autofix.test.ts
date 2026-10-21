import { describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import type {
  ArtifactContent,
  ExecRequest,
  ExecResult,
  PutFileRequest,
  SandboxBackend,
  SandboxHandle,
  SandboxSpec,
} from '@reviewbot/sandbox';
import type { ArtifactRef } from '@reviewbot/artifacts';
import {
  computeValidationStatus,
  createAgentFixProducer,
  decideDelivery,
  runFixPipeline,
  stackedBranchName,
  stackedIdempotencyKey,
  toValidationResult,
  type FixPlan,
  type ProducedFix,
} from '../src/index.js';

function execResult(argv: string[], exitCode: number): ExecResult {
  return {
    exitCode,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    durationMs: 5,
    evidence: {
      image: 'alpine:3.24',
      runtime: 'runc',
      argv,
      purpose: 'autofix-validation',
      exitCode,
      timedOut: false,
      durationMs: 5,
    },
  };
}

/** Scripted SandboxBackend: exit code by argv[0]. */
function fakeBackend(exitByCmd: Record<string, number>): { backend: SandboxBackend; destroyed: () => number } {
  let destroyCount = 0;
  const backend: SandboxBackend = {
    async create(_spec: SandboxSpec): Promise<SandboxHandle> {
      return { id: 'sbx-1', containerId: 'c1' };
    },
    async exec(_handle: SandboxHandle, req: ExecRequest): Promise<ExecResult> {
      const key = req.argv[0] ?? '';
      return execResult(req.argv, exitByCmd[key] ?? 0);
    },
    async putFile(_handle: SandboxHandle, _req: PutFileRequest): Promise<void> {},
    async getArtifact(_handle: SandboxHandle, path: string): Promise<ArtifactContent> {
      return { path, content: '', bytes: 0 };
    },
    async destroy(_handle: SandboxHandle): Promise<void> {
      destroyCount += 1;
    },
  };
  return { backend, destroyed: () => destroyCount };
}

const SPEC: SandboxSpec = {
  image: 'alpine:3.24',
  network: { mode: 'none' },
  resources: { cpus: 1, memoryMb: 512, pids: 64, diskMb: 256 },
};

function cmd(argv: string[]): ExecRequest {
  return { argv, purpose: 'autofix-validation', timeoutMs: 60_000, maxOutputBytes: 1_000_000 };
}

const PLAN: FixPlan = {
  kind: 'autofix',
  findingIds: ['f-2', 'f-1'],
  constraints: ['no public api change'],
  expectedFiles: ['src/a.ts'],
  publicApiChangesAllowed: false,
  validationCommands: [cmd(['npm', 'test'])],
};

const fakeArtifact: ArtifactRef = { id: 'art-1', storageKey: 'k', sha256: 'abc', bytes: 10 };
const produced: ProducedFix = {
  patch: '--- a\n+++ b\n',
  modifiedFiles: ['src/a.ts'],
  residualRisks: [],
  confidence: 0.8,
};

describe('branch naming', () => {
  it('winnowl/{change}/{action}', () => {
    expect(stackedBranchName(42, 'act-1')).toBe('winnowl/42/act-1');
  });
  it('清洗非法字符防 ref 注入', () => {
    expect(stackedBranchName('4 2', '../evil')).toBe('winnowl/4-2/evil');
  });
  it('幂等键与 finding 顺序无关', () => {
    const a = stackedIdempotencyKey({ baseHeadSha: 'h', findingIds: ['f-1', 'f-2'], kind: 'autofix' });
    const b = stackedIdempotencyKey({ baseHeadSha: 'h', findingIds: ['f-2', 'f-1'], kind: 'autofix' });
    expect(a).toBe(b);
  });
});

describe('validation 聚合', () => {
  it('not-run / passed / failed / partial', () => {
    expect(computeValidationStatus([])).toBe('not-run');
    const pass = toValidationResult(cmd(['a']), execResult(['a'], 0));
    const fail = toValidationResult(cmd(['b']), execResult(['b'], 1));
    expect(computeValidationStatus([pass])).toBe('passed');
    expect(computeValidationStatus([fail])).toBe('failed');
    expect(computeValidationStatus([pass, fail])).toBe('partial');
  });
});

describe('decideDelivery', () => {
  it('通过 + 已确认 → stacked,可 resolve,永不 ready/approve', () => {
    const d = decideDelivery({ status: 'passed', branchWriteConfirmed: true, failedCommands: [], residualRisks: [] });
    expect(d.delivery).toBe('stacked-change-request');
    expect(d.validationFailed).toBe(false);
    expect(d.resolveFinding).toBe(true);
    expect(d.readyForMerge).toBe(false);
    expect(d.requestApprove).toBe(false);
    expect(d.titleMarker).toBeUndefined();
  });
  it('失败 → Validation failed 标记,不 resolve', () => {
    const d = decideDelivery({ status: 'failed', branchWriteConfirmed: true, failedCommands: ['npm test'], residualRisks: ['perf'] });
    expect(d.titleMarker).toBe('Validation failed');
    expect(d.resolveFinding).toBe(false);
    expect(d.bodyNotes.join(' ')).toContain('npm test');
    expect(d.bodyNotes.join(' ')).toContain('Residual risk: perf');
  });
  it('未确认 branch-write → 只交付 artifact', () => {
    const d = decideDelivery({ status: 'passed', branchWriteConfirmed: false, failedCommands: [], residualRisks: [] });
    expect(d.delivery).toBe('artifact');
  });

  it('§37 delivery 白名单不含 stacked → 降级 artifact 并在正文注明,不 blocked', () => {
    const d = decideDelivery({
      status: 'passed',
      branchWriteConfirmed: true,
      failedCommands: [],
      residualRisks: [],
      allowedDeliveries: ['artifact'],
    });
    expect(d.delivery).toBe('artifact');
    expect(d.blockedByPolicy).toBe(false);
    expect(d.bodyNotes.join(' ')).toContain('disabled by repository config');
  });

  it('§37 delivery 为空(两种形态都禁)→ blockedByPolicy,调用方须中止', () => {
    const d = decideDelivery({
      status: 'passed',
      branchWriteConfirmed: true,
      failedCommands: [],
      residualRisks: [],
      allowedDeliveries: [],
    });
    expect(d.blockedByPolicy).toBe(true);
  });

  it('delivery 白名单含 stacked → 与缺省一致(不干扰既有行为)', () => {
    const d = decideDelivery({
      status: 'passed',
      branchWriteConfirmed: true,
      failedCommands: [],
      residualRisks: [],
      allowedDeliveries: ['artifact', 'stacked-change-request'],
    });
    expect(d.delivery).toBe('stacked-change-request');
    expect(d.blockedByPolicy).toBe(false);
  });
});

describe('runFixPipeline', () => {
  it('验证通过 → stacked CR + 分支 + 幂等键,并销毁 sandbox', async () => {
    const { backend, destroyed } = fakeBackend({ npm: 0 });
    const outcome = await runFixPipeline({
      plan: PLAN,
      backend,
      spec: SPEC,
      produceFix: async () => produced,
      storePatch: async () => fakeArtifact,
      branchWriteConfirmed: true,
      changeNumber: 42,
      actionId: 'act-1',
      baseHeadSha: 'head-abc',
    });
    expect(outcome.result.validationStatus).toBe('passed');
    expect(outcome.result.delivery).toBe('stacked-change-request');
    expect(outcome.result.patchArtifact).toEqual(fakeArtifact);
    expect(outcome.stacked?.branch).toBe('winnowl/42/act-1');
    expect(outcome.stacked?.idempotencyKey).toContain('head-abc');
    expect(destroyed()).toBe(1);
  });

  it('验证失败 → 标记 Validation failed,不 resolve', async () => {
    const { backend } = fakeBackend({ npm: 1 });
    const outcome = await runFixPipeline({
      plan: PLAN,
      backend,
      spec: SPEC,
      produceFix: async () => produced,
      storePatch: async () => fakeArtifact,
      branchWriteConfirmed: true,
      changeNumber: 42,
      actionId: 'act-1',
      baseHeadSha: 'head-abc',
    });
    expect(outcome.result.validationStatus).toBe('failed');
    expect(outcome.delivery.validationFailed).toBe(true);
    expect(outcome.delivery.resolveFinding).toBe(false);
    expect(outcome.delivery.titleMarker).toBe('Validation failed');
  });

  it('sandbox 抛错也销毁(finally)', async () => {
    const { backend, destroyed } = fakeBackend({ npm: 0 });
    await expect(
      runFixPipeline({
        plan: PLAN,
        backend,
        spec: SPEC,
        produceFix: async () => {
          throw new Error('agent boom');
        },
        storePatch: async () => fakeArtifact,
        branchWriteConfirmed: true,
        changeNumber: 42,
        actionId: 'act-1',
        baseHeadSha: 'head-abc',
      }),
    ).rejects.toThrow('agent boom');
    expect(destroyed()).toBe(1);
  });
});

describe('createAgentFixProducer', () => {
  it('经终结工具产出 patch', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(
        faux.toolCall('submit_fix', {
          patch: '--- a\n+++ b\n@@\n-old\n+new\n',
          modifiedFiles: ['src/a.ts'],
          residualRisks: ['none'],
          confidence: 1.5,
        }),
      ),
    ]);
    const produce = createAgentFixProducer({ model: faux.model, streamFn: faux.streamFn });
    const { backend } = fakeBackend({});
    const handle = await backend.create(SPEC);
    const fix = await produce({ handle, backend, plan: PLAN });
    expect(fix.modifiedFiles).toEqual(['src/a.ts']);
    expect(fix.confidence).toBe(1); // clamped to [0,1]
    expect(fix.patch).toContain('+new');
  });
});
