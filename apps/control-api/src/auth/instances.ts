/**
 * Self-hosted login sources are registered by operators, not entered by users: `issuer` is an identity key,
 * so defining it is privileged, and the server only contacts registered origins (no SSRF).
 */
import { randomUUID } from 'node:crypto';
import { runWithoutTenant, type Db } from '@reviewbot/db';
import { normalizeIssuerOrigin } from '@reviewbot/domain';
import { decryptEnvelope, encryptEnvelope, type EncryptedEnvelope, type MasterKeyProvider } from '@reviewbot/kms';
import { forgejoProvider, type OAuthProvider } from './oauth.js';

const SUPPORTED = new Set(['forgejo']);

export interface LoginInstanceView {
  id: string;
  provider: string;
  issuer: string;
  label: string;
  clientId: string;
  createdAt: string;
}

/**
 * Requires https (except localhost) since credentials travel this way. Normalizes to the origin so case or
 * path differences cannot bypass the unique constraint.
 */
export function normalizeInstanceUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('实例地址不是合法的 URL');
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal) throw new Error('实例地址必须是 https(仅 localhost 可用 http)');
  return normalizeIssuerOrigin(url.toString());
}

/** Upserts by origin. */
export async function upsertLoginInstance(
  db: Db,
  kek: MasterKeyProvider,
  input: { provider: string; url: string; label?: string; clientId: string; clientSecret: string; createdBy?: string },
): Promise<LoginInstanceView> {
  if (!SUPPORTED.has(input.provider)) throw new Error(`不支持的 forge 类型:${input.provider}`);
  const issuer = normalizeInstanceUrl(input.url);
  const label = input.label?.trim() || new URL(issuer).host;
  const envelope = await encryptEnvelope(input.clientSecret, kek);
  const now = new Date();
  await runWithoutTenant(() =>
    db
      .insertInto('login_instances')
      .values({
        id: randomUUID(),
        provider: input.provider,
        issuer,
        label,
        client_id: input.clientId,
        secret_envelope: envelope as unknown as Record<string, unknown>,
        created_by: input.createdBy ?? null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('issuer').doUpdateSet({
          provider: input.provider,
          label,
          client_id: input.clientId,
          secret_envelope: envelope as unknown as Record<string, unknown>,
          updated_at: now,
        }),
      )
      .execute(),
  );
  const row = await runWithoutTenant(() =>
    db.selectFrom('login_instances').selectAll().where('issuer', '=', issuer).executeTakeFirstOrThrow(),
  );
  return toView(row);
}

export async function listLoginInstances(db: Db): Promise<LoginInstanceView[]> {
  const rows = await runWithoutTenant(() => db.selectFrom('login_instances').selectAll().orderBy('created_at').execute());
  return rows.map(toView);
}

export async function deleteLoginInstance(db: Db, id: string): Promise<boolean> {
  const res = await runWithoutTenant(() => db.deleteFrom('login_instances').where('id', '=', id).executeTakeFirst());
  return (res.numDeletedRows ?? 0n) > 0n;
}

function toView(row: {
  id: string;
  provider: string;
  issuer: string;
  label: string;
  client_id: string;
  created_at: Date | string;
}): LoginInstanceView {
  return {
    id: row.id,
    provider: row.provider,
    issuer: row.issuer,
    label: row.label,
    clientId: row.client_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Loaded per login so changes apply without restart; the provider id is the host. */
export async function loadInstanceProviders(db: Db, kek: MasterKeyProvider): Promise<Map<string, OAuthProvider>> {
  const rows = await runWithoutTenant(() => db.selectFrom('login_instances').selectAll().execute());
  const out = new Map<string, OAuthProvider>();
  for (const row of rows) {
    if (!SUPPORTED.has(row.provider)) continue;
    const secret = (await decryptEnvelope(row.secret_envelope as unknown as EncryptedEnvelope, kek)).toString('utf8');
    const provider = forgejoProvider({ issuer: row.issuer, label: row.label, clientId: row.client_id, clientSecret: secret });
    out.set(provider.id, provider);
  }
  return out;
}

