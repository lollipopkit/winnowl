import { createSign } from 'node:crypto';
import type { RestClient } from '@reviewbot/provider-http';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export interface GitHubAppAuthOptions {
  appId: string;
  privateKeyPem: string;
  installationId: string;
  /** Unauthenticated client for the GitHub API base. */
  client: RestClient;
  now?: () => number;
  /** Refresh this many ms before expiry (default 60s). */
  refreshSkewMs?: number;
}

interface AccessTokenResponse {
  token: string;
  expires_at: string;
}

/** Installation tokens, cached until near expiry. They stay on the control plane, never in a sandbox. */
export class GitHubAppAuth {
  private cached: { token: string; expiresAtMs: number } | undefined;

  constructor(private readonly options: GitHubAppAuthOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  appJwt(): string {
    const iat = Math.floor(this.now() / 1000) - 30;
    const exp = iat + 9 * 60;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat, exp, iss: this.options.appId }));
    const signingInput = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(this.options.privateKeyPem);
    return `${signingInput}.${base64url(signature)}`;
  }

  async installationToken(): Promise<string> {
    const skew = this.options.refreshSkewMs ?? 60_000;
    if (this.cached && this.cached.expiresAtMs - skew > this.now()) {
      return this.cached.token;
    }
    const res = await this.options.client.post<AccessTokenResponse>(
      `app/installations/${this.options.installationId}/access_tokens`,
      { headers: { authorization: `Bearer ${this.appJwt()}` } },
    );
    const expiresAtMs = Date.parse(res.data.expires_at);
    this.cached = {
      token: res.data.token,
      expiresAtMs: Number.isNaN(expiresAtMs) ? this.now() + 3_600_000 : expiresAtMs,
    };
    return this.cached.token;
  }

  /**
   * Token narrowed to some repositories and permissions, not cached (valid one hour). For what leaves
   * the control plane, e.g. a read-only clone token on a sandbox host.
   */
  async scopedInstallationToken(scope: {
    repositoryIds: number[];
    permissions: Record<string, 'read' | 'write'>;
  }): Promise<string> {
    if (scope.repositoryIds.length === 0) throw new Error('a scoped token needs at least one repository');
    const res = await this.options.client.post<AccessTokenResponse>(
      `app/installations/${this.options.installationId}/access_tokens`,
      {
        headers: { authorization: `Bearer ${this.appJwt()}` },
        body: { repository_ids: scope.repositoryIds, permissions: scope.permissions },
      },
    );
    return res.data.token;
  }

  authorization(): () => Promise<string> {
    return async () => `token ${await this.installationToken()}`;
  }
}
