/**
 * Writes the `.winnowl.yaml` JSON Schema to config-schema/winnowl.schema.json.
 *
 *   pnpm config:schema          # write/update
 *   pnpm config:schema:check    # CI: exit 1 when out of date
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfigJsonSchema } from '../src/json-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../../../config-schema/winnowl.schema.json');

const schema = buildConfigJsonSchema();
const serialized = `${JSON.stringify(schema, null, 2)}\n`;

const checkMode = process.argv.includes('--check');

if (checkMode) {
  if (!existsSync(outPath)) {
    console.error(`缺少 ${outPath},请运行 pnpm config:schema`);
    process.exit(1);
  }
  const current = readFileSync(outPath, 'utf8');
  if (current !== serialized) {
    console.error('config-schema 已过期,请运行 pnpm config:schema 重新生成');
    process.exit(1);
  }
  console.log('config-schema 是最新的');
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized, 'utf8');
  console.log(`已写入 ${outPath}`);
}
