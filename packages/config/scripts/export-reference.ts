/**
 * Flattens the `.winnowl.yaml` JSON Schema into the config reference table rendered by the console docs.
 *
 *   pnpm docs:config          # write/update
 *   pnpm docs:config:check    # CI: exit 1 when out of date
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfigJsonSchema } from '../src/json-schema.js';

interface ConfigField {
  /** Dotted path, e.g. `reviews.auto.enabled`. */
  path: string;
  /** Enum values are joined with `|`. */
  type: string;
  /** Default as YAML; omitted when there is none. */
  default?: string;
  description?: string;
}

type Node = Record<string, unknown>;

function itemType(items: unknown): string {
  if (!items || typeof items !== 'object') return 'unknown';
  const node = items as Node;
  if (Array.isArray(node.enum)) return `(${node.enum.join(' | ')})[]`;
  if (node.type === 'object') return 'object[]';
  return `${String(node.type ?? 'unknown')}[]`;
}

function displayType(node: Node): string {
  if (Array.isArray(node.enum)) return node.enum.join(' | ');
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.type === 'array') return itemType(node.items);
  return String(node.type ?? 'unknown');
}

/** Empty arrays are written out so they do not read as "no default". */
function displayDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.length === 0 ? '[]' : JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function walk(node: Node, prefix: string, out: ConfigField[]): void {
  const properties = node.properties as Record<string, Node> | undefined;
  if (!properties) return;
  for (const [key, child] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // A described object node gets a group row; otherwise just descend.
    const isObject = child.type === 'object' && child.properties;
    if (isObject) {
      if (typeof child.description === 'string') {
        out.push({ path, type: 'object', ...(child.description ? { description: child.description } : {}) });
      }
      walk(child, path, out);
      continue;
    }
    const field: ConfigField = { path, type: displayType(child) };
    const def = displayDefault(child.default);
    if (def !== undefined) field.default = def;
    if (typeof child.description === 'string') field.description = child.description;
    out.push(field);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../../../apps/web-console/src/lib/generated/config-reference.json');

const schema = buildConfigJsonSchema() as Node;
const root = ((schema.definitions as Node | undefined)?.WinnowlConfig ?? schema) as Node;
const fields: ConfigField[] = [];
walk(root, '', fields);

const serialized = `${JSON.stringify({ fields }, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(outPath)) {
    console.error(`缺少 ${outPath},请运行 pnpm docs:config`);
    process.exit(1);
  }
  if (readFileSync(outPath, 'utf8') !== serialized) {
    console.error('配置参考已过期(schema 改了但文档没重生成),请运行 pnpm docs:config');
    process.exit(1);
  }
  console.log(`配置参考是最新的(${fields.length} 个字段)`);
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized, 'utf8');
  console.log(`已写入 ${outPath}(${fields.length} 个字段)`);
}
