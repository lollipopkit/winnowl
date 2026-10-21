import type { Db } from '@reviewbot/db';
import type { MasterKeyProvider } from '@reviewbot/kms';
import { storeGithubAppCredentials, storeWebhookSecret } from '@reviewbot/provider-factory';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../rbac.js';

/** Admin only; stored KMS-encrypted. The host must belong to the current tenant. */
export function registerCredentialRoutes(app: FastifyInstance, db: Db, masterKey: MasterKeyProvider): void {
  app.post('/v1/provider-credentials', { preHandler: requirePermission('installation:manage') }, async (req, reply) => {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) return reply.code(400).send({ error: 'no_tenant_in_context' });

    const body = (req.body ?? {}) as {
      hostId?: string;
      kind?: 'github-app' | 'webhook-secret';
      appId?: string;
      privateKeyPem?: string;
      secret?: string;
    };
    if (!body.hostId) return reply.code(400).send({ error: 'hostId_required' });

    const host = await db
      .selectFrom('provider_hosts')
      .select(['id'])
      .where('id', '=', body.hostId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    if (!host) return reply.code(404).send({ error: 'host_not_found' });

    const kind = body.kind ?? 'github-app';
    if (kind === 'github-app') {
      if (!body.appId || !body.privateKeyPem) return reply.code(400).send({ error: 'appId_privateKeyPem_required' });
      await storeGithubAppCredentials(db, masterKey, { tenantId, hostId: body.hostId, appId: body.appId, privateKeyPem: body.privateKeyPem });
    } else if (kind === 'webhook-secret') {
      if (!body.secret) return reply.code(400).send({ error: 'secret_required' });
      await storeWebhookSecret(db, masterKey, { tenantId, hostId: body.hostId, secret: body.secret });
    } else {
      return reply.code(400).send({ error: 'unsupported_kind' });
    }
    // Never echo plaintext or ciphertext.
    return reply.code(204).send();
  });
}
