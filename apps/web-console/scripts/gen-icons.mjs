// Generates all icons in static/ from src/lib/brand.ts. Needs local Chrome, so it is not part of
// the build; outputs are committed. Rerun manually: `node scripts/gen-icons.mjs`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWL_H, OWL_PATHS, OWL_W, OWL_X, OWL_Y, PRIMARY, PRIMARY_ON_DARK, markSvg } from './brand-paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const staticDir = resolve(repo, 'static');
const brandDir = resolve(staticDir, 'brand');

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** DARK_BG is the `.dark` --background. */
const LIGHT_BG = '#ffffff';
const DARK_BG = '#0c0a09';

/** Rounded tile icon. The inset is required: OS corner masks would clip an edge-to-edge mark. */
function tileSvg({ bg = LIGHT_BG, fg = PRIMARY, size = 32, inset = size * 0.14, adaptive = false } = {}) {
  const s = (size - inset * 2) / OWL_H;
  const tx = (size - OWL_W * s) / 2;
  // The favicon is a standalone document without the app's `.dark` class, so it is the one
  // place that uses a prefers-color-scheme media query.
  const style = adaptive
    ? `<style>.bg{fill:${LIGHT_BG}}.fg{fill:${PRIMARY}}` +
      `@media(prefers-color-scheme:dark){.bg{fill:${DARK_BG}}.fg{fill:${PRIMARY_ON_DARK}}}</style>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${style}
<rect${adaptive ? ' class="bg"' : ''} width="${size}" height="${size}" rx="${(size * 0.234).toFixed(3)}"${adaptive ? '' : ` fill="${bg}"`}/>
<g transform="translate(${tx.toFixed(4)} ${inset.toFixed(4)}) scale(${s.toFixed(8)}) translate(${-OWL_X} ${-OWL_Y})"${adaptive ? ' class="fg"' : ` fill="${fg}"`}>${OWL_PATHS}</g>
</svg>\n`;
}

mkdirSync(brandDir, { recursive: true });

const svgs = {
  [resolve(staticDir, 'favicon.svg')]: tileSvg({ adaptive: true }),
  [resolve(brandDir, 'icon-light.svg')]: tileSvg({ bg: LIGHT_BG }),
  [resolve(brandDir, 'icon-dark.svg')]: tileSvg({ bg: DARK_BG, fg: PRIMARY_ON_DARK }),
  [resolve(brandDir, 'mark.svg')]: markSvg('currentColor'),
  [resolve(brandDir, 'mark-primary.svg')]: markSvg(PRIMARY),
  [resolve(brandDir, 'mark-primary-on-dark.svg')]: markSvg(PRIMARY_ON_DARK),
  [resolve(brandDir, 'mark-black.svg')]: markSvg('#000000'),
  [resolve(brandDir, 'mark-white.svg')]: markSvg('#ffffff'),
};
for (const [p, c] of Object.entries(svgs)) writeFileSync(p, c);

// Render each size separately; downscaling a large PNG blurs the 16px icon.
const scratch = mkdtempSync(resolve(tmpdir(), 'winnowl-icons-'));

function png(svg, out, size, transparent) {
  const page = resolve(scratch, `${size}.html`);
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}
svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      ...(transparent ? ['--default-background-color=00000000'] : []),
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      `file://${page}`,
    ],
    { stdio: 'pipe' },
  );
}

// PNGs cannot follow the system theme; iOS and PWA icons use the light tile.
const light = tileSvg({ size: 512, bg: LIGHT_BG, fg: PRIMARY });
const dark = tileSvg({ size: 512, bg: DARK_BG, fg: PRIMARY_ON_DARK });
for (const s of [16, 32, 48]) png(light, resolve(brandDir, `favicon-${s}.png`), s, false);
for (const s of [16, 32, 48]) png(dark, resolve(brandDir, `favicon-${s}-dark.png`), s, false);
png(light, resolve(staticDir, 'apple-touch-icon.png'), 180, false);
png(light, resolve(staticDir, 'icon-192.png'), 192, false);
png(light, resolve(staticDir, 'icon-512.png'), 512, false);
png(light, resolve(brandDir, 'icon-light-1024.png'), 1024, false);
png(dark, resolve(brandDir, 'icon-dark-1024.png'), 1024, false);

// Monochrome tiles.
png(tileSvg({ size: 512, bg: '#000000', fg: '#ffffff' }), resolve(brandDir, 'icon-black.png'), 512, false);
png(tileSvg({ size: 512, bg: '#ffffff', fg: '#000000' }), resolve(brandDir, 'icon-white.png'), 512, false);

// Transparent marks without a tile.
png(markSvg('#000000'), resolve(brandDir, 'mark-black.png'), 512, true);
png(markSvg('#ffffff'), resolve(brandDir, 'mark-white.png'), 512, true);
png(markSvg(PRIMARY), resolve(brandDir, 'mark-primary.png'), 512, true);

rmSync(scratch, { recursive: true, force: true });

console.log(`已生成图标 → ${staticDir}(方块 + 单色 + 无底符号)`);
