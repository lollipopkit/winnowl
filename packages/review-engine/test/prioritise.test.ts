import { describe, expect, it } from 'vitest';
import { prioritiseScopes, restrictScopesToDelta } from '../src/index.js';
import type { ReviewScope } from '../src/types.js';

// Uncovered-first ordering. dig starts scopes in declared order and the wall clock always cuts the tail,
// so reordering makes the cut fall on scopes whose current content was already reviewed.
const scope = (id: string, files?: string[]): ReviewScope => ({
  id,
  title: id,
  changeSummary: '',
  obligations: [],
  ...(files ? { files } : {}),
});

describe('restrictScopesToDelta', () => {
  it('drops prior-only scopes and removes prior files from mixed scopes', () => {
    const scopes = [
      scope('old', ['old.ts']),
      scope('mixed', ['new.ts', 'old.ts']),
      scope('unknown'),
    ];
    expect(restrictScopesToDelta(scopes, ['old.ts'])).toEqual([
      { ...scopes[1], files: ['new.ts'] },
      scopes[2],
    ]);
  });

  it('normalizes both prior paths and mapper scope paths before exclusion', () => {
    expect(
      restrictScopesToDelta(
        [scope('old', ['old.ts']), scope('mixed', ['new.ts', 'dir/old.ts'])],
        ['./old.ts', 'dir\\old.ts'],
      ),
    ).toEqual([{ ...scope('mixed', ['new.ts', 'dir/old.ts']), files: ['new.ts'] }]);
  });
});

describe('prioritiseScopes(0073 未覆盖优先)', () => {
  it('碰到未覆盖路径的排前面,两侧各自保持相对序(稳定分区)', () => {
    const scopes = [
      scope('a', ['x.ts']),
      scope('b', ['new.ts']),
      scope('c', ['y.ts']),
      scope('d', ['new2.ts']),
    ];
    const out = prioritiseScopes(scopes, ['new.ts', 'new2.ts']);
    expect(out.map((s) => s.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('一个 scope 只要沾到一条未覆盖路径就算命中(scope 不等于文件)', () => {
    const scopes = [scope('a', ['x.ts']), scope('b', ['x.ts', 'new.ts'])];
    expect(prioritiseScopes(scopes, ['new.ts']).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('normalizes both priority and mapper paths before matching', () => {
    const scopes = [scope('other', ['other.ts']), scope('hit', ['dir\\new.ts'])];
    expect(prioritiseScopes(scopes, ['./dir/new.ts']).map((s) => s.id)).toEqual(['hit', 'other']);
  });

  it('files 缺省的 scope 归入「其余」—— 判不出它覆盖什么时不能假装它覆盖了要紧的那些', () => {
    const scopes = [scope('nofiles'), scope('hit', ['new.ts'])];
    expect(prioritiseScopes(scopes, ['new.ts']).map((s) => s.id)).toEqual(['hit', 'nofiles']);
  });

  it('没有未覆盖清单(首轮/无账本)→ 原样,零行为变化', () => {
    const scopes = [scope('a'), scope('b')];
    expect(prioritiseScopes(scopes, undefined).map((s) => s.id)).toEqual(['a', 'b']);
    expect(prioritiseScopes(scopes, []).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('全部命中 / 全部未命中 → 顺序不变(分区不该无谓打乱)', () => {
    const scopes = [scope('a', ['n1.ts']), scope('b', ['n2.ts'])];
    expect(prioritiseScopes(scopes, ['n1.ts', 'n2.ts']).map((s) => s.id)).toEqual(['a', 'b']);
    expect(prioritiseScopes(scopes, ['other.ts']).map((s) => s.id)).toEqual(['a', 'b']);
  });
});
