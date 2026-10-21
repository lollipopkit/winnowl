export type { SecurityFinding, SecurityReportChannel } from './types.js';

export { renderForChannel, requiresElevatedAccess, AUTO_RUNS_DESTRUCTIVE_EXPLOIT } from './disclosure.js';
export type { DisclosureResult, DisclosureLabels } from './disclosure.js';

export { runSecurityScan } from './workflow.js';
export type { SecurityScanDeps } from './workflow.js';

export { createEmailSecurityNotifier } from './email-notify.js';
export type { EmailNotifierConfig, SecurityNotifier } from './email-notify.js';

export { createIssueSecurityNotifier, combineNotifiers, securityFindingFingerprint } from './issue-notify.js';
export type { IssueNotifierDeps } from './issue-notify.js';

export {
  detectDependencyManifests,
  parseNpmAudit,
  parseOsvScanner,
  renderDependencyEvidence,
} from './dep-audit.js';
export type { DependencyEcosystem, DetectedManifest, DependencyVulnerability, DependencyVulnerabilityGroup } from './dep-audit.js';
export { applicableFix, compareVersions, groupVulnerabilities } from './dep-audit.js';

export { scanDependencyVulnerabilities, SCANNER_EGRESS_HOSTS } from './dep-scan.js';
export type { OsvScanOptions } from './dep-scan.js';

export { parseSemgrep, parseGitleaks, renderStaticEvidence, scanStaticRisks } from './static-scan.js';
export type { StaticFinding, StaticScanner, StaticScanOptions, StaticScanResult } from './static-scan.js';
