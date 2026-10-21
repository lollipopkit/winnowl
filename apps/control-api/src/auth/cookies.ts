/** Hand-written instead of `@fastify/cookie`: we only handle our own JWT/base64url cookies, which need no encoding. */

/** Duplicate names keep the first, matching browser send order. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export interface CookieOptions {
  maxAgeSec?: number;
  /** Omitted = session cookie. */
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  /** Omitted = host-only (the default for every credential cookie). */
  domain?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`];
  if (opts.maxAgeSec !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`);
    // Some old browsers and proxies only honor Expires.
    parts.push(`Expires=${new Date(Date.now() + opts.maxAgeSec * 1000).toUTCString()}`);
  }
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

/** Attributes must match the original cookie or the browser treats it as a different one. */
export function clearCookie(name: string, opts: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...opts, maxAgeSec: 0 });
}
