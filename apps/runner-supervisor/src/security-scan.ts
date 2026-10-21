import { buildSourceTools, type AgentBudget, type Model, type SourceProvider, type StreamFn } from '@reviewbot/agent-pi';
import { combineNotifiers, renderForChannel, requiresElevatedAccess, runSecurityScan, type SecurityNotifier } from '@reviewbot/security-agent';
import { botMessages } from './locale.js';
import type { JobHandler } from './supervisor.js';

export interface SecurityScanPayload {
  tenantId: string;
  repositoryId: string;
  trigger: 'manual' | 'scheduled';
}

/** Full-repo scan environment (production clone; test stubs). */
export interface SecurityScanEnv {
  source: SourceProvider;
  model: Model<string>;
  streamFn: StreamFn;
  budget?: AgentBudget;
  /** Repository context for the agent. */
  repoContext: string;
  /** Private report language; omitted means English. */
  language?: string;
  /**
   * Deterministic scanner hits (semgrep/gitleaks, secret contents stripped), given to the agent as leads;
   * only agent-verified ones become findings.
   */
  scannerEvidence?: string;
  /**
   * Releases this scan's clone; called by the handler when its round finishes (omitted = caller-managed).
   * Cleaning up the previous scan from the next one would delete dirs still in use by concurrent workers.
   */
  dispose?: () => Promise<void>;
}

export interface SecurityScanDeps {
  buildScanEnv: (payload: SecurityScanPayload) => Promise<SecurityScanEnv>;
  newId: () => string;
  /** Optional private notifier (Email/SMTP); otherwise only audit_events. */
  notifier?: SecurityNotifier;
  /**
   * Per-repo notifier (creating an issue needs that repo's provider). Used alongside `notifier`;
   * construction failure or undefined → `notifier` only.
   */
  buildNotifier?: (payload: SecurityScanPayload) => Promise<SecurityNotifier | undefined>;
}

/**
 * security_scan: full-repo SAST/dependency/secret scan delivered privately + audited. Destructive exploits
 * never run automatically. The private channel is `audit_events` (admin-only); exploit details never reach
 * public PR comments.
 */
export function createSecurityScanHandler(deps: SecurityScanDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as SecurityScanPayload;
    const env = await deps.buildScanEnv(payload);
    try {
      // A failing per-repo channel must not waste the scan: fall back to audit_events + static channel.
      const perRepoNotifier = deps.buildNotifier
        ? await deps.buildNotifier(payload).catch((err) => {
            log('security notifier 构造失败(降级)', { error: (err as Error).message });
            return undefined;
          })
        : undefined;
      const notifier = combineNotifiers(deps.notifier, perRepoNotifier);

      const findings = await runSecurityScan(
        { repoContext: env.repoContext, ...(env.scannerEvidence !== undefined ? { scannerEvidence: env.scannerEvidence } : {}) },
        {
          model: env.model,
          streamFn: env.streamFn,
          readTools: buildSourceTools(env.source),
          newId: deps.newId,
          ...(env.budget ? { budget: env.budget } : {}),
          ...(env.language !== undefined ? { language: env.language } : {}),
        },
      );

      const now = new Date();
      // Report labels localized by the scan's language (security-agent has no i18n of its own).
      const s = botMessages(env.language).security;
      const secLabels = { location: s.location(), exploitDetails: s.exploitDetails(), withheldNote: s.withheldNote() };
      const bySeverity: Record<string, number> = {};
      for (const f of findings) {
        bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
        // Full disclosure (with exploit details) goes to audit_events (admin-only) only.
        const disclosure = renderForChannel(f, 'private', secLabels);
        await db
          .insertInto('audit_events')
          .values({
            id: deps.newId(),
            tenant_id: payload.tenantId,
            actor: 'security-agent',
            action: 'security.finding',
            target: payload.repositoryId,
            detail: {
              findingId: f.id,
              title: f.title,
              severity: f.severity,
              category: f.category,
              body: disclosure.body,
              elevated: requiresElevatedAccess(f.severity),
              trigger: payload.trigger,
            } as unknown as Record<string, unknown>,
            created_at: now,
          })
          .execute();
        // Email delivery of the full report; failure does not block the audit record.
        if (notifier) {
          await notifier.notify(f).catch((err) => log('security notify failed', { findingId: f.id, error: (err as Error).message }));
        }
      }

      // Summary is recorded even with no findings, so the scan is observable.
      await db
        .insertInto('audit_events')
        .values({
          id: deps.newId(),
          tenant_id: payload.tenantId,
          actor: 'security-agent',
          action: 'security.scan',
          target: payload.repositoryId,
          detail: { count: findings.length, bySeverity, trigger: payload.trigger } as unknown as Record<string, unknown>,
          created_at: now,
        })
        .execute();

      log('security_scan completed', { repositoryId: payload.repositoryId, count: findings.length, trigger: payload.trigger });
    } finally {
      // This round releases its own clone: the next round cleaning up would delete a dir still being read,
      // and a missing read silently returns null (under-reporting).
      await env.dispose?.().catch((err) => log('security scan cleanup failed', { repositoryId: payload.repositoryId, error: (err as Error)?.message }));
    }
  };
}
