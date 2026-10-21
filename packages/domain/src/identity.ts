/**
 * External identities are matched only by `(kind, issuer, subject)`; a provider identity's issuer is
 * the forge origin. Never by login (renameable), email (controlled by self-hosted issuers) or
 * provider name (two forgejo hosts would collide on user id).
 */

/** Fixed origins of SaaS forges; self-hosted instances use their own base_url. */
export const SAAS_ORIGINS: Readonly<Record<string, string>> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
};

/** Normalises to protocol + lowercase host + port, so case/path variants map to one identity. */
export function normalizeIssuerOrigin(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.host}`;
}

/** Throws rather than inventing an issuer when neither base_url nor a SaaS origin is known. */
export function providerIssuer(provider: string, baseUrl?: string | null): string {
  if (baseUrl) return normalizeIssuerOrigin(baseUrl);
  const saas = SAAS_ORIGINS[provider];
  if (!saas) {
    throw new Error(`无法确定 ${provider} 身份的 issuer:自建实例必须提供 base_url(认人按 host,不按 provider 名)`);
  }
  return saas;
}

export interface IdentityRef {
  kind: 'oidc' | 'provider';
  /** oidc: JWT iss; provider: forge origin. */
  issuer: string;
  /** oidc: sub; provider: the forge's stable numeric user id. */
  subject: string;
  /** Display only; never used for matching. */
  login?: string;
  provider?: string;
}

export function sameIdentity(a: IdentityRef, b: IdentityRef): boolean {
  return a.kind === b.kind && a.issuer === b.issuer && a.subject === b.subject;
}
