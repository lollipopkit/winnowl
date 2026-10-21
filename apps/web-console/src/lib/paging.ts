/** List paging/sort/filter contract; mirrors control-api list-query. */

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export type SortDir = 'asc' | 'desc';

export type ListArgs = Record<string, string | number | undefined>;

/** Empty/undefined values are omitted; returns '' when nothing is left. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Same field flips direction; a new field starts at desc. */
export function nextSort(current: { sort: string; dir: SortDir }, field: string): { sort: string; dir: SortDir } {
  if (current.sort === field) return { sort: field, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { sort: field, dir: 'desc' };
}

export function sortArrow(current: { sort: string; dir: SortDir }, field: string): string {
  if (current.sort !== field) return '';
  return current.dir === 'asc' ? ' ↑' : ' ↓';
}
