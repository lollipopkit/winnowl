// Copies the .winnowl.yaml JSON Schema into static/ on every build (not committed, so it cannot go stale).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../../config-schema/winnowl.schema.json');
const dest = resolve(here, '../static/winnowl.schema.json');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`已复制 schema → ${dest}`);
