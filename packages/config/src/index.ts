export { repositoryConfigSchema } from './schema.js';
export type { EffectiveRepositoryConfig } from './schema.js';

export {
  CONFIG_LAYER_PRIORITY,
  deepMerge,
  parseRepositoryConfig,
  loadConfigYaml,
  resolveConfig,
  defaultConfig,
  pruneDefaults,
} from './merge.js';
export type { ConfigLayer, ConfigLayerSource, ResolvedConfig } from './merge.js';
export { readAutoFragmentFromYaml } from './merge.js';

export { canonicalize, canonicalJson, configDigest } from './digest.js';
export { buildConfigJsonSchema } from './json-schema.js';
export { ConfigValidationError } from './errors.js';

export {
  PLATFORM_SETTINGS,
  platformSettingDef,
  isValidPlatformSetting,
  resolvePlatformSetting,
  resolveAllPlatformSettings,
} from './platform.js';
export { readPlatformSettings, platformSetting } from './platform-store.js';
export { loadEffectiveConfig, loadOrganizationLayer, loadPanelLayer, persistEffectiveConfig } from './repository-store.js';

export { consoleBaseUrl, apiBaseUrl, githubWebhookUrl } from './public-urls.js';
