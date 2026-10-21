import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { MasterKeyProvider } from './master-key.js';

export interface EncryptedEnvelope {
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  /** DEK wrapped by the KEK (base64). */
  wrappedDek: string;
}

const GCM_IV_BYTES = 12;
const DEK_BYTES = 32;

/** Fresh random DEK per call; the KEK-wrapped DEK is stored with the ciphertext. */
export async function encryptEnvelope(plaintext: string | Buffer, kek: MasterKeyProvider): Promise<EncryptedEnvelope> {
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const dek = randomBytes(DEK_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedDek = await kek.wrap(dek);
  return {
    keyId: kek.keyId,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    wrappedDek,
  };
}

export async function decryptEnvelope(envelope: EncryptedEnvelope, kek: MasterKeyProvider): Promise<Buffer> {
  if (envelope.keyId !== kek.keyId) {
    throw new Error(`keyId 不匹配:信封 ${envelope.keyId} ≠ KEK ${kek.keyId}`);
  }
  const dek = await kek.unwrap(envelope.wrappedDek);
  const iv = Buffer.from(envelope.iv, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
}
