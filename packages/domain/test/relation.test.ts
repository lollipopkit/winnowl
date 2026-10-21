import { describe, expect, it } from 'vitest';
import {
  changeRelationCanBlockMerge,
  isAttributedChangeRelation,
  isChangeCausedRelation,
} from '../src/relation.js';
import { isProviderKind, PROVIDER_KINDS } from '../src/provider.js';
import { isForkTrust } from '../src/repository.js';

describe('change relation', () => {
  it('只有本次变更造成的问题能阻断', () => {
    expect(changeRelationCanBlockMerge('introduced')).toBe(true);
    expect(changeRelationCanBlockMerge('exposed')).toBe(true);
    expect(changeRelationCanBlockMerge('regressed')).toBe(true);
    expect(changeRelationCanBlockMerge('preexisting-relevant')).toBe(false);
    expect(changeRelationCanBlockMerge('preexisting-unrelated')).toBe(false);
    expect(changeRelationCanBlockMerge('unknown')).toBe(false);
  });

  it('block_preexisting=true → 放宽到归因成立即可阻断,但 unknown 仍不阻断', () => {
    const opts = { blockPreexisting: true };
    expect(changeRelationCanBlockMerge('preexisting-relevant', opts)).toBe(true);
    expect(changeRelationCanBlockMerge('preexisting-unrelated', opts)).toBe(true);
    expect(changeRelationCanBlockMerge('introduced', opts)).toBe(true);
    // `unknown` never blocks, regardless of policy.
    expect(changeRelationCanBlockMerge('unknown', opts)).toBe(false);
    expect(changeRelationCanBlockMerge('preexisting-relevant', { blockPreexisting: false })).toBe(false);
  });

  it('归因成立与能否阻断是两条判据', () => {
    // Attributed but not blocking: the two predicates must diverge here.
    expect(isAttributedChangeRelation('preexisting-relevant')).toBe(true);
    expect(changeRelationCanBlockMerge('preexisting-relevant')).toBe(false);
    expect(isAttributedChangeRelation('unknown')).toBe(false);
  });

  it('识别由变更引入/暴露/回归的因果关系', () => {
    expect(isChangeCausedRelation('introduced')).toBe(true);
    expect(isChangeCausedRelation('exposed')).toBe(true);
    expect(isChangeCausedRelation('regressed')).toBe(true);
    expect(isChangeCausedRelation('preexisting-unrelated')).toBe(false);
  });
});

describe('provider kind', () => {
  it('枚举与守卫一致', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(isProviderKind(kind)).toBe(true);
    }
    expect(isProviderKind('svn')).toBe(false);
  });
});

describe('trust', () => {
  it('识别 fork 来源', () => {
    expect(isForkTrust('fork-public')).toBe(true);
    expect(isForkTrust('fork-private')).toBe(true);
    expect(isForkTrust('same-repo-trusted')).toBe(false);
  });
});
