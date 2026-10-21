import { describe, expect, it } from 'vitest';
import { verifiedExternalFacts } from '../src/engine.js';

describe('record_external_fact 来源核验', () => {
  const seen = new Set(['https://docs.flutter.dev/release/breaking-changes/material-ui-and-cupertino-ui', 'https://pub.dev/api/packages/material_ui']);
  const raw = (sources: string[], over: Record<string, unknown> = {}) => ({
    ecosystem: ' PUB ',
    subject: ' material_ui ',
    claim: 'Flutter 3.47 ships Material as material_ui.',
    sources,
    ...over,
  });

  it('只留本次插件返回过的来源;一个都不剩就整条丢弃', () => {
    const out = verifiedExternalFacts(
      [
        raw(['https://pub.dev/api/packages/material_ui', 'https://evil.example/made-up']),
        raw(['https://evil.example/made-up']),
      ],
      seen,
    );
    expect(out).toEqual([
      { ecosystem: 'pub', subject: 'material_ui', claim: 'Flutter 3.47 ships Material as material_ui.', sources: ['https://pub.dev/api/packages/material_ui'] },
    ]);
  });

  it('没有联网插件 → 不收;每 Scope 最多 3 条', () => {
    expect(verifiedExternalFacts([raw([...seen])], undefined)).toEqual([]);
    expect(verifiedExternalFacts(Array.from({ length: 5 }, () => raw([...seen])), seen)).toHaveLength(3);
  });
});
