import { describe, expect, it } from 'vitest';
import { defaultConfig } from '@reviewbot/config';
import { assertPluginSupplyChain, buildContext7Tools, buildExaTools, buildPkgRegistryTools, CONTEXT7_BASE_URL, EXA_BASE_URL, PKG_REGISTRY_HOSTS, platformPluginEnv, pluginCallCostUsd, resolvePluginTools, type PluginManifestEntry } from '../src/index.js';

function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    const out = handler(String(url), (init ?? {}) as RequestInit);
    return {
      ok: (out.status ?? 200) < 400,
      status: out.status ?? 200,
      json: async () => out.body ?? {},
      text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {})),
    } as Response;
  }) as typeof fetch;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

describe('resolvePluginTools(§插件注册表)', () => {
  it('sources 记下各插件返回过的公开来源;审计事件带参数摘要', async () => {
    const events: unknown[] = [];
    const r = resolvePluginTools({
      plugins: defaultConfig().plugins,
      env: { EXA_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetchFn: stubFetch((url) => {
        if (url.includes('api.exa.ai/search')) return { body: { results: [{ url: 'https://docs.flutter.dev/x', text: 't' }] } };
        if (url.includes('context7.com')) return { body: 'docs text' };
        return { body: { latest: { version: '1.5.0' } } };
      }),
      onToolCall: (e) => void events.push(e),
    });
    const tool = (n: string) => r.tools.find((t) => t.name === n)!;
    await tool('web_search').execute('t', { query: 'flutter material_ui' });
    await tool('query_docs').execute('t', { libraryId: '/flutter/packages', query: 'material_ui' });
    await tool('lookup_package').execute('t', { ecosystem: 'pub', name: 'material_ui' });
    expect([...r.sources]).toEqual(['https://docs.flutter.dev/x', 'https://context7.com/flutter/packages', 'https://pub.dev/api/packages/material_ui']);
    expect(events[0]).toEqual({ plugin: 'exa', tool: 'web_search', keySource: 'platform', args: { query: 'flutter material_ui' } });
  });

  it('platformPluginEnv 只取平台插件 key,空值不带', () => {
    expect(platformPluginEnv({ EXA_API_KEY: ' k ', CONTEXT7_API_KEY: '', LLM_API_KEY: 'x' } as NodeJS.ProcessEnv)).toEqual({ EXA_API_KEY: 'k' });
  });

  it('默认配置 + 凭据齐备 → 全部装载(默认开启)', () => {
    const r = resolvePluginTools({ plugins: defaultConfig().plugins, env: { EXA_API_KEY: 'k', CONTEXT7_API_KEY: 'c' } as NodeJS.ProcessEnv });
    expect(r.active).toEqual(['exa', 'context7', 'registry']);
    expect(r.tools.map((t) => t.name)).toEqual(['web_search', 'fetch_url', 'resolve_library_id', 'query_docs', 'lookup_package']);
    expect(r.skipped).toEqual([]);
  });

  it('配置关闭 → 不装载,skipped=disabled', () => {
    const r = resolvePluginTools({
      plugins: { exa: { enabled: false }, context7: { enabled: false }, registry: { enabled: false } },
      env: { EXA_API_KEY: 'k', CONTEXT7_API_KEY: 'c' } as NodeJS.ProcessEnv,
    });
    expect(r.tools).toEqual([]);
    expect(r.skipped).toEqual([
      { name: 'exa', reason: 'disabled' },
      { name: 'context7', reason: 'disabled' },
      { name: 'registry', reason: 'disabled' },
    ]);
  });

  it('key 必需插件(exa)缺凭据 → 跳过;key 可选插件(context7)keyless 照常装载', () => {
    const r = resolvePluginTools({ plugins: defaultConfig().plugins, env: {} as NodeJS.ProcessEnv });
    expect(r.active).toEqual(['context7', 'registry']);
    expect(r.tools.map((t) => t.name)).toEqual(['resolve_library_id', 'query_docs', 'lookup_package']);
    expect(r.skipped).toEqual([{ name: 'exa', reason: 'missing-credentials' }]);
  });
});

describe('exa web_search 工具', () => {
  it('请求打到固定端点 + 结果带不可信数据头', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    const fetchFn = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { body: { results: [{ title: 'Doc', url: 'https://example.com', text: 'hello' }] } };
    });
    const [tool] = buildExaTools({ apiKey: 'k', fetchFn });
    const result = await tool!.execute('t1', { query: 'zod v4 breaking changes', numResults: 99 });
    expect(seenUrl).toBe(`${EXA_BASE_URL}/search`);
    // numResults is clamped to the cap
    expect(seenBody.numResults).toBe(5);
    const text = textOf(result as { content: { type: string; text?: string }[] });
    expect(text).toContain('UNTRUSTED DATA');
    expect(text).toContain('Doc — https://example.com');
    expect(text).toContain('hello');
  });

  it('HTTP 错误 → 返回失败文本(不抛异常,不中断 invocation)', async () => {
    const [tool] = buildExaTools({ apiKey: 'k', fetchFn: stubFetch(() => ({ status: 401 })) });
    const result = await tool!.execute('t1', { query: 'q' });
    expect(textOf(result as { content: { type: string; text?: string }[] })).toContain('web_search failed: HTTP 401');
  });

  it('fetch_url 只开 web_search 返回过的 URL(防把仓库内容编进 URL 外泄)', async () => {
    const fetched: unknown[] = [];
    const fetchFn = stubFetch((url, init) => {
      if (url.endsWith('/search')) return { body: { results: [{ title: 'Guide', url: 'https://docs.flutter.dev/guide', text: 'x' }] } };
      fetched.push(JSON.parse(String(init.body)).urls);
      return { body: { results: [{ title: 'Guide', url: 'https://docs.flutter.dev/guide', text: 'migrate' }] } };
    });
    const [search, fetchUrl] = buildExaTools({ apiKey: 'k', fetchFn });
    const run = async (url: string) => textOf((await fetchUrl!.execute('t', { url })) as { content: { type: string; text?: string }[] });
    expect(await run('https://docs.flutter.dev/guide')).toContain('only opens URLs returned by web_search');
    await search!.execute('t', { query: 'flutter material_ui migration' });
    expect(await run('https://evil.example/?d=secret')).toContain('only opens URLs returned by web_search');
    expect(await run('https://docs.flutter.dev/guide')).toContain('migrate');
    expect(fetched).toEqual([['https://docs.flutter.dev/guide']]);
  });

  it('空结果 → (no results)', async () => {
    const [tool] = buildExaTools({ apiKey: 'k', fetchFn: stubFetch(() => ({ body: { results: [] } })) });
    const result = await tool!.execute('t1', { query: 'q' });
    expect(textOf(result as { content: { type: string; text?: string }[] })).toBe('(no results)');
  });
});

