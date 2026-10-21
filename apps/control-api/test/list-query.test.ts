import { describe, expect, it } from 'vitest';
import { paged, parseListParams, strFilter } from '../src/list-query.js';

const SORTS = ['createdAt', 'name'] as const;

describe('parseListParams(§40 列表契约)', () => {
  it('默认值:limit 50 / offset 0 / defaultSort / desc', () => {
    expect(parseListParams({}, { sortable: SORTS, defaultSort: 'createdAt' })).toEqual({ limit: 50, offset: 0, sort: 'createdAt', dir: 'desc' });
  });

  it('limit 夹取到 [1,max];offset 非负', () => {
    expect(parseListParams({ limit: '999', offset: '-5' }, { sortable: SORTS, defaultSort: 'createdAt', maxLimit: 200 }).limit).toBe(200);
    expect(parseListParams({ limit: '0' }, { sortable: SORTS, defaultSort: 'createdAt' }).limit).toBe(1);
    expect(parseListParams({ offset: '-5' }, { sortable: SORTS, defaultSort: 'createdAt' }).offset).toBe(0);
  });

  it('sort 白名单外回退默认(防注入)', () => {
    expect(parseListParams({ sort: 'name' }, { sortable: SORTS, defaultSort: 'createdAt' }).sort).toBe('name');
    expect(parseListParams({ sort: 'drop table' }, { sortable: SORTS, defaultSort: 'createdAt' }).sort).toBe('createdAt');
  });

  it('dir 仅 asc/desc,否则回退', () => {
    expect(parseListParams({ dir: 'asc' }, { sortable: SORTS, defaultSort: 'createdAt' }).dir).toBe('asc');
    expect(parseListParams({ dir: 'sideways' }, { sortable: SORTS, defaultSort: 'createdAt', defaultDir: 'asc' }).dir).toBe('asc');
  });

  it('非法/缺失 limit 用 defaultLimit', () => {
    expect(parseListParams({ limit: 'abc' }, { sortable: SORTS, defaultSort: 'createdAt', defaultLimit: 25 }).limit).toBe(25);
  });
});

describe('strFilter', () => {
  it('取非空字符串,去空白;缺失/空 → undefined', () => {
    expect(strFilter({ q: '  hi ' }, 'q')).toBe('hi');
    expect(strFilter({ q: '   ' }, 'q')).toBeUndefined();
    expect(strFilter({}, 'q')).toBeUndefined();
    expect(strFilter({ q: 5 }, 'q')).toBeUndefined();
  });
});

describe('paged', () => {
  it('回显 limit/offset', () => {
    expect(paged([1, 2], 7, { limit: 10, offset: 20, sort: 'x', dir: 'asc' })).toEqual({ items: [1, 2], total: 7, limit: 10, offset: 20 });
  });
});
