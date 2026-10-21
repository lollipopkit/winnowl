import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GROUP_ORDER, NAV, groupedNav, isNavActive, visibleNav } from '../src/lib/nav';
import { isTabActive, platformTabs, repoTabs } from '../src/lib/tabs';
import { defaultTenantFor, needsOnboarding } from '../src/lib/me';
import { authFetch, holdRequestsUntil } from '../src/lib/auth';
import type { Me } from '../src/lib/api';
import en from '../src/lib/i18n/en';
import zh from '../src/lib/i18n/zh';
import { toneFor } from '../src/lib/theme';

describe('web-console', () => {
  it('§40+ADR-014 导航含 14 项且均已接真实端点(live)', () => {
    expect(NAV.length).toBe(14);
    for (const item of NAV) expect(item.live).toBe(true);
  });

  it('每个导航项都有图标 —— 图标是扫读的锚点,漏一个就断了节奏', () => {
    for (const item of NAV) expect(item.icon).toBeTruthy();
  });

  // Deploys use `git archive`, which only exports tracked files, so an ignored route
  // builds fine locally but 404s in production. Checks every +page.svelte, not just NAV.
  it('**每个页面路由**都被 git 跟踪(否则 git archive 部署会漏掉)', () => {
    const root = new URL('..', import.meta.url).pathname;
    const tracked = new Set(
      execFileSync('git', ['ls-files', 'src/routes'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean),
    );
    const onDisk = execFileSync('find', ['src/routes', '-name', '+page.svelte'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(onDisk.length).toBeGreaterThan(10);
    for (const f of onDisk) {
      expect(tracked.has(f), `路由未被 git 跟踪(部署会漏):${f}`).toBe(true);
    }
    // Route groups like `(app)` are not part of the URL, so strip them before comparing.
    const urlOf = (file: string): string =>
      file
        .replace(/^src\/routes/, '')
        .replace(/\/\+page\.svelte$/, '')
        .replace(/\/\([^/]+\)/g, '') || '/';
    const routeUrls = new Set(onDisk.map(urlOf));
    for (const item of NAV) {
      expect(routeUrls.has(item.path), `${item.path} 没有对应的 +page.svelte`).toBe(true);
    }
  });

  // Header tabs are sub-pages: every tab/parent link must map to exactly one NAV item,
  // otherwise no sidebar item is highlighted.
  it('页头 tab / 父页链接指向的路由都在 NAV 里有归属(否则侧栏一项不亮)', () => {
    const root = new URL('..', import.meta.url).pathname;
    const files = [
      ...execFileSync('find', ['src/routes', '-name', '+page.svelte'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean),
      'src/lib/tabs.ts',
    ];
    // Only tab groups and PageHeader parents use `href: '…'`; template-literal hrefs are
    // covered by path-prefix matching.
    const targets = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(`${root}/${f}`, 'utf8').matchAll(/href: ['"`]([^'"`]+)['"`]/g)) {
        const href = m[1];
        if (href.includes('${') || !href.startsWith('/')) continue;
        targets.add(href.split('?')[0]);
      }
    }
    expect(targets.size).toBeGreaterThan(5);
    for (const p of targets) {
      const owners = NAV.filter((i) => isNavActive(i, p));
      expect(owners.map((i) => i.key), `${p} 在侧栏没有唯一归属(NAV 的 tabs 漏登记?)`).toHaveLength(1);
    }
  });

  // A tab without a query matches by path only, so same-path siblings must all carry a query
  // or two tabs highlight at once.
  it('同一组 tab 在任何地址下最多命中一个(同路径的兄弟必须都带 query)', () => {
    const root = new URL('..', import.meta.url).pathname;
    // Stub LL: tab builders expect typesafe-i18n functions, only hrefs matter here.
    const LL = new Proxy({}, { get: () => new Proxy({}, { get: () => () => '' }) }) as never;
    // Some tab groups are still inlined in pages.
    const groups: { where: string; hrefs: string[]; defaults: Record<string, string> }[] = [
      { where: 'platformTabs', hrefs: platformTabs(LL).map((t) => t.href), defaults: {} },
      { where: 'repoTabs', hrefs: repoTabs(LL).map((t) => t.href), defaults: {} },
    ];
    for (const f of [
      'src/routes/(app)/plans/+page.svelte',
      'src/routes/(app)/repositories/[repositoryId]/config/+page.svelte',
    ]) {
      const src = readFileSync(`${root}/${f}`, 'utf8');
      const hrefs = [...src.matchAll(/href: [`'"]([^`'"]+)[`'"]/g)]
        .map((m) => m[1])
        .filter((h) => h.startsWith('/') || h.includes('?'));
      const defaults = /tabDefaults=\{\{\s*(\w+):\s*'([^']+)'/.exec(src);
      if (hrefs.length > 1) {
        groups.push({ where: f, hrefs, defaults: defaults ? { [defaults[1]]: defaults[2] } : {} });
      }
    }

    for (const g of groups) {
      // Also probe the bare path (default view).
      const probes = [...g.hrefs, ...new Set(g.hrefs.map((h) => h.split('?')[0]))];
      for (const probe of probes) {
        const url = new URL(probe.replace(/\$\{[^}]+\}/g, 'x'), 'https://console.test');
        const hits = g.hrefs.filter((h) => isTabActive(h.replace(/\$\{[^}]+\}/g, 'x'), url, g.defaults));
        expect(hits.length, `${g.where} 在 ${probe} 命中了 ${hits.length} 个 tab:${hits.join(' + ')}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('每项都归了组,且分组顺序里没有拼错的 key(否则侧栏会静默丢掉整组)', () => {
    for (const item of NAV) expect(GROUP_ORDER).toContain(item.group);
    for (const g of GROUP_ORDER) expect(NAV.some((i) => i.group === g)).toBe(true);
  });

  it('groupedNav 只返回**有可见项**的组(裁剪后空组不该留下标题)', () => {
    const base: Me = { role: 'viewer', tenantId: 't', userId: null, email: null, displayName: null, isOperator: false, memberships: [], pendingInstallation: null, installUrl: null };
    const viewerGroups = groupedNav(base).map((g) => g.group);
    expect(viewerGroups).not.toContain('platform');
    expect(viewerGroups).toContain('common');
    expect(groupedNav(base).flatMap((g) => g.items)).toHaveLength(visibleNav(base).length);
    expect(groupedNav({ ...base, role: 'owner', isOperator: true }).map((g) => g.group)).toContain('platform');
  });

  it('visibleNav 受众裁剪(ADR-014 D1):operator 页只给运维,未加载最保守', () => {
    const base: Me = { role: 'viewer', tenantId: 't', userId: null, email: null, displayName: null, isOperator: false, memberships: [], pendingInstallation: null, installUrl: null };
    const keys = (m: Me | null): string[] => visibleNav(m).map((i) => i.key);
    // Unloaded me: no operator items.
    expect(keys(null)).not.toContain('runners');
    expect(keys(null)).not.toContain('platformSettings');
    // Usage & billing serves everyone: plan for all, personal keys for members, costs for admins.
    expect(keys(base)).toContain('usage');
    expect(keys({ ...base, role: 'admin' })).not.toContain('ai');
    expect(keys({ ...base, role: 'admin' })).not.toContain('relationships');
    expect(keys({ ...base, role: 'admin' })).not.toContain('installations');
    expect(keys(base)).toEqual(expect.arrayContaining(['reviews', 'findings', 'audit']));
    expect(keys({ ...base, role: 'admin' })).not.toContain('runners');
    expect(keys({ ...base, role: 'owner', isOperator: true })).toEqual(expect.arrayContaining(['runners', 'platformSettings', 'usage']));
    // Account must be reachable without any membership, to link one's own identities.
    expect(keys(null)).toContain('account');
    expect(keys(base)).toContain('account');
    // Plans is a platform catalog: operator-only, even for tenant owners.
    expect(keys({ ...base, role: 'owner' })).not.toContain('plans');
    expect(keys({ ...base, role: 'owner', isOperator: true })).toContain('plans');
  });

  it('每个导航项在 en/zh 均有标签(i18n 键覆盖)', () => {
    for (const item of NAV) {
      expect(en.nav[item.key]).toBeTruthy();
      expect(zh.nav[item.key]).toBeTruthy();
    }
  });

  it('toneFor 把状态/严重度映射到语义色', () => {
    expect(toneFor('approved')).toBe('ok');
    expect(toneFor('rejected')).toBe('danger');
    expect(toneFor('pending')).toBe('warn');
    expect(toneFor('critical')).toBe('danger');
    expect(toneFor('unknown-xyz')).toBe('neutral');
    expect(toneFor(null)).toBe('neutral');
  });
});

describe('登录后的默认租户(前端补后端的"多租户须显式选定")', () => {
  const m = (tenants: string[]): Me => ({
    role: 'owner',
    tenantId: null,
    userId: 'u1',
    email: null,
    displayName: null,
    isOperator: false,
    memberships: tenants.map((t) => ({ tenantId: t, tenantName: t, role: 'owner' })),
    pendingInstallation: null,
    installUrl: null,
  });

  it('needsOnboarding:0 membership → 拦截;有 membership / 邀请页 / 文档页 → 放行', () => {
    const none = m([]);
    expect(needsOnboarding(none, '/dashboard')).toBe(true);
    expect(needsOnboarding(none, '/repositories')).toBe(true);
    // Invitees get their first membership through the invite page.
    expect(needsOnboarding(none, '/invites/abc')).toBe(false);
    expect(needsOnboarding(none, '/docs')).toBe(false);
    expect(needsOnboarding(none, '/docs/config')).toBe(false);
    expect(needsOnboarding(none, '/invites-not-really')).toBe(true);
    expect(needsOnboarding(m(['a']), '/dashboard')).toBe(false);
    expect(needsOnboarding(null, '/dashboard')).toBe(false);
  });

  it('没选过 → 落到第一个(后端按 created_at asc 排,顺序稳定)', () => {
    expect(defaultTenantFor(m(['a', 'b']), null)).toBe('a');
  });

  it('已选且仍有效 → 不动(别把用户切走)', () => {
    expect(defaultTenantFor(m(['a', 'b']), 'b')).toBeNull();
  });

  it('**选择已失效 → 落回第一个**(退租/被移除/账号合并后租户集变了)', () => {
    // A stale X-Tenant-Id would otherwise silently downgrade the user to viewer.
    expect(defaultTenantFor(m(['a', 'b']), 'gone')).toBe('a');
  });

  it('一个 membership 都没有 → 不编一个租户出来', () => {
    expect(defaultTenantFor(m([]), null)).toBeNull();
    expect(defaultTenantFor(m([]), 'stale')).toBeNull();
  });
});

describe('活动租户确定之前挂起业务请求', () => {
  // A stored tenant can be stale; requests racing loadMe would send the old header and get 400.
  it('业务请求等 loadMe;/v1/me 不等', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (path: string) => {
      calls.push(path);
      return new Response('{}', { status: 200 });
    });
    let settle!: () => void;
    holdRequestsUntil(new Promise<void>((r) => (settle = r)));
    const dashboard = authFetch('/v1/dashboard');
    await authFetch('/v1/me');
    expect(calls).toEqual(['/v1/me']);
    settle();
    await dashboard;
    expect(calls).toEqual(['/v1/me', '/v1/dashboard']);
    vi.unstubAllGlobals();
  });
});

describe('页面结构基线(§40)', () => {
  const ROOT = new URL('..', import.meta.url).pathname;
  const pages = execFileSync('find', ['src/routes', '-name', '+page.svelte'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();

  // Each exception needs a reason. The marketing landing page has no app header row.
  const EXCEPT_HEADER = new Set<string>(['src/routes/(marketing)/+page.svelte']);
  const read = (f: string): string => {
    const s = readFileSync(`${ROOT}/${f}`, 'utf8');
    const i = s.lastIndexOf('</script>');
    return i >= 0 ? s.slice(i) : s;
  };

  it('每个页面都有 PageHeader', () => {
    for (const f of pages) {
      if (EXCEPT_HEADER.has(f)) continue;
      expect(read(f).includes('<PageHeader'), `${f} 缺 PageHeader`).toBe(true);
    }
  });

  it('**内容必须被 Section 装起来** —— 裸表格/裸表单行没有边界,相邻两块会糊在一起', () => {
    for (const f of pages) {
      const tpl = read(f);
      const hasContent = tpl.includes('Table.Root') || tpl.includes('DataTable') || tpl.includes('form-row');
      if (!hasContent) continue;
      expect(tpl.includes('<Section'), `${f} 有表格/表单但没有 Section`).toBe(true);
    }
  });

  it('有表格就要有空态 —— 空屏是一次邀请,不是一句免责声明', () => {
    for (const f of pages) {
      const tpl = read(f);
      if (!tpl.includes('Table.Root') && !tpl.includes('DataTable')) continue;
      const ok = tpl.includes('EmptyState') || tpl.includes('ListState') || tpl.includes('empty-cell');
      expect(ok, `${f} 有表格但没有空态`).toBe(true);
    }
  });

  it('模板里不写静态内联 style(动态值除外)—— 同一种元素各页写成不同像素值就无从统一', () => {
    for (const f of pages) {
      const bad = read(f).match(/style="[^"{]+"/g) ?? [];
      expect(bad, `${f} 有静态内联 style:${bad.join(' ')}`).toEqual([]);
    }
  });
});

// English docs come from Zod `.describe()`; the Chinese layer is keyed by path and must stay in sync.
describe('配置参考的中英完整性', () => {
  it('每个配置项都有中文说明,且没有多余的翻译', async () => {
    const { CONFIG_DOCS_ZH } = await import('../src/lib/config-docs.zh');
    const reference = (await import('../src/lib/generated/config-reference.json')).default as {
      fields: { path: string; description?: string }[];
    };
    const paths = reference.fields.map((f) => f.path);
    const missing = paths.filter((p) => !CONFIG_DOCS_ZH[p]);
    const stale = Object.keys(CONFIG_DOCS_ZH).filter((p) => !paths.includes(p));
    expect(missing, `缺中文说明:${missing.join(', ')}`).toEqual([]);
    expect(stale, `翻译里有已删除的配置键:${stale.join(', ')}`).toEqual([]);
    expect(reference.fields.filter((f) => !f.description).map((f) => f.path)).toEqual([]);
  });
});
