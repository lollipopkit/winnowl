import {
  languageInstruction,
  runAgentInvocation,
  Type,
  type AgentBudget,
  type AgentTool,
  type Model,
  type Static,
  type StreamFn,
} from '@reviewbot/agent-pi';
import type { Severity } from '@reviewbot/findings';
import type { SecurityFinding } from './types.js';

const FINDINGS_SCHEMA = Type.Object({
  findings: Type.Array(
    Type.Object({
      title: Type.String(),
      severity: Type.String(),
      category: Type.String(),
      publicSummary: Type.String(),
      exploitDetails: Type.String(),
      locationPermalink: Type.String(),
    }),
  ),
});

const SEVERITIES = new Set<Severity>(['critical', 'high', 'medium', 'low', 'info']);
const CATEGORIES = new Set(['sast', 'dependency', 'secret', 'logic']);

export interface SecurityScanDeps {
  model: Model<string>;
  streamFn: StreamFn;
  /** Read-only full-repo tools. */
  readTools?: AgentTool[];
  budget?: AgentBudget;
  newId: () => string;
  /** Language for title/publicSummary/exploitDetails; English when omitted. */
  language?: string;
}

/** Full-repo (not diff-centred) security scan; destructive exploits are never run automatically. */
export async function runSecurityScan(
  input: { repoContext: string; scannerEvidence?: string },
  deps: SecurityScanDeps,
): Promise<SecurityFinding[]> {
  // Scanner hits are leads only: the agent must verify each in code, since scanners have many false positives.
  const evidence = input.scannerEvidence?.trim()
    ? `\n\n${input.scannerEvidence}\n\nTreat the above as leads, not conclusions: confirm each by reading the code, and do not report a hit you could not confirm.`
    : '';
  const result = await runAgentInvocation({
    systemPrompt:
      'You are a security analyst scanning an entire repository. Map, then focus on SAST/dependency/secret risks. Only report findings you can support. Never run destructive exploits. Separate a safe public summary from sensitive exploit details.' +
      languageInstruction(deps.language, 'finding titles, public summaries and exploit details'),
    task: `Repository context:\n${input.repoContext}${evidence}\n\nCall submit_security_findings.`,
    model: deps.model,
    streamFn: deps.streamFn,
    readTools: deps.readTools ?? [],
    finalization: {
      name: 'submit_security_findings',
      description: 'Submit confirmed security findings.',
      label: 'Submit security findings',
      schema: FINDINGS_SCHEMA,
    },
    budget: deps.budget ?? { maxTurns: 12, maxToolCalls: 60 },
  });

  if (result.status !== 'complete' || !result.finalization) return [];
  const out = result.finalization as Static<typeof FINDINGS_SCHEMA>;
  return out.findings.map((f) => ({
    id: deps.newId(),
    title: f.title,
    severity: (SEVERITIES.has(f.severity as Severity) ? f.severity : 'medium') as Severity,
    category: (CATEGORIES.has(f.category) ? f.category : 'logic') as SecurityFinding['category'],
    publicSummary: f.publicSummary,
    exploitDetails: f.exploitDetails,
    locationPermalink: f.locationPermalink,
  }));
}
