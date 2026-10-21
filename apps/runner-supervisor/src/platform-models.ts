import {
  resolveModelSourceFromEnv,
  withModelFailover,
  type ModelIdentity,
  type ModelTier,
  type ResolvedModelSource,
} from '@reviewbot/agent-pi';
import type { Db } from '@reviewbot/db';
import { activeModels, type RegisteredModel } from '@reviewbot/entitlement';

/**
 * Registry row → pi model identity. The metadata must travel with it: it sets context budget, modalities
 * and price, and review-in-sandbox only sees what is serialized.
 */
export function toModelIdentity(m: RegisteredModel): ModelIdentity {
  return {
    provider: m.provider,
    modelId: m.modelId,
    ...(m.metadata ? { metadata: m.metadata } : {}),
  };
}

/**
 * Models for non-review agents: the env model first, then enabled registry models as failover.
 * The registry is refreshed in the background because callers are synchronous; it rarely changes.
 */
export interface PlatformModels {
  source(tier?: ModelTier): ResolvedModelSource | null;
  refresh(): Promise<void>;
}

export function createPlatformModels(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<RegisteredModel[]> = () => activeModels(db),
): PlatformModels {
  let registry: ModelIdentity[] = [];
  return {
    async refresh() {
      registry = (await load()).map(toModelIdentity);
    },
    source(tier) {
      const primary = resolveModelSourceFromEnv(env, tier);
      if (!primary) return null;
      const rest = registry
        .filter((m) => m.modelId !== primary.model.id)
        .flatMap((m) => {
          try {
            const s = resolveModelSourceFromEnv(env, m);
            return s ? [s] : [];
          } catch {
            return []; // not allowlisted / delisted: one fewer fallback
          }
        });
      return withModelFailover([primary, ...rest]);
    },
  };
}
