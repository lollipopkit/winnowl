import type { MasterKeyProvider } from './master-key.js';

export interface VaultMasterKeyOptions {
  /** e.g. http://127.0.0.1:8200 */
  endpoint: string;
  token: string;
  keyName: string;
  /** Default `transit`. */
  mount?: string;
  fetchFn?: typeof fetch;
}

/**
 * The key never leaves Vault; rotation is handled by Transit versioning (ciphertext carries the
 * version), so the envelope keyId is just the logical key name.
 */
export function createVaultMasterKey(opts: VaultMasterKeyOptions): MasterKeyProvider {
  const mount = opts.mount ?? 'transit';
  const base = opts.endpoint.replace(/\/$/, '');
  const doFetch = opts.fetchFn ?? fetch;

  async function call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await doFetch(`${base}/v1/${mount}/${path}`, {
      method: 'POST',
      headers: { 'X-Vault-Token': opts.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Vault ${path} 失败 ${res.status}: ${text.slice(0, 200)}`);
    }
    return ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
  }

  return {
    keyId: opts.keyName,
    async wrap(dek: Buffer): Promise<string> {
      const data = await call(`encrypt/${opts.keyName}`, { plaintext: dek.toString('base64') });
      const ciphertext = data.ciphertext;
      if (typeof ciphertext !== 'string') throw new Error('Vault encrypt 未返回 ciphertext');
      return ciphertext;
    },
    async unwrap(wrappedDek: string): Promise<Buffer> {
      const data = await call(`decrypt/${opts.keyName}`, { ciphertext: wrappedDek });
      const plaintext = data.plaintext;
      if (typeof plaintext !== 'string') throw new Error('Vault decrypt 未返回 plaintext');
      return Buffer.from(plaintext, 'base64');
    },
  };
}
