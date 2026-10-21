export type { Role, Permission } from './roles.js';
export { ROLE_PERMISSIONS, hasPermission, isAdminRole } from './roles.js';

export type { ApiScope } from './scopes.js';
export { tokenHasScope, scopesForRole, redactForFrontend, PROVIDER_TOKEN_RETURNED_TO_FRONTEND } from './scopes.js';

export type { RateLimitState, RateLimitOptions, RateLimitResult } from './ratelimit.js';
export { checkRateLimit } from './ratelimit.js';