describe('context7 文档检索工具', () => {
  it('resolve_library_id:请求 v2 固定端点;有 key 带 Bearer', async () => {
    let seenUrl = '';
    let seenAuth: string | undefined;
    const fetchFn = (async (url: unknown, init?: unknown) => {
      seenUrl = String(url);
      seenAuth = ((init as RequestInit).headers as Record<string, string>).authorization;
      return { ok: true, status: 200, json: async () => ({ results: [{ id: '/facebook/react', title: 'React', description: 'UI library' }] }), text: async () => '' } as Response;
    }) as typeof fetch;
    const [resolveTool] = buildContext7Tools({ apiKey: 'c7k', fetchFn });
    const result = await resolveTool!.execute('t1', { libraryName: 'react', query: 'state management' });
    expect(seenUrl).toBe(`${CONTEXT7_BASE_URL}/libs/search?libraryName=react&query=state+management`);
    expect(seenAuth).toBe('Bearer c7k');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('UNTRUSTED DATA');
    expect(text).toContain('/facebook/react');
  });

  it('keyless 可用:无 apiKey 不带 Authorization 头', async () => {
    let seenAuth: string | undefined = 'sentinel';
    const fetchFn = (async (_url: unknown, init?: unknown) => {
      seenAuth = ((init as RequestInit).headers as Record<string, string>).authorization;
      return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' } as Response;
    }) as typeof fetch;
    const [resolveTool] = buildContext7Tools({ fetchFn });
    await resolveTool!.execute('t1', { libraryName: 'react' });
    expect(seenAuth).toBeUndefined();
  });

  it('query_docs:v2 /context + 自然语言 query + 文档带不可信数据头', async () => {
    let seenUrl = '';
    const fetchFn = (async (url: unknown) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => ({}), text: async () => 'useEffect runs after render' } as Response;
    }) as typeof fetch;
    const queryDocs = buildContext7Tools({ apiKey: 'c7k', fetchFn }).find((t) => t.name === 'query_docs')!;
    const result = await queryDocs.execute('t1', { libraryId: '/facebook/react', query: 'when does useEffect run' });
    expect(seenUrl).toContain(`${CONTEXT7_BASE_URL}/context?`);
    expect(seenUrl).toContain('libraryId=%2Ffacebook%2Freact');
    expect(seenUrl).toContain('query=when+does+useEffect+run');
    expect(seenUrl).toContain('type=txt');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('UNTRUSTED DATA');
    expect(text).toContain('useEffect runs after render');
  });

  it('query_docs:非法 library id 拒绝(防路径注入出固定端点)', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response;
    }) as typeof fetch;
    const queryDocs = buildContext7Tools({ apiKey: 'k', fetchFn }).find((t) => t.name === 'query_docs')!;
    const result = await queryDocs.execute('t1', { libraryId: '/../../etc/passwd', query: 'x' });
    expect((result.content[0] as { text: string }).text).toContain('invalid library id');
    expect(called).toBe(false);
  });
});

