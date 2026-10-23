import { randomUUID } from 'node:crypto';
import type { Db } from '@reviewbot/db';
import type { MasterKeyProvider } from '@reviewbot/kms';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from 'fastify-type-provider-zod';
import { loggerOptions, tracer } from './telemetry.js';
import { registerRequestTracing } from './request-tracing.js';
import { registerMetrics } from './metrics.js';
import { registerCors } from './auth/cors.js';
import { registerRbac, type RbacOptions } from './rbac.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPlanRoutes } from './routes/plans.js';
import { registerPlatformSettingsRoutes } from './routes/platform-settings.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerDataRoutes } from './routes/data.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerActionsRunnerRoutes, type ActionsRunnerOptions } from './routes/actions-runner.js';
import { registerInboxRoutes } from './routes/inbox.js';
import { registerFindingActionRoutes } from './routes/finding-actions.js';
import { registerLearningRoutes } from './routes/learnings.js';
import { registerGlobalLearningRoutes } from './routes/global-learnings.js';
import { registerEcosystemFactRoutes } from './routes/ecosystem-facts.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerCredentialRoutes } from './routes/credentials.js';
import { registerServiceCredentialRoutes } from './routes/service-credentials.js';
import { registerTenantSettingsRoutes } from './routes/tenant-settings.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerMeRoutes } from './routes/me.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCsrfGuard } from './auth/csrf.js';
import { requirePlatformOperator } from './platform-operator.js';
import type { OAuthProvider } from './auth/oauth.js';
import type { Mailer } from './mailer.js';

export interface BuildServerOptions {
  quiet?: boolean;
  rbac?: RbacOptions;
  /** Enables the console data endpoints. */
  db?: Db;
  /** Enables provider credential management endpoints. */
  masterKey?: MasterKeyProvider;
  /** Requests to BYOK providers (key check, model list); tests inject a fake. */
  byokFetch?: typeof fetch;
  /** Absent = invites are not emailed; the token is shared manually. */
  mailer?: Mailer;
  /** Public console URL, used for invite accept links. */
  consoleBaseUrl?: string;
  /** Absent = `/v1/auth/*` is not registered and requests are anonymous viewers (dev). Also used for account linking. */
  oauthProviders?: Map<string, OAuthProvider>;
  /** GitHub Actions runner endpoints; the issuer is overridable for tests. */
  actionsRunner?: ActionsRunnerOptions;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.quiet ? { level: 'silent' } : loggerOptions,
    genReqId: () => randomUUID(),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'winnowl control-api', version: '0.0.0' },
    },
    transform: jsonSchemaTransform,
  });
  registerRequestTracing(app, tracer);
  // CORS first: a preflight is answered before any session is resolved.
  registerCors(app);
  registerRbac(app, options.rbac ?? {});
  // Must be registered after rbac: identity is resolved before the origin check.
  registerCsrfGuard(app);
  // Swagger UI reads static assets from __dirname at runtime and cannot be bundled, so it loads only with ENABLE_DOCS_UI=true.
  if (process.env.ENABLE_DOCS_UI === 'true') {
    const swaggerUi = (await import('@fastify/swagger-ui')).default;
    // Registered after rbac so req.auth is resolved. Platform operators only: the API host is
    // public, so no route may rely on simply not being proxied.
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiHooks: { preHandler: requirePlatformOperator },
    });
  }
  registerMetrics(app);
  registerHealthRoutes(app);
  registerConfigRoutes(app);
  registerAdminRoutes(app);
  if (options.db) {
    registerDataRoutes(app, options.db);
    registerActionRoutes(app, options.db);
    registerActionsRunnerRoutes(app, options.db, options.actionsRunner ?? {});
    registerInboxRoutes(app, options.db);
    registerFindingActionRoutes(app, options.db);
    registerLearningRoutes(app, options.db);
    registerGlobalLearningRoutes(app, options.db);
    registerEcosystemFactRoutes(app, options.db);
    registerConversationRoutes(app, options.db);
    registerMeRoutes(app, options.db);
    registerMemberRoutes(app, options.db, { ...(options.mailer ? { mailer: options.mailer } : {}), ...(options.consoleBaseUrl ? { consoleBaseUrl: options.consoleBaseUrl } : {}) });
    registerInviteRoutes(app, options.db);
    registerTenantSettingsRoutes(app, options.db);
    registerPlanRoutes(app, options.db);
    registerPlatformSettingsRoutes(app, options.db);
    registerAccountRoutes(app, options.db);
    // Self-hosted login only needs KMS (to decrypt client_secret), even with no built-in provider.
    if ((options.oauthProviders && options.oauthProviders.size > 0) || options.masterKey) {
      registerAuthRoutes(app, options.db, {
        providers: options.oauthProviders ?? new Map(),
        ...(options.masterKey ? { masterKey: options.masterKey } : {}),
      });
    }
    if (options.masterKey) {
      registerCredentialRoutes(app, options.db, options.masterKey);
      registerServiceCredentialRoutes(app, options.db, options.masterKey, options.byokFetch);
    }
  }

  return app;
}
