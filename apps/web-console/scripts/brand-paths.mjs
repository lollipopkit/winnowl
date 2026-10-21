// Reads brand paths from src/lib/brand.ts by regex so scripts run with plain `node` (no TS loader);
// a format mismatch throws.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(repo, 'src/lib/brand.ts'), 'utf8');

export const OWL_VIEWBOX = /OWL_VIEWBOX = '([^']+)'/.exec(src)?.[1];
export const OWL_PATHS = [...src.matchAll(/^ {2}("(?:[^"\\]|\\.)*"),$/gm)].map((m) => JSON.parse(m[1])).join('');

if (!OWL_VIEWBOX || !OWL_PATHS) throw new Error('brand.ts 里没读到 OWL_VIEWBOX / OWL_PATHS');

export const [OWL_X, OWL_Y, OWL_W, OWL_H] = OWL_VIEWBOX.split(' ').map(Number);

/** sRGB of theme --primary (oklch(0.525 0.223 3.958)); static assets cannot use CSS variables. */
export const PRIMARY = '#c6005c';

/** Theme --chart-1 for dark backgrounds: primary is only 3.4:1 on near-black, this is 11:1. */
export const PRIMARY_ON_DARK = '#fda5d5';

export const markSvg = (fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${OWL_VIEWBOX}" fill="${fill}">${OWL_PATHS}</svg>`;
