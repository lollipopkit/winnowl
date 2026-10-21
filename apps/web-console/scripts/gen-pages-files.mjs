/**
 * Cloudflare Pages config, written into dist/ after `vite build`.
 *
 * - `_redirects`: SPA fallback. Only the client-side app routes (the `(app)` route group) are
 *   rewritten to the `/200.html` shell; a catch-all would also capture static assets and the prerendered
 *   marketing pages. Generated from the route directories so a new page cannot be forgotten.
 * - `_headers`: response headers nginx never set. The CSP itself is a <meta> emitted by SvelteKit
 *   (svelte.config.js); `frame-ancestors` only works as a header, so it is added here.
 *   App routes get `X-Robots-Tag: noindex` (crawlers would only see the empty SPA shell).
 *
 * Harmless for the nginx image (it ignores both files).
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const appRoutes = readdirSync(resolve(here, '../src/routes/(app)'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^[a-z0-9-]+$/.test(d.name))
  .map((d) => `/${d.name}`)
  .sort();

// Target `/200`, not `/200.html`: Pages normalises `.html` URLs with a 308, which would turn the
// rewrite into a visible redirect away from the deep link.
const redirects = appRoutes.flatMap((r) => [`${r} /200 200`, `${r}/* /200 200`]);
writeFileSync(resolve(dist, '_redirects'), `${redirects.join('\n')}\n`);

const security = [
  '/*',
  "  Content-Security-Policy: frame-ancestors 'none'",
  '  X-Frame-Options: DENY',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  '  Cross-Origin-Opener-Policy: same-origin',
];
const noindex = appRoutes.flatMap((r) => [
  r,
  `  X-Robots-Tag: noindex`,
  `${r}/*`,
  `  X-Robots-Tag: noindex`,
]);
writeFileSync(
  resolve(dist, '_headers'),
  `${[...security, ...noindex, '/200.html', '  X-Robots-Tag: noindex'].join('\n')}\n`,
);
console.log(`pages files: ${appRoutes.length} app routes`);
