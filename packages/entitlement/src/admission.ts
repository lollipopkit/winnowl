/** Tenant admission for self-service installs. Pure, no DB access. */
export type ProvisionMode = 'allowlist' | 'open' | 'closed';

export interface AdmissionInput {
  mode: ProvisionMode;
  /** Case-insensitive logins; `*` admits everyone (same as open). */
  allowlist: readonly string[];
  accountLogin: string;
}

export type AdmissionDecision =
  | { action: 'provision'; reason: string }
  /** Record a pending installation for an operator to approve. */
  | { action: 'pending'; reason: string }
  /** Drop silently. */
  | { action: 'reject'; reason: string };

/** Unknown values fall back to allowlist so a typo never opens admission. */
export function parseProvisionMode(raw: string | undefined): ProvisionMode {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'open' || v === 'closed' || v === 'allowlist' ? v : 'allowlist';
}

export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * - `open`: provision everyone.
 * - `allowlist` (default): provision listed accounts; others become pending, so the installer gets feedback.
 * - `closed`: provision nobody, record nothing.
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const login = input.accountLogin.trim().toLowerCase();
  if (input.mode === 'closed') return { action: 'reject', reason: 'provisioning closed' };
  if (input.mode === 'open') return { action: 'provision', reason: 'open mode' };
  if (input.allowlist.includes('*')) return { action: 'provision', reason: 'allowlist wildcard' };
  if (input.allowlist.includes(login)) return { action: 'provision', reason: 'allowlisted' };
  return { action: 'pending', reason: `${input.accountLogin} 不在开通名单,待运维放行` };
}
