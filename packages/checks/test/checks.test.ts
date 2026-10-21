import { describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import {
  decideMergeGate,
  evaluateDeterministicChecks,
  runAgenticCheck,
  type CheckResult,
  type DeterministicSignals,
} from '../src/index.js';

const OK_SIGNALS: DeterministicSignals = {
  hasTitleAndDescription: true,
  linkedIssue: true,
  requiredTestsPresent: true,
  unresolvedBlockingFindings: 0,
  reviewHealthComplete: true,
  requiredDocsPresent: true,
  requiredMigrationPresent: true,
  approvalsMet: true,
};

describe('evaluateDeterministicChecks', () => {
  it('全满足 → 全 pass;blocking 未解决 → fail', () => {
    expect(evaluateDeterministicChecks(OK_SIGNALS, 'sha1').every((c) => c.status === 'pass')).toBe(true);
    const bad = evaluateDeterministicChecks({ ...OK_SIGNALS, unresolvedBlockingFindings: 2 }, 'sha1');
    expect(bad.find((c) => c.id === 'no-unresolved-blocking')?.status).toBe('fail');
    expect(bad[0]!.revisionSha).toBe('sha1');
  });
});

describe('decideMergeGate', () => {
  const passChecks: CheckResult[] = [{ id: 'x', type: 'deterministic', status: 'pass', evidence: [], explanation: '', revisionSha: 's' }];
  const failCheck: CheckResult[] = [{ id: 'y', type: 'deterministic', status: 'fail', evidence: [], explanation: '', revisionSha: 's' }];

  it('默认未启用 → 不阻断,永不 request changes', () => {
    const d = decideMergeGate({ config: { enabled: false, requiredConfirmation: 'independently-verified' }, checks: failCheck, blockingFindings: [{ confirmation: 'tool-confirmed' }] });
    expect(d.checkStatus).toBe('neutral');
    expect(d.requestChanges).toBe(false);
  });

  it('启用后:达确认等级的 blocking Finding → failure', () => {
    const d = decideMergeGate({ config: { enabled: true, requiredConfirmation: 'independently-verified' }, checks: passChecks, blockingFindings: [{ confirmation: 'tool-confirmed' }] });
    expect(d.checkStatus).toBe('failure');
    expect(d.requestChanges).toBe(false);
  });

  it('启用后:确认等级不足的 Finding 不致失败', () => {
    const d = decideMergeGate({ config: { enabled: true, requiredConfirmation: 'independently-verified' }, checks: passChecks, blockingFindings: [{ confirmation: 'code-supported' }] });
    expect(d.checkStatus).toBe('success');
  });

  it('unknown 默认不阻断;显式配置才阻断', () => {
    const unknown: CheckResult[] = [{ id: 'u', type: 'agentic', status: 'unknown', evidence: [], explanation: '', revisionSha: 's' }];
    expect(decideMergeGate({ config: { enabled: true, requiredConfirmation: 'independently-verified' }, checks: unknown, blockingFindings: [] }).checkStatus).toBe('success');
    expect(decideMergeGate({ config: { enabled: true, requiredConfirmation: 'independently-verified', blockOnUnknown: true }, checks: unknown, blockingFindings: [] }).checkStatus).toBe('failure');
  });
});

describe('runAgenticCheck', () => {
  it('经终结工具产出;非法状态 coerce 为 unknown', async () => {
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('submit_check', { status: 'weird', explanation: '无法确认' }))]);
    const r = await runAgenticCheck({ kind: 'backward-compatibility', policy: '不破坏 API', context: 'diff...', revisionSha: 'sha9' }, { model: faux.model, streamFn: faux.streamFn });
    expect(r.status).toBe('unknown');
    expect(r.revisionSha).toBe('sha9');
    expect(r.type).toBe('agentic');
  });
});
