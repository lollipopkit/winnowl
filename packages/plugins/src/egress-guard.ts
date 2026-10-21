/**
 * Application-level egress guard: plugin fetches may only reach allowlisted hosts, else fail closed.
 * Defence in depth against SSRF/exfiltration on top of the hard-coded plugin endpoints.
 */
export class EgressDeniedError extends Error {
  constructor(host: string) {
    super(`egress denied: ${host} not in plugin allowlist`);
    this.name = 'EgressDeniedError';
  }
}

export function egressGuardedFetch(allowHosts: readonly string[], base: typeof fetch = fetch): typeof fetch {
  const allow = new Set(allowHosts.map((h) => h.toLowerCase()));
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    let host: string;
    try {
      host = new URL(href).host.toLowerCase();
    } catch {
      throw new EgressDeniedError('(invalid url)');
    }
    const hostname = host.split(':')[0] ?? host; // the allowlist holds hostnames without ports
    if (!allow.has(host) && !allow.has(hostname)) throw new EgressDeniedError(hostname);
    return base(input, init);
  }) as typeof fetch;
}
