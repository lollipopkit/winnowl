import client from 'prom-client';
import type { FastifyInstance } from 'fastify';
import { metricsAccess } from '@reviewbot/telemetry';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'control-api' });
client.collectDefaultMetrics({ register: registry });

/** Requires `Authorization: Bearer <METRICS_TOKEN>`. */
export function registerMetrics(app: FastifyInstance): void {
  app.get('/metrics', async (req, reply) => {
    const access = metricsAccess(req.headers.authorization);
    if (access !== 200) return reply.code(access).send();
    reply.header('content-type', registry.contentType);
    return reply.send(await registry.metrics());
  });
}
