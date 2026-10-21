import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { ConfigValidationError } from './errors.js';
import { configDigest } from './digest.js';
import { repositoryConfigSchema, type EffectiveRepositoryConfig } from './schema.js';

/**
 * Higher number = higher precedence. Ordinary fields are overridden by precedence; ordered safety
 * fields (`LATTICE_FIELDS`) take the strictest explicit value, so a repo can tighten but never loosen.
 */
export const CONFIG_LAYER_PRIORITY = {
  conversation: 10,
  'path-ast': 20,
  // The organization's defaults: every repository's starting point, overridden by its own settings.
  organization: 22,
  // The console panel ranks below `.winnowl.yaml` on purpose: code-reviewed config wins on conflicts.
  'repository-db': 25,
  'repository-file': 30,
  'global-safety': 70,
} as const;

export type ConfigLayerSource = keyof typeof CONFIG_LAYER_PRIORITY;

export interface ConfigLayer {
  source: ConfigLayerSource;
  /** Raw, unvalidated, possibly partial. */
  value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `order` runs from strictest to loosest; the strictest explicitly set value wins. */
const LATTICE_FIELDS: { path: string[]; order: (string | boolean)[] }[] = [
  { path: ['sandbox', 'network', 'mode'], order: ['none', 'package-registry-only', 'allowlist', 'full'] },
  { path: ['plugins', 'exa', 'enabled'], order: [false, true] },
  { path: ['plugins', 'context7', 'enabled'], order: [false, true] },
  { path: ['plugins', 'registry', 'enabled'], order: [false, true] },
];

function getPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i]!;
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

function applyLatticeConstraints(layers: ConfigLayer[], merged: Record<string, unknown>): void {
  for (const field of LATTICE_FIELDS) {
    let strictest: string | boolean | undefined;
    let strictestRank = Number.POSITIVE_INFINITY;
    for (const layer of layers) {
      const raw = getPath(layer.value, field.path);
      if (typeof raw !== 'string' && typeof raw !== 'boolean') continue;
      const rank = field.order.indexOf(raw);
      if (rank < 0) continue; // invalid values are reported by schema validation
      if (rank < strictestRank) {
        strictestRank = rank;
        strictest = raw;
      }
    }
    if (strictest !== undefined) setPath(merged, field.path, strictest);
  }
}

/** Objects merge recursively; arrays and scalars are replaced wholesale. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      out[key] = key in out ? deepMerge(out[key], value) : value;
    }
    return out;
  }
  return override;
}

export function parseRepositoryConfig(input: unknown): EffectiveRepositoryConfig {
  try {
    return repositoryConfigSchema.parse(input ?? {});
  } catch (error) {
    if (error instanceof ZodError) {
      throw ConfigValidationError.fromZodError(error);
    }
    throw error;
  }
}

export function loadConfigYaml(text: string): unknown {
  return parseYaml(text) ?? {};
}

export interface ResolvedConfig {
  config: EffectiveRepositoryConfig;
  digest: string;
}

export function resolveConfig(layers: ConfigLayer[]): ResolvedConfig {
  const ordered = [...layers].sort(
    (a, b) => CONFIG_LAYER_PRIORITY[a.source] - CONFIG_LAYER_PRIORITY[b.source],
  );
  let merged: unknown = {};
  for (const layer of ordered) {
    merged = deepMerge(merged, layer.value ?? {});
  }
  if (isPlainObject(merged)) applyLatticeConstraints(layers, merged);
  const config = parseRepositoryConfig(merged);
  return { config, digest: configDigest(config) };
}

export function defaultConfig(): EffectiveRepositoryConfig {
  return repositoryConfigSchema.parse({});
}

/** Undefined when the whole subtree equals the default. */
function pruneAgainst(value: unknown, dflt: unknown): unknown {
  if (isPlainObject(value) && isPlainObject(dflt)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const kept = pruneAgainst(v, dflt[key]);
      if (kept !== undefined) out[key] = kept;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  // Arrays and scalars compare whole, matching deepMerge's replacement semantics.
  return JSON.stringify(value) === JSON.stringify(dflt) ? undefined : value;
}

/**
 * Drops keys equal to the defaults before storage, so saved settings do not freeze today's defaults. `base` is
 * what the stored layer sits on: schema defaults, or for a repository panel the organization's defaults too.
 * A key that must not drift with defaults needs no schema default instead.
 */
export function pruneDefaults(value: unknown, base: EffectiveRepositoryConfig = defaultConfig()): Record<string, unknown> {
  const pruned = pruneAgainst(value ?? {}, base);
  return isPlainObject(pruned) ? pruned : {};
}

/** Lenient read of `reviews.auto` for the review gate; null on invalid YAML or a missing/non-object section. */
export function readAutoFragmentFromYaml(text: string): Record<string, unknown> | null {
  try {
    const doc = parseYaml(text) as unknown;
    const auto = (doc as { reviews?: { auto?: unknown } } | null)?.reviews?.auto;
    return auto && typeof auto === 'object' && !Array.isArray(auto) ? (auto as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
