import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deliveriesToRedeliver, parseHookDeliveries, type HookDelivery } from '@reviewbot/provider-github';
import { createWebhookRedeliverHandler } from '../src/webhook-redeliver.js';

const d = (id: string, guid: string, statusCode: number, deliveredAt: string, event = 'pull_request'): HookDelivery => ({
  id,
  guid,
  deliveredAt,
  event,
  action: 'synchronize',
  statusCode,
  redelivery: false,
});

describe('webhook redelivery', () => {
  it('redelivers each failed event once, from its latest attempt, until it succeeds or runs out of attempts', () => {
    const todo = deliveriesToRedeliver(
      [
        d('1', 'ok', 202, '2026-09-28T18:00:00Z'),
        d('2', 'lost', 0, '2026-09-28T18:59:09Z'),
        d('3', 'retried-ok', 502, '2026-09-28T12:04:00Z'),
        d('4', 'retried-ok', 202, '2026-09-28T12:14:00Z'),
        d('5', 'twice', 502, '2026-09-28T06:00:00Z'),
        d('6', 'twice', 500, '2026-09-28T06:10:00Z'),
        d('7', 'gave-up', 500, '2026-09-28T05:00:00Z'),
        d('8', 'gave-up', 500, '2026-09-28T05:10:00Z'),
        d('9', 'gave-up', 500, '2026-09-28T05:20:00Z'),
      ],
      3,
    );
    expect(todo.map((x) => x.id).sort()).toEqual(['2', '6']);
  });

  it('asks GitHub for the redeliveries and reports what it did', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const requested: string[] = [];
    const logs: [string, Record<string, unknown> | undefined][] = [];
    let since = '';
    const handler = createWebhookRedeliverHandler({
      appCredentials: async () => ({ appId: '1', privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() }),
      lookbackMs: 6 * 3600_000,
      maxAttempts: 3,
      now: () => Date.parse('2026-09-28T19:00:00Z'),
      list: async (_jwt, s) => {
        since = s;
        return [d('2', 'lost', 0, '2026-09-28T18:59:09Z'), d('1', 'ok', 202, '2026-09-28T18:00:00Z')];
      },
      redeliver: async (_jwt, id) => void requested.push(id),
    });
    await handler({ job: { payload: {} }, log: (m: string, data?: Record<string, unknown>) => logs.push([m, data]) } as never);
    expect(since).toBe('2026-09-28T13:00:00.000Z');
    expect(requested).toEqual(['2']);
    expect(logs.at(-1)?.[1]).toMatchObject({ failedEvents: 1, requested: 1, events: ['pull_request.synchronize'] });
  });

  it('keeps delivery ids above 2^53 exact (a rounded id makes every redelivery 404)', () => {
    const page = '[{"id":3846546608554565601,"guid":"g","delivered_at":"2026-10-05T08:15:00Z","event":"issues","action":"opened","status_code":502,"redelivery":false}]';
    const [delivery] = parseHookDeliveries(page);
    expect(delivery!.id).toBe('3846546608554565601');
    expect(delivery!.status_code).toBe(502);
    expect(parseHookDeliveries('')).toEqual([]);
  });
});
