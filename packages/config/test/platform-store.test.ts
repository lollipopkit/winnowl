import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '@reviewbot/db';
import { platformSetting, readPlatformSettings, resolvePlatformSetting } from '../src/index.js';

/** Just enough of Kysely for the two platform_settings reads. */
function fakeDb(rows: { key: string; value: string }[] | Error): Db {
  const fail = async (): Promise<never> => {
    throw rows as Error;
  };
  return {
    selectFrom: () => ({
      select: () => ({
        execute: rows instanceof Error ? fail : async () => rows,
        where: (_col: string, _op: string, key: string) => ({
          executeTakeFirst: rows instanceof Error ? fail : async () => rows.find((r) => r.key === key),
        }),
      }),
    }),
  } as unknown as Db;
}

describe('platform settings read from the database', () => {
  afterEach(() => {
    delete process.env.LLM_VERIFY_VOTES;
  });

  it('reads every stored row', async () => {
    const map = await readPlatformSettings(fakeDb([{ key: 'review.verify_votes', value: '3' }]));
    expect(map.get('review.verify_votes')).toBe('3');
  });

  it('a failed read is empty, so env and defaults still apply', async () => {
    expect((await readPlatformSettings(fakeDb(new Error('db down')))).size).toBe(0);
    process.env.LLM_VERIFY_VOTES = '5';
    expect(await platformSetting(fakeDb(new Error('db down')), 'review.verify_votes')).toBe('5');
  });

  it('the stored value wins over env; an invalid stored value falls back', async () => {
    process.env.LLM_VERIFY_VOTES = '5';
    expect(await platformSetting(fakeDb([{ key: 'review.verify_votes', value: '3' }]), 'review.verify_votes')).toBe('3');
    expect(await platformSetting(fakeDb([{ key: 'review.verify_votes', value: '7' }]), 'review.verify_votes')).toBe('5');
  });
});

describe('moved env knobs keep their previous defaults', () => {
  it.each([
    ['review.verify_votes', '1'],
    ['review.dig_concurrency', '2'],
    ['review.verify_concurrency', '8'],
    ['review.fast_map', '1'],
    ['review.max_tool_calls', 'auto'],
    ['knowledge.select', '1'],
    ['knowledge.inject_all_threshold', '12'],
    ['knowledge.select_cap', '60'],
    ['knowledge.global_auto_propose', 'off'],
    ['knowledge.global_panel', 'tiers'],
    ['post_merge.enabled', '0'],
    ['security.dep_scan', '1'],
    ['security.static_scan', '1'],
    ['security.issue_channel', '0'],
    ['security.issue_disclosure', 'public'],
    ['security.issue_min_severity', 'high'],
    ['byok.enabled', '1'],
    ['quota.warn_ratio', '0.8'],
  ])('%s defaults to %s', (key, value) => {
    expect(resolvePlatformSetting(key, undefined, {})).toEqual({ key, value, source: 'default' });
  });

  it('the env values that disabled a feature before still do', () => {
    expect(resolvePlatformSetting('byok.enabled', undefined, { BYOK_ENABLED: '0' }).value).toBe('0');
    expect(resolvePlatformSetting('post_merge.enabled', undefined, { POST_MERGE_ENABLED: '1' }).value).toBe('1');
    expect(resolvePlatformSetting('quota.warn_ratio', undefined, { QUOTA_WARN_RATIO: '0' }).value).toBe('0');
    expect(resolvePlatformSetting('security.issue_disclosure', undefined, { SECURITY_ISSUE_DISCLOSURE: 'full' }).value).toBe('full');
  });
});
