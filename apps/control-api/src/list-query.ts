/** Shared list contract: `limit`/`offset`/`sort`/`dir` query, `{ items, total, limit, offset }` response. */

export interface ListParams {
  limit: number;
  offset: number;
  sort: string;
  dir: 'asc' | 'desc';
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

interface ParseOpts {
  /** Allowlist; other values fall back to defaultSort (prevents SQL injection). */
  sortable: readonly string[];
  defaultSort: string;
  defaultDir?: 'asc' | 'desc';
  maxLimit?: number;
  defaultLimit?: number;
}

const asRecord = (q: unknown): Record<string, unknown> => (q && typeof q === 'object' ? (q as Record<string, unknown>) : {});
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function parseListParams(query: unknown, opts: ParseOpts): ListParams {
  const q = asRecord(query);
  const int = (v: unknown, d: number): number => {
    const n = Math.floor(Number(asStr(v)));
    return Number.isFinite(n) ? n : d;
  };
  const maxLimit = opts.maxLimit ?? 200;
  const limit = Math.min(maxLimit, Math.max(1, int(q.limit, opts.defaultLimit ?? 50)));
  const offset = Math.max(0, int(q.offset, 0));
  const sortRaw = asStr(q.sort);
  const sort = sortRaw && opts.sortable.includes(sortRaw) ? sortRaw : opts.defaultSort;
  const dirRaw = asStr(q.dir);
  const dir = dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : (opts.defaultDir ?? 'desc');
  return { limit, offset, sort, dir };
}

export function strFilter(query: unknown, key: string): string | undefined {
  const v = asRecord(query)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function paged<T>(items: T[], total: number, params: ListParams): Paged<T> {
  return { items, total, limit: params.limit, offset: params.offset };
}
