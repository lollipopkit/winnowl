import { describe, expect, it } from 'vitest';
import { createFauxAgent } from '@reviewbot/agent-pi';
import {
  decideAutoIssues,
  enrichIssue,
  planImplementation,
  resolveAutoApply,
  type AutoIssueFinding,
} from '../src/index.js';

function finding(over: Partial<AutoIssueFinding>): AutoIssueFinding {
  return {
    findingId: 'f1',
    fingerprint: 'fp1',
    title: 'null deref',
    severity: 'high',
    changeRelation: 'preexisting-unrelated',
    confirmation: 'independently-verified',
    evidencePermalink: 'https://x/blob/sha/a.ts#L1',
    evidenceSummary: 'null deref at a.ts:1',
    ...over,
  };
}

describe('decideAutoIssues', () => {
  it('未开启 → 全 skip', () => {
    const d = decideAutoIssues([finding({})], { config: { enabled: false, minSeverity: 'low', maxPerReview: 5 }, existingFingerprints: new Set() });
    expect(d.create).toHaveLength(0);
    expect(d.skipped[0]!.reason).toContain('未开启');
  });

  it('门槛:非 preexisting-unrelated / 确认不足 / 严重度不足 / 去重 均排除', () => {
    const findings = [
      finding({ findingId: 'a', changeRelation: 'introduced' }),
      finding({ findingId: 'b', fingerprint: 'fpb', confirmation: 'code-supported' }),
      finding({ findingId: 'c', fingerprint: 'fpc', severity: 'low' }),
      finding({ findingId: 'd', fingerprint: 'fpd' }), // issue exists
      finding({ findingId: 'e', fingerprint: 'fpe' }), // eligible
    ];
    const d = decideAutoIssues(findings, {
      config: { enabled: true, minSeverity: 'medium', maxPerReview: 10 },
      existingFingerprints: new Set(['fpd']),
    });
    expect(d.create.map((c) => c.findingId)).toEqual(['e']);
    expect(d.create[0]!.labels).toEqual(['ai-found']);
    expect(d.create[0]!.body).toContain('Evidence: https://x/blob/sha/a.ts#L1');
    // No private artifact content: only summary and permalink.
    expect(d.create[0]!.body).not.toContain('artifact');
  });

  it('限量:按严重度取前 N,其余 skip', () => {
    const findings = [
      finding({ findingId: 'hi', fingerprint: 'f-hi', severity: 'critical' }),
      finding({ findingId: 'mid', fingerprint: 'f-mid', severity: 'high' }),
      finding({ findingId: 'lo', fingerprint: 'f-lo', severity: 'medium' }),
    ];
    const d = decideAutoIssues(findings, { config: { enabled: true, minSeverity: 'low', maxPerReview: 2 }, existingFingerprints: new Set() });
    expect(d.create.map((c) => c.findingId)).toEqual(['hi', 'mid']);
    expect(d.skipped.find((s) => s.findingId === 'lo')?.reason).toContain('上限');
  });
});

describe('resolveAutoApply', () => {
  it('默认关闭 → 全部挂起', () => {
    expect(resolveAutoApply(['bug', 'p1'], { autoApply: false })).toEqual({ apply: [], heldForApproval: ['bug', 'p1'] });
  });
  it('开启但需 Admin 未批 → 挂起;已批 → 应用', () => {
    expect(resolveAutoApply(['bug'], { autoApply: true, requireAdminApproval: true, adminApproved: false }).apply).toEqual([]);
    expect(resolveAutoApply(['bug'], { autoApply: true, requireAdminApproval: true, adminApproved: true }).apply).toEqual(['bug']);
  });
});

describe('enrichIssue / planImplementation', () => {
  it('enrichment 经终结工具产出并 coerce 非法枚举', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('submit_enrichment', {
        duplicateOf: ['#12'], relatedIssues: [], relatedChangeRequests: [], relatedCode: [{ file: 'a.ts' }],
        suggestedLabels: ['bug'], suggestedOwners: ['@alice'], reproductionQuestions: ['repro steps?'],
        feasibility: 'clear', riskClassification: 'weird',
      })),
    ]);
    const e = await enrichIssue({ title: 'crash', body: 'boom' }, { model: faux.model, streamFn: faux.streamFn });
    expect(e.duplicateOf).toEqual(['#12']);
    expect(e.feasibility).toBe('clear');
    expect(e.riskClassification).toBe('medium'); // invalid value coerced
  });

  it('plan 输出并保留 open questions(不假装验证)', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('submit_plan', {
        understanding: 'race in cache', assumptions: ['单进程'], relatedCode: [{ file: 'cache.ts', symbol: 'get' }],
        likelyRootCause: '缺锁', changeSteps: ['加锁'], testSteps: ['并发测试'], risks: ['死锁'],
        openQuestions: ['是否多实例?'], canStartCodingAgent: false,
      })),
    ]);
    const p = await planImplementation({ title: 'race', body: '...' }, { model: faux.model, streamFn: faux.streamFn });
    expect(p.openQuestions).toContain('是否多实例?');
    expect(p.canStartCodingAgent).toBe(false);
    expect(p.relatedCode[0]).toMatchObject({ file: 'cache.ts', symbol: 'get' });
  });
});