describe('插件供应链钉死策略(§插件安全)', () => {
  it('community 来源缺钉死 → fail-closed 抛错', () => {
    const entry: PluginManifestEntry = { name: 'exa', publisher: 'community' };
    expect(() => assertPluginSupplyChain(entry)).toThrow(/钉死/);
  });

  it('community 钉死不完整(版本非精确/integrity 非 sha512)→ 抛错', () => {
    expect(() =>
      assertPluginSupplyChain({ name: 'exa', publisher: 'community', pinned: { package: 'pi-exa', version: '^0.6.1', sha512: 'sha512-abc' } }),
    ).toThrow(/钉死/);
    expect(() =>
      assertPluginSupplyChain({ name: 'exa', publisher: 'community', pinned: { package: 'pi-exa', version: '0.6.1', sha512: 'sha1-abc' } }),
    ).toThrow(/钉死/);
  });

  it('community 完整钉死 / platform / vendor-official → 通过', () => {
    expect(() =>
      assertPluginSupplyChain({ name: 'exa', publisher: 'community', pinned: { package: 'pi-exa', version: '0.6.1', sha512: 'sha512-abc' } }),
    ).not.toThrow();
    expect(() => assertPluginSupplyChain({ name: 'exa', publisher: 'platform' })).not.toThrow();
    expect(() => assertPluginSupplyChain({ name: 'context7', publisher: 'vendor-official' })).not.toThrow();
  });
});

describe('凭据优先级(§插件 BYOK)', () => {
  it('租户配置凭据优先于平台 env;缺项回退 env', () => {
    const r = resolvePluginTools({
      plugins: defaultConfig().plugins,
      credentials: { exa: 'tenant-exa-key' },
      env: { EXA_API_KEY: 'platform-key', CONTEXT7_API_KEY: 'platform-c7' } as NodeJS.ProcessEnv,
    });
    expect(r.active).toEqual(['exa', 'context7', 'registry']);
  });

  it('平台无 key 时,仅租户凭据也能激活 exa', () => {
    const r = resolvePluginTools({
      plugins: defaultConfig().plugins,
      credentials: { exa: 'tenant-exa-key' },
      env: {} as NodeJS.ProcessEnv,
    });
    expect(r.active).toEqual(['exa', 'context7', 'registry']);
    expect(r.skipped).toEqual([]);
  });
});

