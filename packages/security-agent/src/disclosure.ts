import type { Severity } from '@reviewbot/findings';
import type { SecurityFinding, SecurityReportChannel } from './types.js';

export interface DisclosureResult {
  body: string;
  /** Fields withheld for this channel. */
  withheld: string[];
}

/** Localised labels injected by the caller (this package has no i18n); English when omitted. */
export interface DisclosureLabels {
  location: string;
  exploitDetails: string;
  /** Without surrounding underscores. */
  withheldNote: string;
}

const DEFAULT_LABELS: DisclosureLabels = {
  location: 'Location',
  exploitDetails: 'Exploit details',
  withheldNote: 'Exploit details withheld from public channel; see private security report.',
};

/** Public channels never include exploit details; only private ones do. */
export function renderForChannel(
  finding: SecurityFinding,
  channel: SecurityReportChannel,
  labels: DisclosureLabels = DEFAULT_LABELS,
): DisclosureResult {
  if (channel === 'public-pr-comment') {
    return {
      body: [
        `**${finding.title}** (${finding.severity})`,
        finding.publicSummary,
        `${labels.location}: ${finding.locationPermalink}`,
        `_${labels.withheldNote}_`,
      ].join('\n'),
      withheld: ['exploit-details'],
    };
  }
  return {
    body: [
      `**${finding.title}** (${finding.severity})`,
      finding.publicSummary,
      '',
      `${labels.exploitDetails}: ${finding.exploitDetails}`,
      `${labels.location}: ${finding.locationPermalink}`,
    ].join('\n'),
    withheld: [],
  };
}

/** High-risk findings need stricter permissions and audit. */
export function requiresElevatedAccess(severity: Severity): boolean {
  return severity === 'critical' || severity === 'high';
}

export const AUTO_RUNS_DESTRUCTIVE_EXPLOIT = false;
