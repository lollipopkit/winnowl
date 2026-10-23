import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  configDigest,
  defaultConfig,
  loadConfigYaml,
  parseRepositoryConfig,
  pruneDefaults,
  resolveConfig,
} from '../src/index.js';

describe('默认配置', () => {
  it('parse({}) 产出安全默认', () => {
    const cfg = defaultConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.reviews.auto.enabled).toBe(true);
    expect(cfg.reviews.auto.drafts).toBe(false);
    // Unset: the platform decides.
    expect(cfg.sandbox.network.mode).toBeUndefined();
    expect(cfg.sandbox.resources).toEqual({});
    expect(cfg.sandbox.runner).toBe('platform');
    expect(cfg.merge_gate.enabled).toBe(false);
    expect(cfg.actions.post_merge.enabled).toBe(false);
  });
});

describe('unknown key 校验', () => {
  it('拒绝未知顶层字段', () => {
    expect(() => parseRepositoryConfig({ unknown_field: true })).toThrow(ConfigValidationError);
  });

  it('拒绝未知嵌套字段', () => {
    expect(() => parseRepositoryConfig({ reviews: { nope: 1 } })).toThrow(ConfigValidationError);
  });

  it('拒绝非法枚举值', () => {
    expect(() => parseRepositoryConfig({ reviews: { profile: 'aggressive' } })).toThrow(
      ConfigValidationError,
    );
  });
});

describe('分层合并优先级', () => {
  it('高优先级层覆盖低优先级层', () => {
    const { config } = resolveConfig([
      { source: 'repository-file', value: { sandbox: { network: { mode: 'full' } } } },
      { source: 'global-safety', value: { sandbox: { network: { mode: 'none' } } } },
    ]);
    // A repository file cannot loosen the global-safety network policy
    expect(config.sandbox.network.mode).toBe('none');
  });

  it('§37.2 格:安全层设 allowlist,仓库可收紧为 none', () => {
    const { config } = resolveConfig([
      { source: 'repository-file', value: { sandbox: { network: { mode: 'none' } } } },
      { source: 'global-safety', value: { sandbox: { network: { mode: 'allowlist' } } } },
    ]);
    // Tightening takes effect
    expect(config.sandbox.network.mode).toBe('none');
  });

  it('§37.2 格:安全层设 allowlist,仓库不能放宽为 full', () => {
    const { config } = resolveConfig([
      { source: 'repository-file', value: { sandbox: { network: { mode: 'full' } } } },
      { source: 'global-safety', value: { sandbox: { network: { mode: 'allowlist' } } } },
    ]);
    // Loosening is rejected; the safety layer's allowlist bound holds
    expect(config.sandbox.network.mode).toBe('allowlist');
  });

  it('§37.2 格:无安全层时仓库自设值生效', () => {
    const { config } = resolveConfig([
      { source: 'repository-file', value: { sandbox: { network: { mode: 'allowlist' } } } },
    ]);
    expect(config.sandbox.network.mode).toBe('allowlist');
  });

  it('低优先级层填充高优先级未设置的字段', () => {
    const { config } = resolveConfig([
      { source: 'repository-file', value: { language: 'zh-CN' } },
      { source: 'global-safety', value: { merge_gate: { enabled: true } } },
    ]);
    expect(config.language).toBe('zh-CN');
    expect(config.merge_gate.enabled).toBe(true);
  });

  it('深合并保留同对象内其他字段', () => {
    const { config } = resolveConfig([
      { source: 'repository-file', value: { reviews: { publication: { max_inline_comments: 20, summary_overflow: false } } } },
    ]);
    expect(config.reviews.publication.max_inline_comments).toBe(20);
    expect(config.reviews.publication.summary_overflow).toBe(false);
    expect(config.reviews.publication.committable_suggestions).toBe(true);
  });

  // Inline quotas have no schema default so unset stays distinguishable; the profile fills them in.
  it('inline 名额未设时不落进有效配置(留给 profile 派生)', () => {
    const { config } = resolveConfig([{ source: 'repository-file', value: {} }]);
    expect(config.reviews.publication.max_inline_comments).toBeUndefined();
    expect(config.reviews.publication.max_inline_per_file).toBeUndefined();
    expect(config.reviews.publication.max_inline_nitpicks).toBeUndefined();
  });
});

