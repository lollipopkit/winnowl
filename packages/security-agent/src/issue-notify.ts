import { createHash } from 'node:crypto';
import type { Severity } from '@reviewbot/findings';
import { renderForChannel, type DisclosureLabels } from './disclosure.js';
import type { SecurityNotifier } from './email-notify.js';
import type { SecurityFinding } from './types.js';

/**
 * Security-issue channel. Defaults are conservative: `public` disclosure (issues may be world-readable,
 * so no exploit details) and a `high` severity floor. Callers dedupe via `wasReported`/`onReported`.
 */

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** Stable across scans (unlike `SecurityFinding.id`): category|title|location. */
export function securityFindingFingerprint(finding: SecurityFinding): string {
  const basis = `${finding.category}|${finding.title.trim().toLowerCase()}|${finding.locationPermalink.trim()}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

export interface IssueNotifierDeps {
  /** `fingerprint` must be part of the idempotency key, or a second finding's issue would be swallowed. */
  createIssue: (input: {
    fingerprint: string;
    title: string;
    body: string;
    labels: string[];
  }) => Promise<void>;
  /** Omitted = no dedupe (an issue every scan). */
  wasReported?: (fingerprint: string) => Promise<boolean>;
  onReported?: (fingerprint: string, finding: SecurityFinding) => Promise<void>;
  /** Localised labels; English when omitted. */
  labels?: DisclosureLabels;
  issueLabels?: string[];
  minSeverity?: Severity;
  /** `full` includes exploit details: only for repositories confirmed private. */
  disclosure?: 'public' | 'full';
}

export function createIssueSecurityNotifier(deps: IssueNotifierDeps): SecurityNotifier {
  const min = SEVERITY_RANK[deps.minSeverity ?? 'high'];
  const labels = deps.issueLabels ?? ['security'];
  return {
    async notify(finding: SecurityFinding): Promise<void> {
      if (SEVERITY_RANK[finding.severity] < min) return;
      const fingerprint = securityFindingFingerprint(finding);
      if (await deps.wasReported?.(fingerprint)) return;

      const channel = deps.disclosure === 'full' ? 'security-issue' : 'public-pr-comment';
      const rendered = renderForChannel(finding, channel, deps.labels);
      await deps.createIssue({
        fingerprint,
        title: `[security] ${finding.title}`,
        body: `${rendered.body}\n\n<!-- winnowl:security:${fingerprint} -->`,
        labels,
      });
      await deps.onReported?.(fingerprint, finding);
    },
  };
}

/** A failing channel does not affect the others. */
export function combineNotifiers(...notifiers: (SecurityNotifier | undefined)[]): SecurityNotifier | undefined {
  const list = notifiers.filter((n): n is SecurityNotifier => n !== undefined);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return {
    async notify(finding: SecurityFinding): Promise<void> {
      const results = await Promise.allSettled(list.map((n) => n.notify(finding)));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length === list.length) {
        throw new Error(`全部安全通知渠道投递失败:${failed.map((f) => String((f as PromiseRejectedResult).reason)).join('; ')}`);
      }
    },
  };
}
