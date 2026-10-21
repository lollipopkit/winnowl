import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ProviderKind } from '@reviewbot/domain';
import { metricsAccess, withSpan, type Tracer } from '@reviewbot/telemetry';
import type { WebhookIngestor } from './ingestor.js';
import {
  registry,
  webhookInvalidTotal,
  webhookProcessedTotal,
  webhookReceivedTotal,
} from './metrics.js';

export interface WebhookIngressOptions {
  ingestor: WebhookIngestor;
  quiet?: boolean;
  /** Default 5 MiB. */
  bodyLimit?: number;
  tracer?: Tracer;
}

export async function buildWebhookIngress(options: WebhookIngressOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.quiet ? { level: 'silent' } : { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: options.bodyLimit ?? 5 * 1024 * 1024,
  });

  // Keep the raw body string for signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  async function handle(
    provider: ProviderKind,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply> {
    const params = request.params as { installationId?: string };
    webhookReceivedTotal.inc({ provider });
    const input = {
      provider,
      headers: request.headers,
      body: typeof request.body === 'string' ? request.body : '',
      receivedAt: new Date().toISOString(),
      ...(params.installationId ? { pathInstallationId: params.installationId } : {}),
    };
    const result = options.tracer
      ? await withSpan(
          options.tracer,
          `webhook.receive ${provider}`,
          async (span) => {
            const r = await options.ingestor.handle(input);
            span.setAttributes({
              'webhook.result': r.status,
              ...(r.status === 'accepted' ? { 'webhook.events': r.domainEventIds.length } : {}),
            });
            return r;
          },
          { 'webhook.provider': provider },
        )
      : await options.ingestor.handle(input);
    webhookProcessedTotal.inc({ provider, result: result.status });
    if (result.status === 'unauthorized') webhookInvalidTotal.inc({ provider });

    switch (result.status) {
      case 'accepted':
        return reply.code(202).send({
          status: 'accepted',
          providerEventId: result.providerEventId,
          events: result.domainEventIds.length,
        });
      case 'duplicate':
        return reply.code(200).send({ status: 'duplicate' });
      case 'unauthorized':
        return reply.code(401).send({ status: 'unauthorized', reason: result.reason });
      case 'unresolved':
        return reply.code(404).send({ status: 'unresolved' });
    }
  }

  app.post('/webhooks/github', (req, reply) => handle('github', req, reply));
  app.post('/webhooks/gitlab/:installationId', (req, reply) => handle('gitlab', req, reply));
  app.post('/webhooks/forgejo/:installationId', (req, reply) => handle('forgejo', req, reply));
  app.get('/health', async () => ({ status: 'ok' }));
  // Also under `/webhooks/`: the proxy routes only that prefix here, so external probes cannot reach `/health`.
  app.get('/webhooks/health', async () => ({ status: 'ok' }));
  // Token-gated (telemetry `metricsAccess`): the service is reachable from the internet.
  app.get('/metrics', async (req, reply) => {
    const access = metricsAccess(req.headers.authorization);
    if (access !== 200) return reply.code(access).send();
    reply.header('content-type', registry.contentType);
    return reply.send(await registry.metrics());
  });

  return app;
}
