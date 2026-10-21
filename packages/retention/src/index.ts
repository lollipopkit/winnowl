export type {
  RetentionClass,
  RetentionRule,
  RetentionPolicy,
  ErasureTask,
  ErasureAuditProof,
} from './types.js';

export { DEFAULT_RETENTION, resolveRetention, expiryAt, isExpired } from './policy.js';
export { planInstallationErasure, completeErasure } from './erasure.js';
