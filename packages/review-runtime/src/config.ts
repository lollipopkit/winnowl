import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfigYaml, resolveConfig, type ConfigLayer, type EffectiveRepositoryConfig } from '@reviewbot/config';
import { resolveProfile, type ProfileSettings } from '@reviewbot/review-profile';

export interface LoadedRepoConfig {
  config: EffectiveRepositoryConfig;
  configDigest: string;
  profile: ProfileSettings;
  noiseBudget: { maxInlineComments: number; maxInlinePerFile: number; maxInlineNits: number };
  budget: { maxTurns: number; maxToolCalls: number };
  /** True when `.winnowl.yaml` exists; it then wins over the panel/DB config. */
  hasRepoFile: boolean;
  /** The `.winnowl.yaml` as written (its layer), stored so the config can be resolved without a clone. */
  fileSettings?: Record<string, unknown>;
}

/** Profiles carry no per-file inline limit. */
const DEFAULT_MAX_INLINE_PER_FILE = 3;

function finalizeLoadedConfig(
  resolved: { config: EffectiveRepositoryConfig; digest: string },
  hasRepoFile: boolean,
): LoadedRepoConfig {
  const profileName = resolved.config.reviews.profile;
  // Without explicit settings, `custom` falls back to balanced.
  const profile = resolveProfile(profileName);
  // Explicit max_inline_* wins over the profile; the schema leaves them without defaults so "unset" is detectable.
  const pub = resolved.config.reviews.publication;
  return {
    config: resolved.config,
    configDigest: resolved.digest,
    profile,
    noiseBudget: {
      maxInlineComments: pub.max_inline_comments ?? profile.maxInlineComments,
      maxInlinePerFile: pub.max_inline_per_file ?? DEFAULT_MAX_INLINE_PER_FILE,
      maxInlineNits: pub.max_inline_nitpicks ?? profile.maxInlineNits,
    },
    budget: { maxTurns: profile.exploreBudget.maxTurns, maxToolCalls: profile.exploreBudget.maxToolCalls },
    hasRepoFile,
  };
}

/** Config without a repo file. The mirrored `settings` column is display-only and is not a layer. */
export function loadedConfigFromLayers(layers: ConfigLayer[]): LoadedRepoConfig {
  return finalizeLoadedConfig(resolveConfig(layers), false);
}

export type ConfigFileReader = (name: string) => Promise<string | null>;

export async function loadRepoConfig(dir: string, extraLayers: ConfigLayer[] = []): Promise<LoadedRepoConfig> {
  return loadRepoConfigFromReader(async (name) => {
    try {
      return await readFile(join(dir, name), 'utf8');
    } catch {
      return null;
    }
  }, extraLayers);
}

/** `extraLayers` (e.g. tenant settings) merge by precedence; gate fields take the strictest value across layers. */
export async function loadRepoConfigFromReader(read: ConfigFileReader, extraLayers: ConfigLayer[] = []): Promise<LoadedRepoConfig> {
  let raw: unknown | null = null;
  let found = false;
  for (const name of ['.winnowl.yaml', '.winnowl.yml']) {
    const text = await read(name).catch(() => null);
    if (text != null) {
      raw = loadConfigYaml(text);
      found = true;
      break;
    }
  }
  const resolved = resolveConfig([...(raw == null ? [] : [{ source: 'repository-file', value: raw } as ConfigLayer]), ...extraLayers]);
  const loaded = finalizeLoadedConfig(resolved, found);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...loaded, fileSettings: raw as Record<string, unknown> } : loaded;
}
