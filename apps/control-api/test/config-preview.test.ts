import { describe, expect, it } from 'vitest';
import { parseRepositoryConfig } from '@reviewbot/config';
import { planPreview } from '../src/config-preview.js';

type Occ = Parameters<typeof planPreview>[1][number];

const occ = (id: string, over: Partial<Occ> = {}): Occ => ({
  id,
  state: 'inline',
  severity: 'high',
  category: 'correctness',
  changeRelation: 'introduced',
  confirmation: 'independently-verified',
  refuterUpheld: true,
  suppressReason: null,
  demotions: [],
  path: `src/${id}.ts`,
  ...over,
});

const BASIS = { revisionId: 'r', changeNumber: 7, candidates: 9 };

describe('config preview', () => {
  it('re-applies inline quotas and folds overflow into the summary', () => {
    const occurrences = [occ('a'), occ('b'), occ('c', { state: 'summary', demotions: ['inline-budget'] })];
    const cfg = parseRepositoryConfig({ reviews: { publication: { max_inline_comments: 1 } } });
    const p = planPreview(cfg, occurrences, BASIS);
    expect(p).toMatchObject({ inline: 1, summary: 2, notPosted: 0, blocking: 3, gate: 'off' });

    const dropped = planPreview(
      parseRepositoryConfig({ reviews: { publication: { max_inline_comments: 1, summary_overflow: false } } }),
      [occ('a', { severity: 'low', category: 'performance', refuterUpheld: false }), occ('b', { severity: 'low', category: 'performance' })],
      BASIS,
    );
    // Low severity is a nitpick: counted against the nit quota, and never blocking.
    expect(dropped.blocking).toBe(0);
  });

  it('keeps blocking findings in the summary when quota would drop them', () => {
    const cfg = parseRepositoryConfig({ reviews: { publication: { max_inline_comments: 0, summary_overflow: false } } });
    const p = planPreview(cfg, [occ('a'), occ('b', { refuterUpheld: false })], BASIS);
    expect(p).toMatchObject({ inline: 0, summary: 1, notPosted: 1 });
  });

  it('applies the profile threshold, unrelated mode, unverified risks and the merge gate', () => {
    const occurrences = [
      occ('low', { severity: 'low', category: 'maintainability' }),
      occ('old', { changeRelation: 'preexisting-unrelated', state: 'summary', demotions: ['anchor-outside-diff'] }),
      occ('risk', { state: 'unverified-risks', confirmation: 'code-supported' }),
      occ('dup', { state: 'suppressed', suppressReason: 'duplicate' }),
    ];
    const conservative = planPreview(
      parseRepositoryConfig({
        reviews: { profile: 'conservative', scope: { report_preexisting_unrelated: 'off' }, publication: { show_unverified_risks: false } },
        merge_gate: { enabled: true },
      }),
      occurrences,
      BASIS,
    );
    expect(conservative).toMatchObject({
      inline: 0,
      summary: 0,
      notPosted: 3,
      unverifiedRisks: null,
      unrelated: { count: 1, mode: 'off' },
      gate: 'pass',
    });

    const thorough = planPreview(parseRepositoryConfig({ reviews: { profile: 'thorough' } }), occurrences, BASIS);
    expect(thorough).toMatchObject({ inline: 1, summary: 1, notPosted: 1, unverifiedRisks: 1 });
  });
});
