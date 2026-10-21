import { describe, expect, it } from 'vitest';
import { PLATFORM_SETTINGS, isValidPlatformSetting, resolveAllPlatformSettings, resolvePlatformSetting } from '../src/index.js';

describe('平台运维设置(0058):DB 优先、env 兜底', () => {
  const KEY = 'review.finding_match';

  it('三级来源:DB > env > 默认,且来源要能报出来', () => {
    expect(resolvePlatformSetting(KEY, 'off', { REVIEW_FINDING_MATCH: 'llm' })).toEqual({ key: KEY, value: 'off', source: 'database' });
    expect(resolvePlatformSetting(KEY, undefined, { REVIEW_FINDING_MATCH: 'off' })).toEqual({ key: KEY, value: 'off', source: 'environment' });
    expect(resolvePlatformSetting(KEY, undefined, {})).toEqual({ key: KEY, value: 'llm', source: 'default' });
  });

  it('env 里的非法值当作没设 —— 一个拼错的环境变量不该让所有 review 挂掉', () => {
    expect(resolvePlatformSetting(KEY, undefined, { REVIEW_FINDING_MATCH: 'yes-please' }).source).toBe('default');
    // Case and whitespace are normalised (env is hand-written)
    expect(resolvePlatformSetting(KEY, undefined, { REVIEW_FINDING_MATCH: '  OFF ' })).toEqual({ key: KEY, value: 'off', source: 'environment' });
  });

  it('DB 里的非法值同样被跳过(设置项取值收窄后,旧行不该继续生效)', () => {
    expect(resolvePlatformSetting(KEY, 'legacy-value', { REVIEW_FINDING_MATCH: 'off' }).source).toBe('environment');
  });

  it('写入校验:未知 key 与非法值一律拒绝(不静默忽略)', () => {
    expect(isValidPlatformSetting(KEY, 'llm')).toBe(true);
    expect(isValidPlatformSetting(KEY, 'maybe')).toBe(false);
    expect(isValidPlatformSetting('review.nonexistent', 'llm')).toBe(false);
  });

  it('每项都有 env 兜底名与说明 —— 回滚必须能不经 console 完成', () => {
    expect(resolvePlatformSetting('review.max_turns', undefined, {})).toEqual({
      key: 'review.max_turns',
      value: '200',
      source: 'default',
    });
    expect(isValidPlatformSetting('review.max_turns', 'auto')).toBe(true);
    expect(isValidPlatformSetting('review.max_turns', '7')).toBe(false);

    const stageDefaults = ['map', 'dig', 'verify', 'synthesis'].map(
      (k) => resolvePlatformSetting(`review.stage_budget.${k}`, undefined, {}).value,
    );
    expect(stageDefaults).toEqual(['5', '15', '9', '3']);
    expect(stageDefaults.reduce((sum, v) => sum + Number(v), 0)).toBeLessThanOrEqual(35);
    expect(isValidPlatformSetting('review.stage_budget.dig', 'off')).toBe(true);
    expect(isValidPlatformSetting('review.stage_budget.dig', '7')).toBe(false);

    for (const s of PLATFORM_SETTINGS) {
      expect(s.env).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(s.values.length).toBeGreaterThan(1);
      expect(s.description.length).toBeGreaterThan(40);
    }
  });

  it('全量解析:每项都有结果,顺序与定义一致', () => {
    const all = resolveAllPlatformSettings(new Map([[KEY, 'off']]), {});
    expect(all.map((s) => s.key)).toEqual(PLATFORM_SETTINGS.map((s) => s.key));
    expect(all.find((s) => s.key === KEY)!.value).toBe('off');
  });
});
