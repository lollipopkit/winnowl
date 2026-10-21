import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** KEK provider; async so remote KMS backends fit the same interface. */
export interface MasterKeyProvider {
  keyId: string;
  wrap(dek: Buffer): Promise<string>;
  unwrap(wrappedDek: string): Promise<Buffer>;
}

const GCM_IV_BYTES = 12;

/** 32-byte local key; AES-256-GCM. */
export function createLocalMasterKey(keyId: string, keyMaterial: Buffer): MasterKeyProvider {
  if (keyMaterial.length !== 32) throw new Error('master key 必须为 32 字节(AES-256)');
  return {
    keyId,
    wrap(dek: Buffer): Promise<string> {
      const iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', keyMaterial, iv);
      const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Promise.resolve(Buffer.concat([iv, tag, ct]).toString('base64'));
    },
    unwrap(wrappedDek: string): Promise<Buffer> {
      const buf = Buffer.from(wrappedDek, 'base64');
      const iv = buf.subarray(0, GCM_IV_BYTES);
      const tag = buf.subarray(GCM_IV_BYTES, GCM_IV_BYTES + 16);
      const ct = buf.subarray(GCM_IV_BYTES + 16);
      const decipher = createDecipheriv('aes-256-gcm', keyMaterial, iv);
      decipher.setAuthTag(tag);
      return Promise.resolve(Buffer.concat([decipher.update(ct), decipher.final()]));
    },
  };
}
