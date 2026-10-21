import type { AuthoritativeRule, AuthoritativeSourceKind } from './types.js';

/** Higher wins; org policy is highest (repos cannot relax it), README/docs lowest. */
export const SOURCE_PRIORITY: Record<AuthoritativeSourceKind, number> = {
  'org-policy': 90,
  'reviewbot-yaml': 80,
  'path-ast-instruction': 70,
  contributing: 40,
  'lint-build-config': 35,
  'approved-external-docs': 30,
  'readme-docs': 20,
};

export interface RawAuthoritativeRule {
  id?: string;
  instruction: string;
  source: AuthoritativeSourceKind;
  selector?: string;
}

/** Rules with source priority, highest first. */
export function collectAuthoritativeRules(raw: RawAuthoritativeRule[]): AuthoritativeRule[] {
  return raw
    .map((r, i) => ({
      id: r.id ?? `${r.source}:${i}`,
      instruction: r.instruction,
      source: r.source,
      priority: SOURCE_PRIORITY[r.source],
      ...(r.selector !== undefined ? { selector: r.selector } : {}),
    }))
    .sort((a, b) => b.priority - a.priority);
}
