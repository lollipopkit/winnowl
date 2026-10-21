import { consoleBaseUrl } from '@reviewbot/config';
import { createDb, createPool } from '@reviewbot/db';
import { masterKeyFromEnv } from '@reviewbot/kms';
import { buildServer } from './server.js';
import { createSessionAuthResolver } from './auth-db.js';
import { oauthProviders } from './auth/oauth.js';
import { sessionKey } from './auth/session.js';
import { mailerFromEnv } from './mailer.js';
import type { RbacOptions } from './rbac.js';
import { logger, telemetry } from './telemetry.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

// Without DATABASE_URL only health/metrics/docs are served.
const connectionString = process.env.DATABASE_URL;
const pool = connectionString ? createPool({ connectionString }) : undefined;
const db = pool ? createDb(pool) : undefined;

// Must be the same KEK as runner and webhook-ingress.
const masterKey = masterKeyFromEnv() ?? undefined;

// Without a DB or any login source, /v1/auth/* is not registered and every request is an anonymous viewer (dev).
const providers = db ? oauthProviders() : new Map();
// Login works with a built-in provider or with KMS (needed to decrypt self-hosted client_secret).
const loginAvailable = Boolean(db) && (providers.size > 0 || Boolean(masterKey));
let rbac: RbacOptions | undefined;
if (db && loginAvailable) {
  // Resolve the signing key at startup so a missing key fails fast instead of on first login.
  sessionKey();
  rbac = { resolveAuth: createSessionAuthResolver({ db }) };
  logger.info({ providers: [...providers.keys()] }, 'OAuth 登录 + DB authz(memberships)已启用');
} else {
  logger.warn('未配置 OAuth 登录源(GITHUB_OAUTH_CLIENT_ID/SECRET):所有请求按匿名 viewer 处理');
}

const mailer = mailerFromEnv();
const consoleUrl = consoleBaseUrl(process.env);

const app = await buildServer({
  ...(db ? { db } : {}),
  ...(masterKey ? { masterKey } : {}),
  ...(rbac ? { rbac } : {}),
  ...(mailer ? { mailer } : {}),
  ...(consoleUrl ? { consoleBaseUrl: consoleUrl } : {}),
  ...(providers.size > 0 ? { oauthProviders: providers } : {}),
});

try {
  await app.listen({ port, host });
} catch (error) {
  logger.error(error, 'control-api 启动失败');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => (pool ? pool.end() : undefined))
      .then(() => telemetry.shutdown())
      .then(() => process.exit(0));
  });
}
