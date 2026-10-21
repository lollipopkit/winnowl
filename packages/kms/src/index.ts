export type { MasterKeyProvider } from './master-key.js';
export { createLocalMasterKey } from './master-key.js';
export { createVaultMasterKey } from './vault.js';
export type { VaultMasterKeyOptions } from './vault.js';
export { masterKeyFromEnv } from './env.js';

export type { EncryptedEnvelope } from './envelope.js';
export { encryptEnvelope, decryptEnvelope } from './envelope.js';

export { tenantObjectPrefix, tenantStorageKey, belongsToTenant } from './prefix.js';
