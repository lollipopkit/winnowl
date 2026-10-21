import { createHash } from 'node:crypto';
import type { Db } from '@reviewbot/db';
import { uuidv7 } from '@reviewbot/ids';
import { decryptEnvelope, encryptEnvelope, type EncryptedEnvelope, type MasterKeyProvider } from '@reviewbot/kms';
import type { ArtifactStore } from './store.js';

export class ArtifactTooLargeError extends Error {
  constructor(bytes: number, maxBytes: number) {
    super(`artifact ${bytes}B 超过上限 ${maxBytes}B`);
    this.name = 'ArtifactTooLargeError';
  }
}

export class ArtifactIntegrityError extends Error {
  constructor(id: string) {
    super(`artifact ${id} sha256 校验失败`);
    this.name = 'ArtifactIntegrityError';
  }
}

export class ArtifactEncryptedError extends Error {
  constructor(id: string) {
    super(`artifact ${id} 为加密存储,读取需提供 KEK`);
    this.name = 'ArtifactEncryptedError';
  }
}

export interface PutArtifactInput {
  tenantId: string;
  kind: string;
  content: Buffer | string;
  contentType?: string;
  maxBytes?: number;
  ttlDays?: number;
  metadata?: Record<string, unknown>;
  now?: number;
}

export interface ArtifactRef {
  id: string;
  storageKey: string;
  sha256: string;
  bytes: number;
}

/**
 * With `kek` the content is envelope-encrypted so object storage only sees ciphertext.
 * `size_bytes` and sha256 are over the plaintext, so reads decrypt before verifying.
 */
export async function putArtifact(
  db: Db,
  store: ArtifactStore,
  input: PutArtifactInput,
  kek?: MasterKeyProvider,
): Promise<ArtifactRef> {
  const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
  const bytes = content.byteLength;
  if (input.maxBytes !== undefined && bytes > input.maxBytes) {
    throw new ArtifactTooLargeError(bytes, input.maxBytes);
  }

  const sha256 = createHash('sha256').update(content).digest('hex');
  const id = uuidv7(input.now);
  // per-tenant object prefix
  const storageKey = `${input.tenantId}/${input.kind}/${id}`;
  const stored = kek ? Buffer.from(JSON.stringify(await encryptEnvelope(content, kek)), 'utf8') : content;
  await store.put(storageKey, stored);

  const nowDate = new Date(input.now ?? Date.now());
  const expiresAt =
    input.ttlDays !== undefined ? new Date(nowDate.getTime() + input.ttlDays * 86_400_000) : null;

  await db
    .insertInto('artifacts')
    .values({
      id,
      tenant_id: input.tenantId,
      kind: input.kind,
      storage_key: storageKey,
      content_type: input.contentType ?? null,
      size_bytes: bytes,
      sha256,
      encrypted: kek !== undefined,
      expires_at: expiresAt,
      metadata: input.metadata ?? {},
      created_at: nowDate,
    })
    .execute();

  return { id, storageKey, sha256, bytes };
}

export interface ArtifactContent {
  id: string;
  kind: string;
  content: Buffer;
  sha256: string;
  bytes: number;
}

/** Encrypted artifacts need `kek` (else ArtifactEncryptedError); sha256 is checked on the plaintext. */
export async function getArtifact(
  db: Db,
  store: ArtifactStore,
  id: string,
  kek?: MasterKeyProvider,
): Promise<ArtifactContent | null> {
  const row = await db
    .selectFrom('artifacts')
    .select(['id', 'kind', 'storage_key', 'sha256', 'size_bytes', 'encrypted'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return null;

  const raw = await store.get(row.storage_key);
  let content: Buffer;
  if (row.encrypted) {
    if (!kek) throw new ArtifactEncryptedError(id);
    const envelope = JSON.parse(raw.toString('utf8')) as EncryptedEnvelope;
    content = await decryptEnvelope(envelope, kek);
  } else {
    content = raw;
  }
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== row.sha256) {
    throw new ArtifactIntegrityError(id);
  }
  return { id: row.id, kind: row.kind, content, sha256: row.sha256, bytes: Number(row.size_bytes) };
}
