import { describe, expect, it } from 'vitest';
import type { SemanticAnchor } from '@reviewbot/domain';
import { meetsInlineThreshold, resolveAnchor } from '../src/index.js';

function anchor(
  focusText: string,
  prefixLines: string[] = [],
  suffixLines: string[] = [],
  extra: Partial<SemanticAnchor> = {},
): SemanticAnchor {
  return { path: 'f.ts', revision: 'head', focusText, prefixLines, suffixLines, ...extra };
}

const FILE = [
  'const config = loadConfig()',
  'function computeTotal(items) {',
  '  let sum = 0',
  '  for (const item of items) {',
  '    sum += item.price',
  '  }',
  '  return sum',
  '}',
  'const label = greet("world")',
  'export default computeTotal',
];

const resolve = (a: SemanticAnchor, isChanged?: (l: number) => boolean) =>
  resolveAnchor({ anchor: a, fileLines: FILE, revisionSha: 'sha', ...(isChanged ? { isChangedLine: isChanged } : {}) });

describe('resolveAnchor', () => {
  // Models often quote only part of a line.
  it('a fragment of exactly one line resolves to that line; short or ambiguous fragments do not', () => {
    const r = resolve(anchor('item.price'));
    expect(r).toMatchObject({ method: 'substring', lineStart: 5, unique: true });
    expect(meetsInlineThreshold(r)).toBe(true);
    // too short
    expect(resolve(anchor('sum')).method).not.toBe('substring');
    // On two lines: only resolves when exactly one of them is a changed line.
    expect(resolve(anchor('computeTotal')).method).not.toBe('substring');
    expect(resolve(anchor('computeTotal'), (l) => l === 10)).toMatchObject({ method: 'substring', lineStart: 10 });
  });

  it('exact window:唯一命中', () => {
    const r = resolve(anchor('  let sum = 0', ['function computeTotal(items) {'], ['  for (const item of items) {']));
    expect(r.method).toBe('exact-window');
    expect(r.lineStart).toBe(3);
    expect(r.unique).toBe(true);
    expect(r.score).toBe(1);
  });

  it('空白差异经规范化后仍为 exact', () => {
    const r = resolve(anchor('let    sum   =   0', ['function computeTotal(items) {']));
    expect(r.method).toBe('exact-window');
    expect(r.lineStart).toBe(3);
  });

  it('token window:引号/标点差异', () => {
    const r = resolve(anchor("const label = greet('world')", ['}'], ['export default computeTotal']));
    expect(r.lineStart).toBe(9);
    expect(['token-window', 'fuzzy']).toContain(r.method);
    expect(r.unique).toBe(true);
  });

  it('fuzzy window:单字符改动', () => {
    const r = resolve(anchor('return sumX', ['  }'], ['}']));
    expect(r.lineStart).toBe(7);
    expect(r.method).toBe('fuzzy');
  });

  it('hintedLine 消歧重复块', () => {
    const dupFile = ['a', 'x = 1', 'b', 'a', 'x = 1', 'b'];
    const r = resolveAnchor({
      anchor: anchor('x = 1', ['a'], ['b'], { hintedLine: 5 }),
      fileLines: dupFile,
      revisionSha: 'sha',
    });
    expect(r.lineStart).toBe(5);
    expect(r.unique).toBe(true);
  });

  it('重复块无 hint → 歧义 unique=false(降级)', () => {
    const dupFile = ['a', 'x = 1', 'b', 'a', 'x = 1', 'b'];
    const r = resolveAnchor({ anchor: anchor('x = 1', ['a'], ['b']), fileLines: dupFile, revisionSha: 'sha' });
    expect(r.unique).toBe(false);
  });

  it('找不到 → unresolved', () => {
    const r = resolve(anchor('qqq zzz nomatch line'));
    expect(r.method).toBe('unresolved');
    expect(r.lineStart).toBe(0);
  });

  it('changedLine 标记', () => {
    const r = resolve(anchor('  let sum = 0'), (l) => l === 3);
    expect(r.changedLine).toBe(true);
  });

  it('inline 门槛(§23.3):唯一命中通过,歧义/未解析降级', () => {
    const exact = resolve(anchor('  let sum = 0', ['function computeTotal(items) {']));
    expect(meetsInlineThreshold(exact)).toBe(true);
    const dupFile = ['a', 'x = 1', 'b', 'a', 'x = 1', 'b'];
    const ambiguous = resolveAnchor({ anchor: anchor('x = 1', ['a'], ['b']), fileLines: dupFile, revisionSha: 's' });
    expect(meetsInlineThreshold(ambiguous)).toBe(false);
    const missing = resolve(anchor('qqq zzz nomatch'));
    expect(meetsInlineThreshold(missing)).toBe(false);
  });
});

