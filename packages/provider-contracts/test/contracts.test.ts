import { describe, expect, it } from 'vitest';
import {
  capabilities,
  noCapabilities,
  requireCapability,
  UnsupportedCapabilityError,
  webhookDedupeKey,
  type RawWebhookDelivery,
} from '../src/index.js';

describe('capabilities', () => {
  it('noCapabilities 全部为 false', () => {
    const caps = noCapabilities();
    expect(Object.values(caps).every((v) => v === false)).toBe(true);
  });

  it('capabilities 覆盖指定项,其余为 false', () => {
    const caps = capabilities({ inlineComments: true, checksApi: true });
    expect(caps.inlineComments).toBe(true);
    expect(caps.checksApi).toBe(true);
    expect(caps.approvals).toBe(false);
  });

  it('requireCapability 对不支持能力抛 UnsupportedCapabilityError', () => {
    const caps = capabilities({ inlineComments: true });
    expect(() => requireCapability(caps, 'inlineComments')).not.toThrow();
    expect(() => requireCapability(caps, 'reviewBatches')).toThrow(UnsupportedCapabilityError);
  });
});

describe('webhookDedupeKey', () => {
  const base: RawWebhookDelivery = {
    provider: 'github',
    providerHostId: 'host-1',
    eventType: 'pull_request',
    headers: {},
    body: '{"a":1}',
    receivedAt: '2026-07-15T00:00:00.000Z',
  };

  it('有 delivery id 时使用 host+delivery', () => {
    const key = webhookDedupeKey({ ...base, deliveryId: 'd-123' });
    expect(key).toBe('github:host-1:d-123');
  });

  it('缺失 delivery id 时回退到 payload 哈希 + 取整时间', () => {
    const key = webhookDedupeKey(base, { targetId: 'pr-7' });
    expect(key.startsWith('github:host-1:pull_request:pr-7:')).toBe(true);
    // Same body within the same window -> stable key
    expect(webhookDedupeKey(base, { targetId: 'pr-7' })).toBe(key);
    // Different body -> different key
    expect(webhookDedupeKey({ ...base, body: '{"a":2}' }, { targetId: 'pr-7' })).not.toBe(key);
  });
});
