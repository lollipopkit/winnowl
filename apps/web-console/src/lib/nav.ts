import type { Me } from './api';

export type NavKey =
  | 'dashboard'
  | 'inbox'
  | 'reviews'
  | 'findings'
  | 'repositories'
  | 'learnings'
  | 'organizationConfig'
  | 'account'
  | 'usage'
  | 'audit'
  | 'runners'
  | 'plans'
  | 'pendingInstallations'
  | 'platformSettings';

export type NavGroup = 'common' | 'reviews' | 'config' | 'org' | 'platform';

export interface NavItem {
  path: string;
  /** Key into NAV_ICONS (lib/nav-icons.ts). */
  icon: string;
  group: NavGroup;
  key: NavKey;
  /** Sibling routes shown as this item's page tabs; the item stays highlighted on them. */
  tabs?: string[];
  live: boolean;
  /** Hides operator pages from tenants; not a security boundary. */
  operator?: boolean;
}

export const GROUP_ORDER: NavGroup[] = ['common', 'reviews', 'config', 'org', 'platform'];

export const NAV: NavItem[] = [
  { path: '/dashboard', key: 'dashboard', icon: 'LayoutDashboard', group: 'common', live: true },
  { path: '/inbox', key: 'inbox', icon: 'InboxIcon', group: 'common', live: true },

  { path: '/reviews', key: 'reviews', icon: 'MessageSquareCode', group: 'reviews', live: true },
  { path: '/findings', key: 'findings', icon: 'Bug', group: 'reviews', live: true },

  { path: '/repositories', key: 'repositories', icon: 'FolderGit2', group: 'config', live: true, tabs: ['/relationships'] },
  { path: '/learnings', key: 'learnings', icon: 'ListChecks', group: 'config', live: true },

  { path: '/organization-config', key: 'organizationConfig', icon: 'Building', group: 'org', live: true },
  // No role gate: users without any membership must still be able to link identities.
  { path: '/account', key: 'account', icon: 'Users', group: 'org', live: true },
  { path: '/usage', key: 'usage', icon: 'CircleDollarSign', group: 'org', live: true },
  { path: '/audit', key: 'audit', icon: 'History', group: 'org', live: true },

  { path: '/runners', key: 'runners', icon: 'Server', group: 'platform', live: true, operator: true },
  { path: '/plans', key: 'plans', icon: 'Layers', group: 'platform', live: true, operator: true },
  { path: '/pending-installations', key: 'pendingInstallations', icon: 'UserCheck', group: 'platform', live: true, operator: true },
  {
    path: '/platform-settings',
    key: 'platformSettings',
    icon: 'SlidersHorizontal',
    group: 'platform',
    live: true,
    operator: true,
    tabs: ['/login-sources', '/global-learnings', '/ecosystem-facts'],
  },
];

function under(base: string, pathname: string): boolean {
  return pathname === base || (base !== '/' && pathname.startsWith(base + '/'));
}

/** True on the item's own path, its sub-routes, and its tab routes. */
export function isNavActive(item: NavItem, pathname: string): boolean {
  return under(item.path, pathname) || (item.tabs ?? []).some((t) => under(t, pathname));
}

/** Before `me` loads, operator items are hidden. */
export function visibleNav(me: Me | null): NavItem[] {
  return NAV.filter((item) => !item.operator || me?.isOperator === true);
}

export function groupedNav(me: Me | null): { group: NavGroup; items: NavItem[] }[] {
  const visible = visibleNav(me);
  return GROUP_ORDER.map((group) => ({ group, items: visible.filter((i) => i.group === group) })).filter(
    (g) => g.items.length > 0,
  );
}