describe('anchor 解析准确率基准', () => {
  it('合成基准达标', () => {
    const targets = [1, 2, 4, 6, 8];
    interface Case {
      anchor: SemanticAnchor;
      expectedLine: number;
      expectedUnique: boolean;
    }
    const cases: Case[] = [];

    for (const t of targets) {
      const prefix = [FILE[t - 1]!];
      const suffix = [FILE[t + 1]!];
      const original = FILE[t]!;
      cases.push({ anchor: anchor(original, prefix, suffix), expectedLine: t + 1, expectedUnique: true });
      // whitespace difference
      cases.push({ anchor: anchor(original.replace(/ /g, '   '), prefix, suffix), expectedLine: t + 1, expectedUnique: true });
      // one-character change -> fuzzy
      cases.push({ anchor: anchor(`${original}X`, prefix, suffix), expectedLine: t + 1, expectedUnique: true });
    }
    // quote difference -> token
    cases.push({ anchor: anchor("const label = greet('world')", ['}'], ['export default computeTotal']), expectedLine: 9, expectedUnique: true });
    cases.push({ anchor: anchor('totally unrelated content zzz'), expectedLine: 0, expectedUnique: false });
    cases.push({ anchor: anchor('another missing line qqq'), expectedLine: 0, expectedUnique: false });

    let correct = 0;
    for (const c of cases) {
      const r = resolveAnchor({ anchor: c.anchor, fileLines: FILE, revisionSha: 'sha' });
      const ok =
        c.expectedLine === 0
          ? r.method === 'unresolved'
          : r.lineStart === c.expectedLine && r.unique === c.expectedUnique;
      if (ok) correct += 1;
    }
    const accuracy = correct / cases.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.99);
  });
});

describe('变更行消歧(§23.3:同锚文本歧义时取变更行)', () => {
  const DUP = ['export function add(a, b) {', '  return a + b', '}', 'export function mul(a, b) {', '  return a + b', '}'];
  const resolveDup = (a: SemanticAnchor, isChanged?: (l: number) => boolean) =>
    resolveAnchor({ anchor: a, fileLines: DUP, revisionSha: 'sha', ...(isChanged ? { isChangedLine: isChanged } : {}) });

  it('多命中 + 无变更信息 → unique=false(歧义,不 inline)', () => {
    const r = resolveDup(anchor('  return a + b'));
    expect(r.unique).toBe(false);
    expect(meetsInlineThreshold(r)).toBe(false);
  });

  it('多命中 + 恰一个在变更行 → 取变更行,unique=true,可 inline(mul 而非 add)', () => {
    const r = resolveDup(anchor('  return a + b'), (l) => l === 5);
    expect(r.unique).toBe(true);
    expect(r.lineStart).toBe(5);
    expect(r.changedLine).toBe(true);
    expect(meetsInlineThreshold(r)).toBe(true);
  });

  it('多命中 + 多个都在变更行 → 仍歧义(unique=false)', () => {
    const r = resolveDup(anchor('  return a + b'), () => true);
    expect(r.unique).toBe(false);
  });
});
