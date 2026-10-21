import type { Db } from '@reviewbot/db';
import type { ProviderKind } from '@reviewbot/domain';
import type { MasterKeyProvider } from '@reviewbot/kms';
import { readWebhookSecret } from '@reviewbot/provider-factory';
import {
  normalizeForgejoWebhook,
  parseForgejoDelivery,
  verifyForgejoWebhook,
} from '@reviewbot/provider-forgejo';
import {
  normalizeGithubWebhook,
  parseGithubDelivery,
  verifyGithubWebhook,
} from '@reviewbot/provider-github';
import {
  normalizeGitlabWebhook,
  parseGitlabDelivery,
  verifyGitlabWebhook,
} from '@reviewbot/provider-gitlab';
import type { ContextResolver, IngestInput, SecretResolver, WebhookAdapter } from './types.js';

export function buildAdapters(): Partial<Record<ProviderKind, WebhookAdapter>> {
  return {
    github: {
      parse: parseGithubDelivery,
      verify: verifyGithubWebhook,
      normalize: normalizeGithubWebhook,
    },
    gitlab: {
      parse: parseGitlabDelivery,
      verify: verifyGitlabWebhook,
      normalize: normalizeGitlabWebhook,
    },
    forgejo: {
      parse: parseForgejoDelivery,
      verify: verifyForgejoWebhook,
      normalize: normalizeForgejoWebhook,
    },
  };
}

function githubInstallationNativeId(body: string): string | null {
  try {
    let jsonBody = body;
    if (!body.trimStart().startsWith('{')) {
      const encoded = new URLSearchParams(body).get('payload');
      if (encoded === null) return null;
      jsonBody = encoded;
    }
    const payload = JSON.parse(jsonBody) as { installation?: { id?: number } };
    return payload.installation?.id !== undefined ? String(payload.installation.id) : null;
  } catch {
    return null;
  }
}

/** GitHub resolves the installation from payload.installation.id; GitLab/Forgejo from the internal id in the path. */
export function createDbContextResolver(db: Db): ContextResolver {
  return async (input: IngestInput) => {
    if (input.provider === 'github') {
      const nativeId = githubInstallationNativeId(input.body);
      if (!nativeId) return null;
      const row = await db
        .selectFrom('installations')
        .innerJoin('provider_hosts', 'provider_hosts.id', 'installations.provider_host_id')
        .where('provider_hosts.provider', '=', 'github')
        .where('installations.native_id', '=', nativeId)
        .select([
          'installations.id as installationId',
          'installations.provider_host_id as providerHostId',
          'installations.tenant_id as tenantId',
        ])
        .executeTakeFirst();
      if (!row) return null;
      return {
        provider: 'github',
        tenantId: row.tenantId,
        providerHostId: row.providerHostId,
        installationId: row.installationId,
      };
    }

    if (!input.pathInstallationId) return null;
    const row = await db
      .selectFrom('installations')
      .where('id', '=', input.pathInstallationId)
      .select([
        'id as installationId',
        'provider_host_id as providerHostId',
        'tenant_id as tenantId',
      ])
      .executeTakeFirst();
    if (!row) return null;
    return {
      provider: input.provider,
      tenantId: row.tenantId,
      providerHostId: row.providerHostId,
      installationId: row.installationId,
    };
  };
}

/** Env-based secrets, for dev or when KMS is not configured. */
export function createEnvSecretResolver(): SecretResolver {
  const map: Partial<Record<ProviderKind, string | undefined>> = {
    github: process.env.GITHUB_WEBHOOK_SECRET,
    gitlab: process.env.GITLAB_WEBHOOK_SECRET,
    forgejo: process.env.FORGEJO_WEBHOOK_SECRET,
  };
  return async (ctx) => map[ctx.provider] ?? null;
}

/** Decrypts the host's `webhook-secret` envelope from provider_credentials; falls back to env when absent. */
export function createKmsSecretResolver(
  db: Db,
  kek: MasterKeyProvider,
  fallback: SecretResolver = createEnvSecretResolver(),
): SecretResolver {
  return async (ctx) => {
    const stored = await readWebhookSecret(db, kek, ctx.providerHostId);
    return stored ?? fallback(ctx);
  };
}
