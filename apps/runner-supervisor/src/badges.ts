/**
 * Status badges in bot output. Locale-independent, so kept in code (same rule as `BADGE` /
 * `SEVERITY_EMOJI` in `packages/publisher/src/render.ts`) rather than duplicated in every dictionary.
 */
export const BADGE = {
  /** Re-check verdicts (uphold / retract / downgrade) and their summary. */
  reverified: '🔁',
  /** Sandbox validation heading. */
  sandbox: '🧪',
  /** Preexisting finding confirmed fixed by gate reconciliation. */
  resolved: '✅',
} as const;
