import type { RetrievalCategory, RetrievalItem } from './types.js';

export const RETRIEVAL_ORDER: readonly RetrievalCategory[] = [
  'authoritative-rule',
  'approved-learning',
  'agent-memory',
  'exact-prior-finding',
  'related-pr-issue',
  'semantic-historical',
  'external-context',
];

export function retrievalRank(category: RetrievalCategory): number {
  const idx = RETRIEVAL_ORDER.indexOf(category);
  return idx < 0 ? RETRIEVAL_ORDER.length : idx;
}

/** Category, then mandatory first, then higher specificity; otherwise stable. */
function compareRetrieval(a: RetrievalItem, b: RetrievalItem): number {
  const c = retrievalRank(a.category) - retrievalRank(b.category);
  if (c !== 0) return c;
  const m = Number(b.mandatory ?? false) - Number(a.mandatory ?? false);
  if (m !== 0) return m;
  return (b.specificity ?? 0) - (a.specificity ?? 0);
}

export interface RetrievalContext {
  path?: string;
  now?: number;
}

/**
 * Order knowledge and drop expired or inapplicable items. An item with a selector but no path
 * context cannot be confirmed applicable, so it is dropped.
 */
export function orderKnowledge(items: RetrievalItem[], ctx: RetrievalContext = {}): RetrievalItem[] {
  const now = ctx.now ?? Date.now();
  return items
    .filter((i) => i.expiresAt === undefined || i.expiresAt > now)
    .filter((i) => isApplicable(i.selector, ctx.path))
    .sort(compareRetrieval);
}

function isApplicable(selector: string | undefined, path: string | undefined): boolean {
  if (selector === undefined) return true;
  if (path === undefined) return false;
  return matchesGlob(selector, path);
}

/** Like orderKnowledge for a whole review: selector items are kept when they match any changed file. */
export function orderKnowledgeForPaths(items: RetrievalItem[], paths: readonly string[], ctx: { now?: number } = {}): RetrievalItem[] {
  const now = ctx.now ?? Date.now();
  return items
    .filter((i) => i.expiresAt === undefined || i.expiresAt > now)
    .filter((i) => i.selector === undefined || paths.some((p) => matchesGlob(i.selector!, p)))
    .sort(compareRetrieval);
}

// Minimal glob: `*` within a segment, `**` across directories; `**/` matches zero or more dirs, like minimatch.
export function matchesGlob(glob: string, path: string): boolean {
  const special = '.+^${}()|[]\\';
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (special.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(path);
}
