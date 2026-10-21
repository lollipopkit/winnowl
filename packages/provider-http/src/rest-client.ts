import { ProviderError } from '@reviewbot/provider-contracts';
import { readRateLimit, type RateLimitSnapshot } from './rate-limit.js';

export type QueryValue = string | number | boolean | undefined;

export interface RestRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  accept?: string;
  raw?: boolean;
}

export interface RestResponse<T> {
  status: number;
  headers: Headers;
  data: T;
  rateLimit: RateLimitSnapshot;
}

export interface RestClientOptions {
  baseUrl: string;
  userAgent?: string;
  defaultHeaders?: Record<string, string>;
  /** Called before every request. */
  authorization?: () => string | Promise<string>;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** The `page` param of the rel="next" `Link`; undefined when absent or not page-based. */
export function nextPage(link: string | null): string | undefined {
  for (const part of link?.split(',') ?? []) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (!match) continue;
    try {
      return new URL(match[1]!).searchParams.get('page') ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RestClient {
  private lastRateLimit: RateLimitSnapshot = {};

  constructor(private readonly options: RestClientOptions) {}

  get rateLimit(): RateLimitSnapshot {
    return this.lastRateLimit;
  }

  async request<T = unknown>(req: RestRequest): Promise<RestResponse<T>> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = buildUrl(this.options.baseUrl, req.path, req.query);
    const maxRetries = this.options.maxRetries ?? 2;

    const headers: Record<string, string> = {
      accept: req.accept ?? 'application/json',
      'user-agent': this.options.userAgent ?? 'winnowl',
      ...this.options.defaultHeaders,
      ...req.headers,
    };
    if (this.options.authorization) {
      headers.authorization = await this.options.authorization();
    }
    let payload: string | undefined;
    if (req.body !== undefined) {
      payload = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }

    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: req.method,
          headers,
          ...(payload !== undefined ? { body: payload } : {}),
        });
      } catch (cause) {
        if (attempt < maxRetries) {
          attempt += 1;
          await delay(100 * attempt);
          continue;
        }
        throw new ProviderError('network_error', `请求失败: ${req.method} ${url}`, {
          retryable: true,
          cause,
        });
      }

      const rate = readRateLimit(res.headers);
      this.lastRateLimit = rate;
      this.options.onRateLimit?.(rate);

      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxRetries) {
          attempt += 1;
          const retryAfter = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 100 * attempt;
          await delay(wait);
          continue;
        }
      }

      const text = await res.text();
      if (res.status >= 400) {
        throw new ProviderError('http_error', `${req.method} ${url} → ${res.status}: ${text.slice(0, 500)}`, {
          status: res.status,
          retryable: res.status === 429 || res.status >= 500,
        });
      }

      const data = (req.raw ? text : text ? JSON.parse(text) : undefined) as T;
      return { status: res.status, headers: res.headers, data, rateLimit: rate };
    }
  }

  get<T = unknown>(path: string, opts: Omit<RestRequest, 'method' | 'path'> = {}): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'GET', path, ...opts });
  }

  /**
   * Follows `Link: rel="next"` but only takes its `page`: requesting the response-supplied URL would
   * send the auth header wherever it points. Throws past `maxPages` rather than silently truncating.
   */
  async getAllPages<T>(
    path: string,
    opts: Omit<RestRequest, 'method' | 'path'> = {},
    maxPages = 50,
  ): Promise<T[]> {
    const all: T[] = [];
    let query = opts.query;
    for (let page = 1; ; page += 1) {
      const res = await this.get<T[]>(path, { ...opts, ...(query ? { query } : {}) });
      all.push(...(res.data ?? []));
      const next = nextPage(res.headers.get('link'));
      if (next === undefined) return all;
      if (page >= maxPages) {
        throw new ProviderError('http_error', `GET ${path}: more than ${maxPages} pages`, { retryable: false });
      }
      query = { ...opts.query, page: next };
    }
  }
  post<T = unknown>(path: string, opts: Omit<RestRequest, 'method' | 'path'> = {}): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'POST', path, ...opts });
  }
  patch<T = unknown>(path: string, opts: Omit<RestRequest, 'method' | 'path'> = {}): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'PATCH', path, ...opts });
  }
  put<T = unknown>(path: string, opts: Omit<RestRequest, 'method' | 'path'> = {}): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'PUT', path, ...opts });
  }
  delete<T = unknown>(path: string, opts: Omit<RestRequest, 'method' | 'path'> = {}): Promise<RestResponse<T>> {
    return this.request<T>({ method: 'DELETE', path, ...opts });
  }
}
