import type { Severity } from '@reviewbot/findings';

export type SecurityReportChannel = 'private' | 'security-issue' | 'public-pr-comment';

export interface SecurityFinding {
  id: string;
  title: string;
  severity: Severity;
  category: 'sast' | 'dependency' | 'secret' | 'logic';
  /** For public channels; no exploit details. */
  publicSummary: string;
  /** Disclosed only on private channels. */
  exploitDetails: string;
  locationPermalink: string;
}
