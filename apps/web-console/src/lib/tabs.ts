/** Page tab groups shared by sibling pages; register the routes in nav.ts `tabs` too. */
import type { TranslationFunctions } from './i18n/i18n-types';

export interface TabDef {
  label: string;
  href: string;
}

/**
 * Compares path + query when the href has a query, otherwise the path only. If one tab of a
 * group carries a query, every tab on the same path must, or both match at once.
 */
export function isTabActive(href: string, url: URL, defaults: Record<string, string> = {}): boolean {
  if (!href.includes('?')) return url.pathname === href;
  const [path, query] = href.split('?');
  if (url.pathname !== path) return false;
  const want = new URLSearchParams(query);
  for (const [k, v] of want) {
    const got = url.searchParams.get(k);
    if (got !== v && !(got === null && v === defaults[k])) return false;
  }
  return true;
}

export function platformTabs(LL: TranslationFunctions): TabDef[] {
  return [
    { label: LL.nav.platformSettings(), href: '/platform-settings' },
    { label: LL.nav.loginSources(), href: '/login-sources' },
    { label: LL.page.globalLearnings(), href: '/global-learnings' },
    { label: LL.page.ecosystemFacts(), href: '/ecosystem-facts' },
  ];
}

export function repoTabs(LL: TranslationFunctions): TabDef[] {
  return [
    { label: LL.nav.repositories(), href: '/repositories' },
    { label: LL.nav.relationships(), href: '/relationships' },
  ];
}
