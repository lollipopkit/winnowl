import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/*
 * webhook-ingress-b `extends` the base definition, which cannot pick up the live overlay's overrides
 * of webhook-ingress, so docker-compose.split-api.yml repeats them. Both instances serve the same
 * deliveries behind the proxy and must stay identical apart from the port.
 */
const deploy = new URL('../../../deploy/', import.meta.url);
type Service = { environment?: Record<string, string>; deploy?: unknown };
const services = (file: string): Record<string, Service> =>
  (parse(readFileSync(new URL(file, deploy), 'utf8'), { logLevel: 'error' }) as { services: Record<string, Service> }).services;

describe('webhook-ingress instances', () => {
  it('webhook-ingress-b carries every live override of webhook-ingress', () => {
    const live = services('docker-compose.live.yml')['webhook-ingress']!;
    const b = services('docker-compose.split-api.yml')['webhook-ingress-b']!;
    expect(b.environment).toEqual(expect.objectContaining(live.environment ?? {}));
    expect(b.deploy).toEqual(live.deploy);
  });
});