// Panel settings must store only the diff from defaults, or saving would freeze today's defaults.
describe('pruneDefaults(§37 面板存差异片段)', () => {
  it('与默认相同的键全部剪掉,只留真正改过的', () => {
    const full = defaultConfig() as unknown as Record<string, unknown>;
    expect(pruneDefaults(full)).toEqual({});
    const changed = { ...full, reviews: { ...(full.reviews as Record<string, unknown>), profile: 'thorough' } };
    expect(pruneDefaults(changed)).toEqual({ reviews: { profile: 'thorough' } });
  });

  it('剪枝后仍能还原出同一份有效配置', () => {
    const yaml = { reviews: { profile: 'thorough', publication: { max_inline_comments: 2 } }, merge_gate: { enabled: true } };
    const full = parseRepositoryConfig(yaml);
    const pruned = pruneDefaults(full);
    expect(pruned).toEqual(yaml);
    expect(resolveConfig([{ source: 'repository-db', value: pruned }]).config).toEqual(full);
  });

  it('嵌套里只改了一个键 → 只留那一个键(不整块保留)', () => {
    const full = parseRepositoryConfig({ sandbox: { network: { mode: 'allowlist' } } });
    expect(pruneDefaults(full)).toEqual({ sandbox: { network: { mode: 'allowlist' } } });
  });

  it('数组整体比较:与默认相同则剪掉,改一个元素则整段保留', () => {
    const def = defaultConfig();
    expect(pruneDefaults({ reviews: { auto: { base_branches: def.reviews.auto.base_branches } } })).toEqual({});
    expect(pruneDefaults({ reviews: { auto: { base_branches: ['main', 'release'] } } })).toEqual({
      reviews: { auto: { base_branches: ['main', 'release'] } },
    });
  });
});

describe('digest', () => {
  it('键顺序不影响 digest', () => {
    const a = configDigest({ b: 1, a: { y: 2, x: 1 } });
    const b = configDigest({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('值变化改变 digest', () => {
    expect(configDigest({ a: 1 })).not.toBe(configDigest({ a: 2 }));
  });
});

describe('YAML 加载', () => {
  it('解析 YAML 文本并可校验', () => {
    const raw = loadConfigYaml('version: 1\nlanguage: zh-CN\nreviews:\n  profile: thorough\n');
    const cfg = parseRepositoryConfig(raw);
    expect(cfg.language).toBe('zh-CN');
    expect(cfg.reviews.profile).toBe('thorough');
  });
});

describe('pi 插件配置(§插件)', () => {
  it('默认开启(plugins.*.enabled=true)', () => {
    expect(defaultConfig().plugins.exa.enabled).toBe(true);
    expect(defaultConfig().plugins.context7.enabled).toBe(true);
  });

  it('拒绝未知插件名(strict:仅平台注册表内)', () => {
    expect(() => parseRepositoryConfig({ plugins: { rogue: { enabled: true } } })).toThrow(
      ConfigValidationError,
    );
  });

  it('organization settings are defaults: they fill what the repository leaves unset, and the repository wins', () => {
    const { config } = resolveConfig([
      { source: 'organization', value: { language: 'zh', reviews: { profile: 'thorough' } } },
      { source: 'repository-file', value: { reviews: { profile: 'conservative' } } },
    ]);
    expect(config.language).toBe('zh');
    expect(config.reviews.profile).toBe('conservative');
  });

  it('布尔格:org 层显式关闭,repo 层不能翻开', () => {
    const { config } = resolveConfig([
      { source: 'repository-file', value: { plugins: { exa: { enabled: true } } } },
      { source: 'organization', value: { plugins: { exa: { enabled: false } } } },
    ]);
    expect(config.plugins.exa.enabled).toBe(false);
  });

  it('布尔格:repo 层显式关闭同样生效(任一层 false 即关)', () => {
    const { config } = resolveConfig([
      { source: 'repository-file', value: { plugins: { exa: { enabled: false } } } },
      { source: 'organization', value: { plugins: { exa: { enabled: true } } } },
    ]);
    expect(config.plugins.exa.enabled).toBe(false);
  });
});
