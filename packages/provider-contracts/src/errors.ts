import type { ChangeRequestCapabilities } from '@reviewbot/domain';

export type CapabilityName = keyof ChangeRequestCapabilities;

export interface ProviderErrorOptions {
  retryable?: boolean;
  status?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(code: string, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

/** Unsupported capabilities must throw, never silently succeed. */
export class UnsupportedCapabilityError extends ProviderError {
  readonly capability: CapabilityName;

  constructor(capability: CapabilityName) {
    super('unsupported_capability', `Provider 不支持能力: ${capability}`, { retryable: false });
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
  }
}
