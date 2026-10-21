import { describe, expect, it } from 'vitest';
import { explorationSuffix, type ExplorationScope } from '../src/index.js';

const DEFAULTS: ExplorationScope = { analyzeRelatedCode: true, analyzePreexistingRelevant: true, maxDependencyDepth: 4 };

describe('explorationSuffix(§37 reviews.scope)', () => {
  it('省略/全默认 → 空串(零 prompt churn 保 cache)', () => {
    expect(explorationSuffix(undefined)).toBe('');
    expect(explorationSuffix(DEFAULTS)).toBe('');
  });

  it('analyze_related_code=false → 限定 diff 内探索', () => {
    const s = explorationSuffix({ ...DEFAULTS, analyzeRelatedCode: false });
    expect(s).toContain('Exploration scope constraints');
    expect(s).toContain('do not explore related code beyond the diff');
  });

  it('analyze_preexisting_relevant=false → 只评估本次引入缺陷', () => {
    const s = explorationSuffix({ ...DEFAULTS, analyzePreexistingRelevant: false });
    expect(s).toContain('Do not report preexisting issues');
  });

  it('max_dependency_depth 偏离默认 → 注入层数约束;多项叠加', () => {
    const s = explorationSuffix({ analyzeRelatedCode: false, analyzePreexistingRelevant: true, maxDependencyDepth: 1 });
    expect(s).toContain('at most 1 level(s)');
    expect(s.split('\n').filter((l) => l.startsWith('- ')).length).toBe(2);
  });
});
