import { readFileSync } from 'node:fs';
import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { decryptEnvelope, encryptEnvelope, type EncryptedEnvelope, type MasterKeyProvider } from '@reviewbot/kms';

export interface GithubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

/** Plaintext is only held briefly in the control plane, never in a sandbox. */
export interface ProviderCredentialStore {
  githubAppCredentials(hostId: string): Promise<GithubAppCredentials | null>;
  token(hostId: string): Promise<string | null>;
}

/** Single App / single token from env (dev, single-tenant, or fallback). */
export function createEnvCredentialStore(env: NodeJS.ProcessEnv = process.env): ProviderCredentialStore {
  return {
    async githubAppCredentials(): Promise<GithubAppCredentials | null> {
      const appId = env.GITHUB_APP_ID;
      const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY ?? readPemFile(env.GITHUB_APP_PRIVATE_KEY_PATH);
      if (!appId || !privateKeyPem) return null;
      return { appId, privateKeyPem };
    },
    async token(): Promise<string | null> {
      return env.PROVIDER_TOKEN ?? null;
    },
  };
}

function readPemFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function createKmsCredentialStore(db: Db, kek: MasterKeyProvider): ProviderCredentialStore {
  return {
    async githubAppCredentials(hostId: string): Promise<GithubAppCredentials | null> {
      const plain = await readCredential(db, kek, hostId, 'github-app');
      if (plain === null) return null;
      return JSON.parse(plain) as GithubAppCredentials;
    },
    async token(hostId: string): Promise<string | null> {
      return readCredential(db, kek, hostId, 'token');
    },
  };
}

/** Falls back on a miss **or an error**, so a Vault outage degrades to env instead of failing reviews. */
export function createFallbackCredentialStore(
  primary: ProviderCredentialStore,
  fallback: ProviderCredentialStore,
  onError?: (kind: 'github-app' | 'token', hostId: string, err: unknown) => void,
): ProviderCredentialStore {
  return {
    async githubAppCredentials(hostId: string): Promise<GithubAppCredentials | null> {
      try {
        const found = await primary.githubAppCredentials(hostId);
        if (found) return found;
      } catch (err) {
        onError?.('github-app', hostId, err);
      }
      return fallback.githubAppCredentials(hostId);
    },
    async token(hostId: string): Promise<string | null> {
      try {
        const found = await primary.token(hostId);
        if (found) return found;
      } catch (err) {
        onError?.('token', hostId, err);
      }
      return fallback.token(hostId);
    },
  };
}

async function readCredential(db: Db, kek: MasterKeyProvider, hostId: string, kind: string): Promise<string | null> {
  const row = await db
    .selectFrom('provider_credentials')
    .select('envelope')
    .where('provider_host_id', '=', hostId)
    .where('kind', '=', kind)
    .executeTakeFirst();
  if (!row) return null;
  return (await decryptEnvelope(row.envelope as unknown as EncryptedEnvelope, kek)).toString('utf8');
}

export interface StoreCredentialInput {
  tenantId: string;
  hostId: string;
  kind: 'github-app' | 'token' | 'webhook-secret';
  plaintext: string;
  now?: number;
}

/** Upserts on host+kind. */
export async function storeCredential(db: Db, kek: MasterKeyProvider, input: StoreCredentialInput): Promise<void> {
  const envelope = (await encryptEnvelope(input.plaintext, kek)) as unknown as Record<string, unknown>;
  const now = new Date(input.now ?? Date.now());
  await db
    .insertInto('provider_credentials')
    .values({
      id: uuidv7(input.now),
      tenant_id: input.tenantId,
      provider_host_id: input.hostId,
      kind: input.kind,
      envelope,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['provider_host_id', 'kind']).doUpdateSet({ envelope, updated_at: now }))
    .execute();
}

export async function storeWebhookSecret(
  db: Db,
  kek: MasterKeyProvider,
  input: { tenantId: string; hostId: string; secret: string; now?: number },
): Promise<void> {
  await storeCredential(db, kek, {
    tenantId: input.tenantId,
    hostId: input.hostId,
    kind: 'webhook-secret',
    plaintext: input.secret,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

export async function readWebhookSecret(db: Db, kek: MasterKeyProvider, hostId: string): Promise<string | null> {
  return readCredential(db, kek, hostId, 'webhook-secret');
}

export async function storeGithubAppCredentials(
  db: Db,
  kek: MasterKeyProvider,
  input: { tenantId: string; hostId: string; appId: string; privateKeyPem: string; now?: number },
): Promise<void> {
  await storeCredential(db, kek, {
    tenantId: input.tenantId,
    hostId: input.hostId,
    kind: 'github-app',
    plaintext: JSON.stringify({ appId: input.appId, privateKeyPem: input.privateKeyPem }),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}
