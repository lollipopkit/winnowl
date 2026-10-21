export interface RefreshableTokenOptions {
  refresh: () => Promise<{ token: string; expiresAtMs: number }>;
  /** Default Bearer. */
  scheme?: 'Bearer' | 'token';
  /** Refresh this many ms before expiry; default 60s. */
  skewMs?: number;
  now?: () => number;
}

/** Cached `RestClient.authorization`; concurrent callers share one in-flight refresh. */
export function createRefreshingToken(opts: RefreshableTokenOptions): () => Promise<string> {
  const scheme = opts.scheme ?? 'Bearer';
  const skewMs = opts.skewMs ?? 60_000;
  const now = opts.now ?? ((): number => Date.now());

  let cached: { token: string; expiresAtMs: number } | null = null;
  let inFlight: Promise<{ token: string; expiresAtMs: number }> | null = null;

  const expired = (): boolean => cached === null || now() + skewMs >= cached.expiresAtMs;

  return async (): Promise<string> => {
    if (!expired()) return `${scheme} ${cached!.token}`;
    if (!inFlight) {
      inFlight = opts
        .refresh()
        .then((r) => {
          cached = r;
          return r;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    const r = await inFlight;
    return `${scheme} ${r.token}`;
  };
}
