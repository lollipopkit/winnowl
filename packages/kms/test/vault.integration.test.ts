import { startVault, type StartedVault } from '@reviewbot/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVaultMasterKey, decryptEnvelope, encryptEnvelope } from '../src/index.js';

const KEY = 'reviewbot-kek';

describe('Vault Transit KEK', () => {
  let vault: StartedVault;

  beforeAll(async () => {
    vault = await startVault();
    const h = { 'X-Vault-Token': vault.token, 'content-type': 'application/json' };
    await fetch(`${vault.endpoint}/v1/sys/mounts/transit`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'transit' }) });
    await fetch(`${vault.endpoint}/v1/transit/keys/${KEY}`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'aes256-gcm96' }) });
  }, 120_000);

  afterAll(async () => {
    await vault?.stop();
  });

  function kek(): ReturnType<typeof createVaultMasterKey> {
    return createVaultMasterKey({ endpoint: vault.endpoint, token: vault.token, keyName: KEY });
  }

  it('wrap → unwrap 往返(DEK 不离 Vault,密文 vault:vN:…)', async () => {
    const k = kek();
    const dek = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const wrapped = await k.wrap(dek);
    expect(wrapped).toMatch(/^vault:v\d+:/);
    expect((await k.unwrap(wrapped)).equals(dek)).toBe(true);
  });

  it('信封加解密经 Vault KEK 往返', async () => {
    const k = kek();
    const env = await encryptEnvelope('webhook secret 明文', k);
    expect(env.keyId).toBe(KEY);
    expect(env.wrappedDek).toMatch(/^vault:v\d+:/);
    expect((await decryptEnvelope(env, k)).toString('utf8')).toBe('webhook secret 明文');
  });

  it('错误 token → wrap 抛错', async () => {
    const bad = createVaultMasterKey({ endpoint: vault.endpoint, token: 'wrong', keyName: KEY });
    await expect(bad.wrap(Buffer.from('x'.repeat(32)))).rejects.toThrow(/Vault/);
  });
});
