import { createDb, createPool } from '@reviewbot/db';
import { masterKeyFromEnv } from '@reviewbot/kms';
import { setJobTraceCarrierProvider } from '@reviewbot/queue';
import { currentTraceCarrier, initTelemetry } from '@reviewbot/telemetry';
import { buildAdapters, createDbContextResolver, createEnvSecretResolver, createKmsSecretResolver } from './context.js';
import { WebhookIngestor } from './ingestor.js';
import { createGithubTenantProvisioner } from './provision.js';
import { buildWebhookIngress } from './server.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('缺少环境变量 DATABASE_URL');
  process.exit(1);
}

const pool = createPool({ connectionString });
const db = createDb(pool);
const telemetry = initTelemetry({ serviceName: 'winnowl-webhook-ingress' });
// Propagates webhook.receive into enqueued jobs' trace_context so runner job spans join the same trace.
setJobTraceCarrierProvider(() => currentTraceCarrier());

// With a KEK configured, secrets come from KMS storage (falling back to env); otherwise env only.
const kek = masterKeyFromEnv();
const resolveSecret = kek ? createKmsSecretResolver(db, kek) : createEnvSecretResolver();

const ingestor = new WebhookIngestor({
  db,
  adapters: buildAdapters(),
  resolveContext: createDbContextResolver(db),
  resolveSecret,
  provision: createGithubTenantProvisioner(db),
});

const app = await buildWebhookIngress({ ingestor, tracer: telemetry.tracer('webhook-ingress') });

const port = Number(process.env.PORT ?? 8081);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error, 'webhook-ingress 启动失败');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end()).then(() => telemetry.shutdown()).then(() => process.exit(0));
  });
}