describe('插件调用计费(§插件⑤)', () => {
  it('pluginCallCostUsd:platform key 按牌价;tenant/none 计 0;未知工具 0', () => {
    expect(pluginCallCostUsd('exa', 'web_search', 'platform')).toBe(0.007);
    expect(pluginCallCostUsd('exa', 'fetch_url', 'platform')).toBe(0.001);
    expect(pluginCallCostUsd('context7', 'query_docs', 'platform')).toBe(0);
    expect(pluginCallCostUsd('exa', 'web_search', 'tenant')).toBe(0);
    expect(pluginCallCostUsd('exa', 'web_search', 'none')).toBe(0);
    expect(pluginCallCostUsd('exa', 'unknown_tool', 'platform')).toBe(0);
  });

  it('onToolCall 事件带 keySource:tenant 凭据 → tenant;平台 env → platform;keyless → none', async () => {
    const calls: unknown[] = [];
    const fetchFn = (async () => ({ ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' }) as Response) as typeof fetch;
    const r = resolvePluginTools({
      plugins: defaultConfig().plugins,
      credentials: { exa: 'tenant-key' },
      env: {} as NodeJS.ProcessEnv,
      fetchFn,
      onToolCall: (e) => void calls.push(e),
    });
    await r.tools.find((t) => t.name === 'web_search')!.execute('t', { query: 'q' });
    await r.tools.find((t) => t.name === 'resolve_library_id')!.execute('t', { libraryName: 'x' });
    expect(calls).toEqual([
      { plugin: 'exa', tool: 'web_search', keySource: 'tenant', args: { query: 'q' } },
      { plugin: 'context7', tool: 'resolve_library_id', keySource: 'none', args: { libraryName: 'x' } },
    ]);

    const calls2: { keySource: string }[] = [];
    const r2 = resolvePluginTools({
      plugins: defaultConfig().plugins,
      env: { EXA_API_KEY: 'pk', CONTEXT7_API_KEY: 'ck' } as NodeJS.ProcessEnv,
      fetchFn,
      onToolCall: (e) => void calls2.push({ keySource: e.keySource }),
    });
    await r2.tools.find((t) => t.name === 'web_search')!.execute('t', { query: 'q' });
    await r2.tools.find((t) => t.name === 'query_docs')!.execute('t', { libraryId: '/a/b', query: 'q' });
    expect(calls2).toEqual([{ keySource: 'platform' }, { keySource: 'platform' }]);
  });
});

describe('registry lookup_package 工具(依赖版本/元数据)', () => {
  it('npm:打固定端点 /latest,输出含版本/license/deprecated + 不可信数据头', async () => {
    let seenUrl = '';
    const fetchFn = stubFetch((url) => {
      seenUrl = url;
      return { body: { version: '5.2.0', license: 'MIT', deprecated: 'use v6', description: 'legacy lib' } };
    });
    const [tool] = buildPkgRegistryTools({ fetchFn });
    const out = textOf(await tool!.execute('t', { ecosystem: 'npm', name: '@acme/core' }, undefined as never, undefined as never));
    expect(seenUrl).toBe('https://registry.npmjs.org/@acme/core/latest');
    expect(out).toContain('UNTRUSTED DATA');
    expect(out).toContain('latest: 5.2.0');
    expect(out).toContain('license: MIT');
    expect(out).toContain('deprecated/yanked: use v6');
  });

  it('cargo/pypi/go:各打各的官方端点;go 大写字母 proxy 转义', async () => {
    const urls: string[] = [];
    const fetchFn = stubFetch((url) => {
      urls.push(url);
      if (url.includes('crates.io')) return { body: { crate: { max_stable_version: '1.0.219' }, versions: [{ license: 'Apache-2.0' }] } };
      if (url.includes('pypi.org')) return { body: { info: { version: '2.32.3', license: 'Apache-2.0' } } };
      return { body: { Version: 'v1.9.9', Time: '2026-01-01T00:00:00Z' } };
    });
    const [tool] = buildPkgRegistryTools({ fetchFn });
    await tool!.execute('t', { ecosystem: 'cargo', name: 'serde' }, undefined as never, undefined as never);
    await tool!.execute('t', { ecosystem: 'pypi', name: 'requests' }, undefined as never, undefined as never);
    await tool!.execute('t', { ecosystem: 'go', name: 'github.com/Masterminds/semver' }, undefined as never, undefined as never);
    expect(urls[0]).toBe('https://crates.io/api/v1/crates/serde');
    expect(urls[1]).toBe('https://pypi.org/pypi/requests/json');
    expect(urls[2]).toBe('https://proxy.golang.org/github.com/!masterminds/semver/@latest'); // uppercase -> `!` + lowercase
  });

  it('pub/maven/rubygems/nuget/composer/hex:官方端点 + 各自的弃用字段', async () => {
    const urls: string[] = [];
    const fetchFn = stubFetch((url) => {
      urls.push(url);
      if (url.startsWith('https://pub.dev/'))
        return { body: { latest: { version: '1.11.1', published: '2021-06-17T11:36:26Z', pubspec: { description: 'lints' } }, isDiscontinued: true, replacedBy: 'lints' } };
      if (url.startsWith('https://repo1.maven.org/'))
        return { body: '<metadata><versioning><latest>33.7.1-jre</latest><release>33.7.1-jre</release><lastUpdated>20260818035315</lastUpdated></versioning></metadata>' };
      if (url.startsWith('https://rubygems.org/')) return { body: { version: '8.1.4', licenses: ['MIT'], version_created_at: '2026-09-24T14:22:14Z' } };
      if (url.startsWith('https://api.nuget.org/')) return { body: { versions: ['13.0.3', '13.0.4', '14.0.1-beta2'] } };
      if (url.startsWith('https://repo.packagist.org/'))
        return { body: { packages: { 'fzaninotto/faker': [{ version: 'v1.9.2', license: ['MIT'], abandoned: 'fakerphp/faker' }] } } };
      return { body: { latest_stable_version: '1.8.15', meta: { licenses: ['MIT'] }, retirements: { '1.8.15': { reason: 'security', message: 'CVE fix in 1.8.16' } } } };
    });
    const [tool] = buildPkgRegistryTools({ fetchFn });
    const run = async (ecosystem: string, name: string) =>
      textOf(await tool!.execute('t', { ecosystem, name }, undefined as never, undefined as never));
    const pub = await run('pub', 'pedantic');
    expect(pub).toContain('deprecated/yanked: discontinued, replaced by lints');
    expect(pub).toContain('source: https://pub.dev/api/packages/pedantic'); // record_external_fact cites it verbatim
    const maven = await run('maven', 'com.google.guava:guava');
    expect(maven).toContain('latest: 33.7.1-jre');
    expect(maven).toContain('published: 2026-08-18T03:53:15Z');
    expect(await run('rubygems', 'rails')).toContain('license: MIT');
    expect(await run('nuget', 'Newtonsoft.Json')).toContain('latest: 13.0.4'); // prereleases are not latest
    expect(await run('composer', 'fzaninotto/faker')).toContain('abandoned, use fakerphp/faker');
    expect(await run('hex', 'phoenix')).toContain('deprecated/yanked: CVE fix in 1.8.16');
    expect(urls).toEqual([
      'https://pub.dev/api/packages/pedantic',
      'https://repo1.maven.org/maven2/com/google/guava/guava/maven-metadata.xml',
      'https://rubygems.org/api/v1/gems/rails.json',
      'https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json',
      'https://repo.packagist.org/p2/fzaninotto/faker.json',
      'https://hex.pm/api/packages/phoenix',
    ]);
    // Every ecosystem endpoint is in the egress allowlist.
    for (const u of urls) expect(PKG_REGISTRY_HOSTS).toContain(new URL(u).host);
  });

  it('各生态包名写法校验', async () => {
    const [tool] = buildPkgRegistryTools({ fetchFn: stubFetch(() => ({ body: {} })) });
    const invalid = async (ecosystem: string, name: string) =>
      textOf(await tool!.execute('t', { ecosystem, name }, undefined as never, undefined as never)).includes('invalid package name');
    expect(await invalid('maven', 'guava')).toBe(true); // missing groupId
    expect(await invalid('maven', 'com.google/../x:guava')).toBe(true);
    expect(await invalid('composer', 'laravel')).toBe(true); // missing vendor
    expect(await invalid('pub', 'material-ui')).toBe(true);
    expect(await invalid('pub', 'material_ui')).toBe(false);
  });

  it('包名校验防路径注入;404 → 明确 not found;网络错不抛(工具内兜)', async () => {
    const [tool] = buildPkgRegistryTools({ fetchFn: stubFetch(() => ({ status: 404 })) });
    const bad = textOf(await tool!.execute('t', { ecosystem: 'npm', name: '../evil' }, undefined as never, undefined as never));
    expect(bad).toContain('invalid package name');
    const missing = textOf(await tool!.execute('t', { ecosystem: 'pypi', name: 'nope' }, undefined as never, undefined as never));
    expect(missing).toContain('not found');
    const [failing] = buildPkgRegistryTools({
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const err = textOf(await failing!.execute('t', { ecosystem: 'cargo', name: 'serde' }, undefined as never, undefined as never));
    expect(err).toContain('lookup_package failed');
  });
});
