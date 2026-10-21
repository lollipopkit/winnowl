import { platformSetting } from '@reviewbot/config';
import { botName } from '@reviewbot/domain';
import { botMessages } from '../locale.js';
import { uuidv7 } from '@reviewbot/ids';
import { CodePlaneReader, loadEffectiveConfig } from '@reviewbot/review-runtime';
import { createSecurityScanHandler } from '../security-scan.js';
import {
  createEmailSecurityNotifier,
  createIssueSecurityNotifier,
  scanDependencyVulnerabilities,
  scanStaticRisks,
} from '@reviewbot/security-agent';
import { withWorkspaceScanner } from '../workspace-scan.js';
import { assertMailFrom } from '@reviewbot/notifications';
import type { JobHandler } from '../supervisor.js';
import { repositoryRefFromRow } from '../repository-ref.js';
import { notWired, type RunnerRuntime } from './runtime.js';

/** security_scan: scheduled whole-repository scans. */
export function securityHandlers(rt: RunnerRuntime): Record<string, JobHandler> {
  const {
    db,
    logger,
    platformModels,
    buildProviderForRepository,
    openCodePlane,
    workspaceScanDeps,
    repositoryReadToken,
  } = rt;
  if (process.env.SECURITY_MAIL_FROM) assertMailFrom(process.env.SECURITY_MAIL_FROM, 'SECURITY_MAIL_FROM');
  return {
    security_scan: createSecurityScanHandler({
      newId: () => uuidv7(),
      // Private channel: email when SMTP is configured, otherwise audit_events only.
      ...(process.env.SECURITY_SMTP_HOST &&
      process.env.SECURITY_MAIL_FROM &&
      process.env.SECURITY_MAIL_TO
        ? {
            notifier: createEmailSecurityNotifier({
              host: process.env.SECURITY_SMTP_HOST,
              port: Number(process.env.SECURITY_SMTP_PORT ?? 587),
              secure: process.env.SECURITY_SMTP_SECURE === 'true',
              ...(process.env.SECURITY_SMTP_USER && process.env.SECURITY_SMTP_PASS
                ? {
                    auth: {
                      user: process.env.SECURITY_SMTP_USER,
                      pass: process.env.SECURITY_SMTP_PASS,
                    },
                  }
                : {}),
              from: process.env.SECURITY_MAIL_FROM,
              to: process.env.SECURITY_MAIL_TO.split(',').map((s) => s.trim()),
            }),
          }
        : {}),
      /**
       * Security issue channel, opt-in via `security.issue_channel`. Issues are visible to all collaborators
       * (to everyone on a public repo), so exploit details need `security.issue_disclosure` = full.
       * Deduplicated by fingerprint in audit_events; the provider idempotency key carries the same fingerprint.
       */
      buildNotifier: async (payload: { tenantId: string; repositoryId: string }) => {
        if ((await platformSetting(db, 'security.issue_channel')) !== '1') return undefined;
        const disclosure = await platformSetting(db, 'security.issue_disclosure');
        const minSeverity = await platformSetting(db, 'security.issue_min_severity');
        const provider = await buildProviderForRepository(payload.repositoryId);
        const repo = await db
          .selectFrom('repositories')
          .selectAll()
          .where('id', '=', payload.repositoryId)
          .executeTakeFirstOrThrow();
        const repoRef = repositoryRefFromRow(repo);
        const cfg = await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId);
        const l = botMessages(cfg.language).security;
        return createIssueSecurityNotifier({
          labels: {
            location: l.location(),
            exploitDetails: l.exploitDetails(),
            withheldNote: l.withheldNote(),
          },
          ...(disclosure === 'full' ? { disclosure: 'full' as const } : {}),
          minSeverity: minSeverity as 'critical' | 'high' | 'medium' | 'low' | 'info',
          issueLabels: [botName(), 'security'],
          wasReported: async (fingerprint) =>
            (await db
              .selectFrom('audit_events')
              .select('id')
              .where('tenant_id', '=', payload.tenantId)
              .where('action', '=', 'security.issue-created')
              .where('target', '=', `${payload.repositoryId}:${fingerprint}`)
              .executeTakeFirst()) !== undefined,
          onReported: async (fingerprint, finding) => {
            await db
              .insertInto('audit_events')
              .values({
                id: uuidv7(),
                tenant_id: payload.tenantId,
                actor: 'security-agent',
                action: 'security.issue-created',
                target: `${payload.repositoryId}:${fingerprint}`,
                detail: {
                  title: finding.title,
                  severity: finding.severity,
                  category: finding.category,
                } as unknown as Record<string, unknown>,
                created_at: new Date(),
              })
              .execute();
          },
          createIssue: async ({ fingerprint, title, body, labels }) => {
            await provider.issues.create(
              repoRef,
              { title, body: { markdown: body }, labels },
              // The fingerprint keeps distinct findings from collapsing into one idempotency key.
              { key: `security-issue:${payload.repositoryId}:${fingerprint}` },
            );
          },
        });
      },
      buildScanEnv: async (payload) => {
        const source = platformModels.source();
        if (!source)
          notWired('security_scan 的模型来源(设 LLM_PROVIDER/LLM_MODEL/LLM_BASE_URL/LLM_API_KEY)');
        const row = await db
          .selectFrom('repositories')
          .select(['installation_id', 'native_id', 'clone_url', 'namespace', 'name', 'default_branch'])
          .where('id', '=', payload.repositoryId)
          .executeTakeFirstOrThrow();
        // The default branch head, as a tree workspace (on a sandbox host with the agent pool).
        const plane = await openCodePlane({
          cloneUrl: row.clone_url,
          token: await repositoryReadToken(row.installation_id, row.native_id),
        });
        try {
          // Empty changed set: the agent reads the whole tree.
          const provider = new CodePlaneReader(plane).source;
          const cfg = await loadEffectiveConfig(db, payload.tenantId, payload.repositoryId);
          // semgrep, gitleaks and osv-scanner run where the workspace is, best-effort: a missing binary or failure
          // only logs. gitleaks hits keep rule and location only; the matched secret is dropped at parse time.
          const staticScan = (await platformSetting(db, 'security.static_scan')) !== '0';
          const evidence = await withWorkspaceScanner(workspaceScanDeps, plane, async ({ exec, dir, readFile: readReport }) => {
            const found: string[] = [];
            if (staticScan) {
              const stat = await scanStaticRisks({
                dir,
                exec,
                readReport,
                // Inside a sandbox the report goes to its own /tmp; locally to a fresh temp file.
                ...(plane.location.kind === 'agent' ? { reportPath: '/tmp/gitleaks.json' } : {}),
                ...(process.env.SEMGREP_CONFIG ? { semgrepConfig: process.env.SEMGREP_CONFIG } : {}),
                onScan: (info) =>
                  logger.info(
                    { repositoryId: payload.repositoryId, ...info },
                    info.failed ? '确定性扫描器不可用' : '确定性扫描完成',
                  ),
              }).catch((err) => {
                logger.warn({ err: (err as Error)?.message }, '静态扫描失败(不阻断)');
                return undefined;
              });
              if (stat) found.push(stat.evidence);
            }
            // security_scan has no change set, so dependencies are always scanned in full.
            const dep = await scanDependencyVulnerabilities({
              headDir: dir,
              changedFiles: [],
              scanAll: true,
              exec,
              onScan: (info) =>
                logger.info(
                  { repositoryId: payload.repositoryId, ...info },
                  '依赖扫描完成(security_scan)',
                ),
            }).catch((err) => {
              logger.warn({ err: (err as Error)?.message }, '依赖扫描失败(不阻断)');
              return undefined;
            });
            if (dep) found.push(dep.evidence);
            return found;
          }).catch((err) => {
            logger.warn({ err: (err as Error)?.message }, '扫描沙盒不可用(不阻断)');
            return [] as string[];
          });
        return {
          source: provider,
          model: source.model,
          streamFn: source.streamFn,
          repoContext: `Repository ${row.namespace}/${row.name} (default branch ${row.default_branch}). Use the read tools to explore the full repository for SAST/dependency/secret risks.`,
          ...(cfg.language !== undefined ? { language: cfg.language } : {}),
          ...(evidence.length > 0 ? { scannerEvidence: evidence.join('\n\n') } : {}),
          // This scan owns the workspace and removes it itself; a later run must not delete one still in use.
          dispose: () => plane.dispose(),
        };
        } catch (err) {
          await plane.dispose();
          throw err;
        }
      },
    }),
  };
}
