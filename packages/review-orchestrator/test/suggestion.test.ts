import { describe, expect, it } from 'vitest';
import { validateSuggestion } from '../src/suggestion.js';
import type { CommittableSuggestion } from '@reviewbot/verification';

const HEAD = ['function pick(xs, i) {', '  return xs[i];', '}', 'const other = 1;'];

function ctx(over: Partial<Parameters<typeof validateSuggestion>[2]> = {}) {
  return {
    headLines: HEAD,
    isChangedLine: () => true,
    anchorLine: 2,
    ...over,
  };
}

const good: CommittableSuggestion = {
  startLine: 2,
  endLine: 2,
  originalText: '  return xs[i];',
  replacement: '  if (!Number.isInteger(i) || i < 0 || i >= xs.length) throw new RangeError(`bad index ${i}`);\n  return xs[i];',
};

describe('可提交建议的发布前校验(§25.2)—— 默认拒绝,任一不过即整条丢弃', () => {
  it('全部满足 → 通过', () => {
    expect(validateSuggestion(good, true, ctx())).toEqual({ ok: true, suggestion: good });
  });

  it('finding 未被确认(reject/uncertain)→ 拒:问题都不成立,更不该改代码', () => {
    expect(validateSuggestion(good, false, ctx())).toEqual({ ok: false, reason: 'not-accepted' });
  });

  it('**行号错位**(originalText 对不上 head)→ 拒:这是防"替换打到无关代码"的核心一条', () => {
    const misplaced = { ...good, startLine: 3, endLine: 3 }; // Line 3 is actually '}'.
    expect(validateSuggestion(misplaced, true, ctx({ anchorLine: 3 }))).toEqual({ ok: false, reason: 'text-mismatch' });
  });

  it('范围不覆盖 finding 锚点 → 拒:评论指着这一行,建议却在改另一行', () => {
    const elsewhere: CommittableSuggestion = { startLine: 4, endLine: 4, originalText: 'const other = 1;', replacement: 'const other = 2;' };
    expect(validateSuggestion(elsewhere, true, ctx({ anchorLine: 2 }))).toEqual({ ok: false, reason: 'anchor-not-covered' });
  });

  it('范围内有非变更行 → 拒:GitHub 对 diff 外的行整单 422,会连累整个 review', () => {
    expect(validateSuggestion(good, true, ctx({ isChangedLine: (l) => l !== 2 }))).toEqual({ ok: false, reason: 'not-changed-lines' });
  });

  it('行数超上限 → 拒:大段重写该走 `@bot fix` 的完整交付链,不是一键提交', () => {
    const big: CommittableSuggestion = { startLine: 1, endLine: 4, originalText: HEAD.join('\n'), replacement: 'x' };
    expect(validateSuggestion(big, true, ctx({ anchorLine: 2, maxLines: 2 }))).toEqual({ ok: false, reason: 'too-many-lines' });
  });

  it('越界行号 → 拒(不 crash)', () => {
    expect(validateSuggestion({ ...good, startLine: 0 }, true, ctx())).toEqual({ ok: false, reason: 'out-of-range' });
    expect(validateSuggestion({ ...good, endLine: 99 }, true, ctx())).toEqual({ ok: false, reason: 'out-of-range' });
    expect(validateSuggestion({ ...good, startLine: 3, endLine: 2 }, true, ctx())).toEqual({ ok: false, reason: 'out-of-range' });
  });

  it('替换等于原文 → 拒(空建议是噪音)', () => {
    const noop = { ...good, replacement: '  return xs[i];   ' }; // Differs only in trailing whitespace.
    expect(validateSuggestion(noop, true, ctx())).toEqual({ ok: false, reason: 'no-op' });
  });

  it('替换内容含 ``` → 拒:GitHub 只认三反引号的 ```suggestion,加长围栏就不再被识别', () => {
    const fenced = { ...good, replacement: '  return `` `x` ``;\n```' };
    expect(validateSuggestion(fenced, true, ctx())).toEqual({ ok: false, reason: 'fence-in-replacement' });
  });

  it('行尾空白差异不算错位(编辑器/模型常吞尾空格)', () => {
    const trailing = { ...good, originalText: '  return xs[i];    ' };
    expect(validateSuggestion(trailing, true, ctx()).ok).toBe(true);
  });
});
