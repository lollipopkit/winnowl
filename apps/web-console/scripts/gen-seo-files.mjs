// Generates robots.txt and sitemap.xml at build time because their absolute URLs depend on the
// deployment's VITE_SITE_URL.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(here, '../static');

const siteUrl = (process.env.VITE_SITE_URL ?? 'https://winnowl.lollipopkit.com').replace(/\/+$/, '');

// Only prerendered paths; SPA routes all serve the same empty shell.
const PRERENDERED = ['/'];

// App routes only serve an empty shell to crawlers; this is not access control.
const DISALLOW = ['/v1/', '/webhooks/', '/account', '/audit', '/findings', '/repositories', '/reviews', '/team'];

const robots = [
  'User-agent: *',
  // Longer Disallow prefixes take precedence over this Allow.
  'Allow: /',
  ...DISALLOW.map((p) => `Disallow: ${p}`),
  '',
  `Sitemap: ${siteUrl}/sitemap.xml`,
  '',
].join('\n');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PRERENDERED.map((p) => `  <url><loc>${siteUrl}${p}</loc></url>`).join('\n')}
</urlset>
`;

mkdirSync(staticDir, { recursive: true });
writeFileSync(resolve(staticDir, 'robots.txt'), robots, 'utf8');
writeFileSync(resolve(staticDir, 'sitemap.xml'), sitemap, 'utf8');
console.log(`已生成 robots.txt / sitemap.xml(站点地址 ${siteUrl})`);
