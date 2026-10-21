import { describe, expect, it } from 'vitest';
import { safeJsonLd } from '../src/lib/seo.js';

describe('safeJsonLd', () => {
  it('escapes script-closing markup while preserving the JSON value', () => {
    const serialized = safeJsonLd({
      url: 'https://example.test/</script><script>alert(1)</script>',
    });
    expect(serialized).not.toContain('<');
    expect(JSON.parse(serialized)).toEqual({
      url: 'https://example.test/</script><script>alert(1)</script>',
    });
  });
});
