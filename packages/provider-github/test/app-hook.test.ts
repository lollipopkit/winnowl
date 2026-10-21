import { describe, expect, it } from 'vitest';
import { evaluateWebhookDrift } from '../src/index.js';

const ok = { url: 'https://winnowl.lollipopkit.com/webhooks/github', contentType: 'json', insecureSsl: '0' };
const EXPECTED = 'https://winnowl.lollipopkit.com/webhooks/github';

describe('evaluateWebhookDrift(§可观测性:hook url 会漂移)', () => {
  it('一致 → 不漂移、无原因', () => {
    const v = evaluateWebhookDrift(ok, EXPECTED);
    expect(v.drifted).toBe(false);
    expect(v.insecure).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('尾斜杠与 host 大小写归一,不算漂移(避免噪音告警)', () => {
    expect(evaluateWebhookDrift({ url: 'https://Winnowl.LOLLIPOPKIT.com/webhooks/github/' }, EXPECTED).drifted).toBe(false);
  });

  it('**指向别的 host → 漂移**(这正是 2026-07-22 全断七天的形态)', () => {
    const v = evaluateWebhookDrift({ url: 'https://old-host.example.com/webhooks/github' }, EXPECTED);
    expect(v.drifted).toBe(true);
    expect(v.reasons[0]).toContain('old-host.example.com');
    expect(v.reasons[0]).toContain('期望');
  });

  it('路径不同 → 漂移(不做激进等价化,否则会放过真实漂移)', () => {
    expect(evaluateWebhookDrift({ url: 'https://winnowl.lollipopkit.com/webhooks/gitlab' }, EXPECTED).drifted).toBe(true);
  });

  it('空 url(从未配置)→ 漂移,且原因里标注为空', () => {
    const v = evaluateWebhookDrift({ url: '' }, EXPECTED);
    expect(v.drifted).toBe(true);
    expect(v.reasons[0]).toContain('(空)');
  });

  it('http 明文 / insecure_ssl=1 → 标记 insecure(payload 与签名会明文暴露)', () => {
    expect(evaluateWebhookDrift({ url: 'http://winnowl.lollipopkit.com/webhooks/github' }, 'http://winnowl.lollipopkit.com/webhooks/github').insecure).toBe(true);
    expect(evaluateWebhookDrift({ ...ok, insecureSsl: '1' }, EXPECTED).insecure).toBe(true);
  });

  it('非法 URL 串不抛,按原样比较', () => {
    expect(() => evaluateWebhookDrift({ url: 'not a url' }, EXPECTED)).not.toThrow();
    expect(evaluateWebhookDrift({ url: 'not a url' }, EXPECTED).drifted).toBe(true);
  });
});
