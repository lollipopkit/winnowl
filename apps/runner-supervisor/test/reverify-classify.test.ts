import type { DiscussionThread } from '@reviewbot/provider-contracts';
import type { VerificationVerdict, VerifiedCandidate } from '@reviewbot/verification';
import { describe, expect, it } from 'vitest';
import { replyKey } from '../src/reply-key.js';
import { classifyReverify, findThread, reverifyRationale } from '../src/reverify-findings.js';

/** Builds a VerifiedCandidate with only the fields classify reads. */
function verified(v: Partial<VerificationVerdict>, refuterUpheld?: boolean): VerifiedCandidate {
  const verdict: VerificationVerdict = {
    candidateId: 'c1',
    decision: 'accept',
    introducedByChange: true,
    reachable: true,
    actionable: true,
    changeRelation: 'introduced',
    severity: 'high',
    confirmation: 'independently-verified',
    residualUncertainty: [],
    incomplete: false,
    ...v,
  };
  return { verdict, ...(refuterUpheld !== undefined ? { refuterUpheld } : {}) };
}

describe('classifyReverify(§26.3 三态裁定)', () => {
  it('reject → retract(唯一撤销路径)', () => {
    expect(classifyReverify(verified({ decision: 'reject' }), 'correctness', true)).toBe('retract');
  });

  it('uncertain → uphold(拿不准,保守维持不撤销)', () => {
    expect(classifyReverify(verified({ decision: 'uncertain', severity: 'high' }), 'correctness', true)).toBe('uphold');
  });

  it('accept 且仍阻断(high + 独立验证 + refuter 维持 + introduced)→ uphold', () => {
    const v = verified({ decision: 'accept', severity: 'high', confirmation: 'independently-verified', changeRelation: 'introduced' }, true);
    expect(classifyReverify(v, 'correctness', true)).toBe('uphold');
  });

  it('accept 但不再阻断(severity 降到 low = nitpick)+ 原为 blocking → downgrade', () => {
    // low is a nitpick and never blocks; a previously blocking finding is downgraded.
    const v = verified({ decision: 'accept', severity: 'low', confirmation: 'independently-verified', changeRelation: 'introduced' });
    expect(classifyReverify(v, 'correctness', true)).toBe('downgrade');
  });

  it('门禁口径跟随仓库配置:默认 medium 不阻断,原本阻断的 medium 算降级;仓库列入 medium 时维持', () => {
    const v = verified({ decision: 'accept', severity: 'medium', confirmation: 'independently-verified', changeRelation: 'introduced' }, true);
    expect(classifyReverify(v, 'correctness', true)).toBe('downgrade');
    expect(classifyReverify(v, 'correctness', true, { blockOnSeverity: ['critical', 'high', 'medium'] })).toBe('uphold');
  });

  it('accept 但原本就非 blocking → uphold(无降级空间)', () => {
    const v = verified({ decision: 'accept', severity: 'low', confirmation: 'independently-verified', changeRelation: 'introduced' });
    expect(classifyReverify(v, 'correctness', false)).toBe('uphold');
  });
});

describe('findThread(按锚点 + isBot 定位复核目标线程)', () => {
  const thread = (path: string | undefined, line: number | undefined, isBot: boolean): DiscussionThread =>
    ({
      ref: { nativeId: 'c1' },
      resolved: false,
      ...(path && line !== undefined ? { anchor: { path, side: 'head', line } } : {}),
      comments: [{ nativeId: 'c1', author: { id: 'u', login: 'winnowl[bot]' }, body: 'x', createdAt: '', isBot }],
    }) as DiscussionThread;

  it('path+line 匹配且有 bot 评论 → 命中', () => {
    const threads = [thread('src/a.ts', 1, false), thread('src/b.ts', 5, true)];
    expect(findThread(threads, { path: 'src/b.ts', line: 5 })?.comments[0]!.nativeId).toBe('c1');
  });

  it('anchor 缺失(旧 adapter 未填)→ 不命中(暴露过的 bug)', () => {
    const threads = [thread(undefined, undefined, true)];
    expect(findThread(threads, { path: 'src/b.ts', line: 5 })).toBeUndefined();
  });

  it('line 不同 → 不命中', () => {
    const threads = [thread('src/b.ts', 9, true)];
    expect(findThread(threads, { path: 'src/b.ts', line: 5 })).toBeUndefined();
  });

  it('匹配但非 bot 线程 → 不命中(不回复人类线程)', () => {
    const threads = [thread('src/b.ts', 5, false)];
    expect(findThread(threads, { path: 'src/b.ts', line: 5 })).toBeUndefined();
  });
});

describe('re-verification answers the author', () => {
  it('shows the verifier rationale, or the refuter arguments when the refuter overturned it', () => {
    expect(reverifyRationale(verified({ rationale: '  The guard at a.ts:3\n rejects [].  ' }))).toBe('The guard at a.ts:3 rejects [].');
    const refuted: VerifiedCandidate = {
      ...verified({ decision: 'reject', rationale: 'verifier said yes' }),
      refutation: { candidateId: 'c1', decision: 'reject', arguments: ['form.ts:12 requires one sample.'] },
    };
    expect(reverifyRationale(refuted)).toBe('form.ts:12 requires one sample.');
    expect(reverifyRationale(verified({}))).toBeUndefined();
  });

  it('a new explanation on the same head is a new reply, the same one is not', () => {
    expect(replyKey(undefined)).toBe('');
    expect(replyKey('a')).toBe(replyKey('a'));
    expect(replyKey('a')).not.toBe(replyKey('b'));
  });
});
