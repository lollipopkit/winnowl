import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { RelayUpstream } from '@reviewbot/review-runtime';

/**
 * Client of the model relay (apps/llm-relay): one grant per sandboxed review, holding that review's
 * keys on the API host. Grants are re-sent every few seconds while the review runs, so a relay that
 * restarted (deploy) has them back at once, and one this process stopped refreshing expires there.
 */
export interface RelayGrant {
  /** Base URL the sandbox calls (`<publicUrl>`; slots are `/r/<slot>` under it). */
  url: string;
  token: string;
  close(): Promise<void>;
}

const REFRESH_MS = 5_000;

export class LlmRelayClient {
  private readonly live = new Map<string, { body: string }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly o: {
      /** Admin API on the internal network, e.g. http://llm-relay:8794. */
      adminUrl: string;
      /** The relay as sandbox hosts reach it, e.g. http://100.64.0.1:8793. */
      publicUrl: string;
      adminToken: string;
      log?: (msg: string, data?: Record<string, unknown>) => void;
    },
  ) {}

  /**
   * Registers a grant. `upstreamsFor` builds the grant from the relay's address and the new token
   * (the sandbox's spec is rewritten with exactly those, see `relayExecutorSpec`).
   */
  async open(
    id: string,
    ttlMs: number,
    upstreamsFor: (relay: { url: string; token: string }) => Record<string, RelayUpstream>,
  ): Promise<RelayGrant> {
    const token = randomBytes(32).toString('hex');
    const upstreams = upstreamsFor({ url: this.o.publicUrl, token });
    const body = JSON.stringify({
      tokenSha256: createHash('sha256').update(token).digest('hex'),
      expiresAt: Date.now() + ttlMs,
      upstreams,
    });
    // The first registration must land: a review whose grant is missing could not call a model.
    await this.put(id, body);
    this.live.set(id, { body });
    this.timer ??= setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
    return {
      url: this.o.publicUrl,
      token,
      close: async () => {
        this.live.delete(id);
        if (this.live.size === 0 && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
        await this.request('DELETE', id).catch(() => undefined);
      },
    };
  }

  private async refresh(): Promise<void> {
    for (const [id, { body }] of this.live) {
      await this.put(id, body).catch((err: unknown) =>
        this.o.log?.('llm relay grant refresh failed', { grant: id, error: (err as Error).message }),
      );
    }
  }

  private async put(id: string, body: string): Promise<void> {
    const res = await this.request('PUT', id, body);
    if (!res.ok) throw new Error(`llm relay refused grant ${id}: ${res.status} ${await res.text()}`);
  }

  private request(method: 'PUT' | 'DELETE', id: string, body?: string): Promise<Response> {
    return fetch(`${this.o.adminUrl.replace(/\/+$/, '')}/grants/${encodeURIComponent(id)}`, {
      method,
      headers: { authorization: `Bearer ${this.o.adminToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  }
}

/** The relay admin token, derived like the agents' tokens (the relay only knows its sha256). */
export function relayAdminToken(secret: string): string {
  return createHmac('sha256', secret).update('llm-relay-admin').digest('hex');
}

/** From env (`LLM_RELAY_ADMIN_URL`, `LLM_RELAY_PUBLIC_URL`, `SANDBOX_AGENT_SECRET`); undefined when not configured. */
export function llmRelayFromEnv(
  env: NodeJS.ProcessEnv,
  log?: (msg: string, data?: Record<string, unknown>) => void,
): LlmRelayClient | undefined {
  const adminUrl = env.LLM_RELAY_ADMIN_URL?.trim();
  const publicUrl = env.LLM_RELAY_PUBLIC_URL?.trim();
  const secret = env.SANDBOX_AGENT_SECRET?.trim();
  if (!adminUrl || !publicUrl) return undefined;
  if (!secret) throw new Error('LLM_RELAY_ADMIN_URL requires SANDBOX_AGENT_SECRET');
  return new LlmRelayClient({ adminUrl, publicUrl, adminToken: relayAdminToken(secret), ...(log ? { log } : {}) });
}
