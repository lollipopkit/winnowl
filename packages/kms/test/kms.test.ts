import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  belongsToTenant,
  createLocalMasterKey,
  decryptEnvelope,
  encryptEnvelope,
  masterKeyFromEnv,
  tenantStorageKey,
} from '../src/index.js';

describe('信封加密', () => {
  const kek = createLocalMasterKey('kek-1', randomBytes(32));

  it('加密后可解密还原', async () => {
    const env = await encryptEnvelope('secret webhook payload', kek);
    expect(env.keyId).toBe('kek-1');
    expect(env.ciphertext).not.toContain('secret');
    expect((await decryptEnvelope(env, kek)).toString('utf8')).toBe('secret webhook payload');
  });

  it('每次加密 DEK/IV 随机 → 密文不同', async () => {
    const a = await encryptEnvelope('same', kek);
    const b = await encryptEnvelope('same', kek);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
  });

  it('错误 KEK / 篡改 authTag → 解密失败', async () => {
    const env = await encryptEnvelope('data', kek);
    const other = createLocalMasterKey('kek-2', randomBytes(32));
    await expect(decryptEnvelope(env, other)).rejects.toThrow(); // keyId mismatch
    const tampered = { ...env, authTag: Buffer.from(randomBytes(16)).toString('base64') };
    await expect(decryptEnvelope(tampered, kek)).rejects.toThrow();
  });

  it('主密钥必须 32 字节', () => {
    expect(() => createLocalMasterKey('x', randomBytes(16))).toThrow();
  });
});

describe('masterKeyFromEnv(§42/§43 env → KEK 提供者)', () => {
  it('Vault 三要素齐全 → Vault Transit provider(keyId=keyName)', () => {
    const kek = masterKeyFromEnv({
      KMS_VAULT_ADDR: 'http://vault:8200',
      KMS_VAULT_TOKEN: 'root',
      KMS_VAULT_TRANSIT_KEY: 'reviewbot',
    } as NodeJS.ProcessEnv);
    expect(kek?.keyId).toBe('reviewbot');
  });

  it('无 Vault 但本地 KEK 配齐 → 本地 AES provider,可加解密', async () => {
    const b64 = randomBytes(32).toString('base64');
    const kek = masterKeyFromEnv({ KMS_KEK_ID: 'kek-local', KMS_KEK_BASE64: b64 } as NodeJS.ProcessEnv);
    expect(kek?.keyId).toBe('kek-local');
    const env = await encryptEnvelope('x', kek!);
    expect((await decryptEnvelope(env, kek!)).toString('utf8')).toBe('x');
  });

  it('Vault 优先于本地 KEK', () => {
    const kek = masterKeyFromEnv({
      KMS_VAULT_ADDR: 'http://vault:8200',
      KMS_VAULT_TOKEN: 'root',
      KMS_VAULT_TRANSIT_KEY: 'vault-key',
      KMS_KEK_ID: 'local',
      KMS_KEK_BASE64: randomBytes(32).toString('base64'),
    } as NodeJS.ProcessEnv);
    expect(kek?.keyId).toBe('vault-key');
  });

  it('无任何 KEK 配置 → null', () => {
    expect(masterKeyFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('per-tenant prefix', () => {
  it('存储键归属校验', () => {
    const key = tenantStorageKey('tenant-a', 'artifact', 'id1');
    expect(key).toBe('tenant-a/artifact/id1');
    expect(belongsToTenant(key, 'tenant-a')).toBe(true);
    expect(belongsToTenant(key, 'tenant-b')).toBe(false);
  });
});
