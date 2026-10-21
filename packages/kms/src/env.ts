import { createLocalMasterKey, type MasterKeyProvider } from './master-key.js';
import { createVaultMasterKey } from './vault.js';

/**
 * Precedence: Vault Transit > local KEK (base64, 32 bytes) > null. control-api, runner and
 * webhook-ingress must resolve the same KEK or they cannot open each other's envelopes.
 */
export function masterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): MasterKeyProvider | null {
  if (env.KMS_VAULT_ADDR && env.KMS_VAULT_TOKEN && env.KMS_VAULT_TRANSIT_KEY) {
    return createVaultMasterKey({
      endpoint: env.KMS_VAULT_ADDR,
      token: env.KMS_VAULT_TOKEN,
      keyName: env.KMS_VAULT_TRANSIT_KEY,
      ...(env.KMS_VAULT_TRANSIT_MOUNT ? { mount: env.KMS_VAULT_TRANSIT_MOUNT } : {}),
    });
  }
  const kekId = env.KMS_KEK_ID;
  const kekBase64 = env.KMS_KEK_BASE64;
  if (kekId && kekBase64) {
    return createLocalMasterKey(kekId, Buffer.from(kekBase64, 'base64'));
  }
  return null;
}
