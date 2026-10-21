import { createServer } from 'node:http';
import { createAdminHandler, createRelayHandler, GrantStore } from './relay.js';

// RELAY_PORT serves sandbox hosts; RELAY_ADMIN_PORT (internal network only) takes grant registrations.
// No key at rest: keys arrive with the grants and live in memory.
const adminTokenSha256 = (process.env.LLM_RELAY_ADMIN_SHA256 ?? '').trim();
if (!/^[0-9a-f]{64}$/.test(adminTokenSha256)) {
  console.error('llm-relay requires LLM_RELAY_ADMIN_SHA256 (hex sha256 of the admin token)');
  process.exit(1);
}
const log = (fields: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...fields })}\n`);
};
const store = new GrantStore();
const sweep = setInterval(() => store.sweep(), 15_000);

const relay = createServer(createRelayHandler({ store, log }));
// Model streams run for minutes; Node's default request timeout (5 min) would cut them.
relay.requestTimeout = 0;
relay.headersTimeout = 60_000;
const admin = createServer(createAdminHandler({ store, adminTokenSha256 }));

relay.listen(Number(process.env.RELAY_PORT) || 8793, '0.0.0.0');
admin.listen(Number(process.env.RELAY_ADMIN_PORT) || 8794, '0.0.0.0');
log({ msg: 'llm-relay listening' });

const shutdown = (): void => {
  clearInterval(sweep);
  admin.close();
  // In-flight model streams finish; the control plane's drain decides how long that may take.
  relay.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
