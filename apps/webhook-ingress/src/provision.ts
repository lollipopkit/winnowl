import { randomUUID } from 'node:crypto';
import type { Db } from '@reviewbot/db';
import {
  decideAdmission,
  parseAllowlist,
  parseProvisionMode,
  provisionTenant,
} from '@reviewbot/entitlement';
import { parseGithubDelivery, verifyGithubWebhook } from '@reviewbot/provider-github';
import type { IngestInput } from './types.js';

/**
 * Provisions a tenant for an unknown GitHub installation. Fail-closed: the delivery must verify against the
 * App-level `GITHUB_WEBHOOK_SECRET` first, otherwise anyone could create tenants with a forged payload.
 * Admission then follows `TENANT_PROVISION_MODE` (see @reviewbot/entitlement admission).
 */
export type TenantProvisioner = (input: IngestInput) => Promise<boolean>;

interface GhInstallationCreatedPayload {
  action?: string;
  installation?: { id?: number; account?: { login?: string } };
  sender?: { id?: number; login?: string };
}

export function createGithubTenantProvisioner(
  db: Db,
  appSecret: () => string | undefined = () => process.env.GITHUB_WEBHOOK_SECRET,
): TenantProvisioner {
  return async (input) => {
    if (input.provider !== 'github') return false;

    /*
     * `installation_repositories` for an unknown installation is a recovery path: if the platform lost the
     * installation, changing the repo selection reconnects it without reinstalling. The sender manages the
     * installation and becomes owner.
     */
    const eventHeader = input.headers['x-github-event'];
    const eventType = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
    if (eventType !== 'installation' && eventType !== 'installation_repositories') return false;

    let payload: GhInstallationCreatedPayload;
    try {
      payload = JSON.parse(input.body) as GhInstallationCreatedPayload;
    } catch {
      return false;
    }
    if (eventType === 'installation' && payload.action !== 'created') return false;
    const installationId = payload.installation?.id;
    const accountLogin = payload.installation?.account?.login;
    const sender = payload.sender;
    if (installationId === undefined || !accountLogin || sender?.id === undefined || !sender.login)
      return false;

    // No tenant yet, so the per-host KMS secret is not available.
    const secret = appSecret();
    if (!secret) return false;
    const raw = parseGithubDelivery(input.headers, input.body, 'pre-provision', input.receivedAt);
    if (!verifyGithubWebhook(raw, secret).valid) return false;

    const admission = decideAdmission({
      mode: parseProvisionMode(process.env.TENANT_PROVISION_MODE),
      allowlist: parseAllowlist(process.env.TENANT_PROVISION_ALLOWLIST),
      accountLogin,
    });

    if (admission.action !== 'provision') {
      if (admission.action === 'pending') {
        // Idempotent across redeliveries and reinstalls.
        await db
          .insertInto('pending_installations')
          .values({
            id: randomUUID(),
            provider: 'github',
            installation_native_id: String(installationId),
            account_login: accountLogin,
            installer_provider_user_id: String(sender.id),
            installer_login: sender.login,
            status: 'pending',
            decided_by: null,
            decided_at: null,
            created_at: new Date(),
          })
          .onConflict((oc) => oc.columns(['provider', 'installation_native_id']).doNothing())
          .execute()
          .catch(() => undefined);
      }
      // Not provisioned: the event ends unresolved, but the pending record is visible to operators.
      return false;
    }

    await provisionTenant(db, {
      provider: 'github',
      host: { baseUrl: 'https://github.com', apiUrl: 'https://api.github.com', isSaas: true },
      installationNativeId: String(installationId),
      accountLogin,
      installer: { providerUserId: String(sender.id), login: sender.login },
    });
    return true;
  };
}
