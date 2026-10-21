/**
 * Image URLs come from untrusted PR markdown. Only provider user-content hosts, image types and
 * bounded counts/sizes are fetched; anything else would make review an SSRF vector.
 */

const MD_IMAGE = /!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

export function extractImageUrls(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const url = raw.replace(/^<|>$/g, '').trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  for (const m of markdown.matchAll(MD_IMAGE)) push(m[1]!);
  for (const m of markdown.matchAll(HTML_IMAGE)) push(m[1]!);
  return out;
}

// Self-hosted instances serve attachments from their own origin (`instanceOrigin`).
const GITHUB_USER_CONTENT_HOSTS: readonly string[] = [
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'raw.githubusercontent.com',
  'github.com', // /user-attachments/assets/… and /<owner>/<repo>/assets/…
  'objects.githubusercontent.com',
];

export interface ImageUrlPolicy {
  /** e.g. `https://git.acme.com`. */
  instanceOrigin?: string;
  provider: string;
}

/** https only; relative URLs are rejected since their base would be a guess. */
export function isAllowedImageUrl(raw: string, policy: ImageUrlPolicy): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (policy.instanceOrigin) {
    try {
      if (url.origin === new URL(policy.instanceOrigin).origin) return true;
    } catch {
      /* a misconfigured origin must not allow the URL */
    }
  }
  return policy.provider === 'github' && GITHUB_USER_CONTENT_HOSTS.includes(url.hostname);
}

/** SVG is excluded: it can carry scripts. */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface FetchedImage {
  url: string;
  mimeType: string;
  /** base64, as pi's `ImageContent.data`. */
  data: string;
}

export interface FetchImagesOptions {
  maxImages?: number;
  /** Per image. */
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

/** Each image fails independently; images are background and never fail the review. */
export async function fetchPrImages(
  urls: readonly string[],
  policy: ImageUrlPolicy,
  opts: FetchImagesOptions = {},
): Promise<FetchedImage[]> {
  const maxImages = opts.maxImages ?? 4;
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  const doFetch = opts.fetchImpl ?? fetch;
  const out: FetchedImage[] = [];
  for (const url of urls) {
    if (out.length >= maxImages) break;
    if (!isAllowedImageUrl(url, policy)) continue;
    try {
      const res = await doFetch(url, { redirect: 'error' }); // a redirect could leave the allowlist
      if (!res.ok) continue;
      const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!ALLOWED_MIME.has(mimeType)) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > maxBytes) continue;
      out.push({ url, mimeType, data: buf.toString('base64') });
    } catch {
      /* skip this image */
    }
  }
  return out;
}
