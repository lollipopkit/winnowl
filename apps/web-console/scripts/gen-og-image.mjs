// Generates static/og-image.png (1200x630). Needs local Chrome, so it is not part of the build;
// rerun manually: `node scripts/gen-og-image.mjs`. Colors are copied from the `.dark` tokens in
// src/app.css and must be updated by hand when the theme changes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markSvg } from './brand-paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const out = resolve(repo, 'static/og-image.png');
const font = resolve(repo, 'node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2');

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Keep in sync with src/lib/seo.ts and the landing page h1.
const HEADLINE = 'Finds subtle bugs before they ship';
const SUBLINE = 'AI code review for GitHub, GitLab and Forgejo';
const DROPPED = ['Possible nil dereference in cache warmup', 'Unused parameter in adaptor factory', 'Prefer early return here'];
const KEPT = 'New dependency carries a known advisory with no patched release';

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: 'Figtree';
    src: url('file://${font}') format('woff2-variations');
    font-weight: 300 900;
  }
  :root {
    --background: oklch(0.147 0.004 49.3);   /* .dark --background */
    --foreground: oklch(0.986 0.002 67.8);   /* .dark --foreground */
    --card: oklch(0.214 0.009 43.1);         /* .dark --card */
    --muted-foreground: oklch(0.714 0.014 41.2); /* .dark --muted-foreground */
    --border: oklch(1 0 0 / 10%);            /* .dark --border */
    --chart-1: oklch(0.823 0.12 346.018);    /* .dark --chart-1 */
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; display: grid;
    grid-template-columns: 1.05fr 1fr; align-items: center; gap: 56px;
    padding: 72px; background: var(--background); color: var(--foreground);
    font-family: 'Figtree', system-ui, sans-serif; -webkit-font-smoothing: antialiased;
  }
  .brand { display: flex; align-items: center; gap: 13px; margin-bottom: 28px; }
  /* 深底上用 chart-1 那档浅粉,不用 primary:#c6005c 压在近黑上对比度不够,鸟会糊掉 */
  .mark { color: var(--chart-1); display: flex; }
  .mark svg { display: block; height: 34px; width: auto; }
  .name { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; }
  h1 { font-size: 68px; font-weight: 600; line-height: 1.05; letter-spacing: -0.03em; }
  .sub { margin-top: 24px; font-size: 25px; line-height: 1.4; color: var(--muted-foreground); }

  /* 签名元素:候选被划掉,穿过一道筛,只剩发出去的那一条 */
  .sieve { background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 32px; }
  .cap { font-size: 15px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted-foreground); }
  .dropped { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 10px; }
  .dropped li {
    font-size: 19px; color: color-mix(in oklch, var(--muted-foreground) 60%, transparent);
    text-decoration: line-through; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .rule { display: flex; align-items: center; gap: 14px; margin: 26px 0; }
  .rule span:first-child, .rule span:last-child { flex: 1; border-top: 1px dashed var(--border); }
  .rule .word { font-size: 13px; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: var(--muted-foreground); }
  .kept { margin-top: 16px; background: var(--background); border: 1px solid var(--border); border-radius: 14px; padding: 18px; display: flex; gap: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--chart-1); margin-top: 8px; flex: none; }
  .kept p { font-size: 20px; line-height: 1.35; }
</style>
</head>
<body>
  <div>
    <div class="brand"><span class="mark">${markSvg('currentColor')}</span><span class="name">Winnowl</span></div>
    <h1>${HEADLINE}</h1>
    <p class="sub">${SUBLINE}</p>
  </div>
  <div class="sieve">
    <p class="cap">Candidates</p>
    <ul class="dropped">${DROPPED.map((d) => `<li>${d}</li>`).join('')}</ul>
    <div class="rule"><span></span><span class="word">winnow</span><span></span></div>
    <p class="cap">Posted to the pull request</p>
    <div class="kept"><span class="dot"></span><p>${KEPT}</p></div>
  </div>
</body>
</html>
`;

const tmp = mkdtempSync(resolve(tmpdir(), 'winnowl-og-'));
const page = resolve(tmp, 'og.html');
writeFileSync(page, html, 'utf8');

execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    // Allow loading the font over file://.
    '--allow-file-access-from-files',
    '--force-device-scale-factor=1',
    '--window-size=1200,630',
    `--screenshot=${out}`,
    `file://${page}`,
  ],
  { stdio: 'inherit' },
);

console.log(`已生成 ${out}`);
