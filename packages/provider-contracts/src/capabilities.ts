import type { ChangeRequestCapabilities } from '@reviewbot/domain';
import { CHANGE_REQUEST_CAPABILITY_KEYS } from '@reviewbot/domain';
import { UnsupportedCapabilityError, type CapabilityName } from './errors.js';

/** All-false baseline; adapters enable what their platform supports. */
export function noCapabilities(): ChangeRequestCapabilities {
  const caps = {} as Record<CapabilityName, boolean>;
  for (const key of CHANGE_REQUEST_CAPABILITY_KEYS) {
    caps[key] = false;
  }
  return caps as ChangeRequestCapabilities;
}

export function capabilities(overrides: Partial<ChangeRequestCapabilities>): ChangeRequestCapabilities {
  return { ...noCapabilities(), ...overrides };
}

export function requireCapability(
  caps: ChangeRequestCapabilities,
  name: CapabilityName,
): void {
  if (!caps[name]) {
    throw new UnsupportedCapabilityError(name);
  }
}
