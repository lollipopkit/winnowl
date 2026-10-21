import type { Model, StreamFn } from '@reviewbot/agent-pi';
import type { Db } from '@reviewbot/db';
import type { IssueRef, RepositoryRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import {
  enrichIssue,
  planImplementation,
  type ImplementationPlan,
  type IssueEnrichment,
} from '@reviewbot/issue-intelligence';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { botMessages } from './locale.js';
import type { JobHandler } from './supervisor.js';

export interface IssueEnrichPayload {
  tenantId: string;
  repositoryId: string;
  issueNativeId: string;
  issueNumber: number;
  mode: 'enrich' | 'plan';
}

export interface IssueEnrichEnv {
  provider: SourceControlProvider;
  repo: RepositoryRef;
  model: Model<string>;
  streamFn: StreamFn;
  /** Output language; omitted means English. */
  language?: string;
}

export interface IssueEnrichDeps {
  buildEnv: (ctx: { payload: IssueEnrichPayload; db: Db }) => Promise<IssueEnrichEnv>;
}

/** issue_enrich: Issue enrichment or implementation plan. Labels/assignees are only suggested, never applied. */
export function createIssueEnrichHandler(deps: IssueEnrichDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as IssueEnrichPayload;
    const env = await deps.buildEnv({ payload, db });

    const issue = await env.provider.issues.get(env.repo, payload.issueNumber);
    const issueRef: IssueRef = {
      id: uuidv7(),
      repositoryId: payload.repositoryId,
      nativeId: payload.issueNativeId,
      number: payload.issueNumber,
    };
    // Ack with 👀 right away instead of waiting for the LLM; failure does not block.
    await env.provider.reactions?.addToIssue(issueRef, 'eyes').catch((err) =>
      log('issue acknowledge failed', { issueNumber: payload.issueNumber, error: (err as Error)?.message }),
    );
    const input = { title: issue.title, body: issue.body };

    if (payload.mode === 'plan') {
      const plan = await planImplementation(input, {
        model: env.model,
        streamFn: env.streamFn,
        ...(env.language !== undefined ? { language: env.language } : {}),
      });
      await env.provider.issues.comment(
        issueRef,
        { markdown: renderPlan(plan, env.language) },
        { key: `issue-plan:${payload.repositoryId}:${payload.issueNumber}` },
      );
      log('issue plan published', { issueNumber: payload.issueNumber, canStartCodingAgent: plan.canStartCodingAgent });
      return;
    }

    const enrichment = await enrichIssue(input, {
      model: env.model,
      streamFn: env.streamFn,
      ...(env.language !== undefined ? { language: env.language } : {}),
    });
    await env.provider.issues.comment(
      issueRef,
      { markdown: renderEnrichment(enrichment, env.language) },
      { key: `issue-enrich:${payload.repositoryId}:${payload.issueNumber}` },
    );
    log('issue enrichment published', { issueNumber: payload.issueNumber, feasibility: enrichment.feasibility });
  };
}

function bulletList(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

/** Localized fixed labels for the enrichment/plan templates; LLM-written text follows the `language` option. */
function renderEnrichment(e: IssueEnrichment, language?: string): string {
  const L = botMessages(language).enrich;
  const lines: string[] = [`### ${L.triage()}`, '', `**${L.feasibility()}**:${e.feasibility} ｜ **${L.risk()}**:${e.riskClassification}`];
  if (e.duplicateOf.length) lines.push('', `**${L.duplicates()}**:${e.duplicateOf.join(', ')}`);
  if (e.relatedIssues.length || e.relatedChangeRequests.length) {
    lines.push('', `**${L.related()}**:issues ${e.relatedIssues.join(', ') || '—'};CR ${e.relatedChangeRequests.join(', ') || '—'}`);
  }
  if (e.relatedCode.length) {
    lines.push('', `**${L.relatedCode()}**:`, bulletList(e.relatedCode.map((c) => `\`${c.file}\`${c.symbol ? ` · ${c.symbol}` : ''}`)));
  }
  if (e.reproductionQuestions.length) lines.push('', `**${L.reproInfo()}**:`, bulletList(e.reproductionQuestions));
  if (e.suggestedLabels.length) lines.push('', `**${L.suggestedLabels()}**(${L.notApplied()}):${e.suggestedLabels.join(', ')}`);
  if (e.suggestedOwners.length) lines.push('', `**${L.suggestedOwners()}**(${L.notApplied()}):${e.suggestedOwners.join(', ')}`);
  return lines.join('\n');
}

function renderPlan(p: ImplementationPlan, language?: string): string {
  const L = botMessages(language).enrich;
  const lines: string[] = [`### ${L.plan()}`, '', p.understanding];
  if (p.likelyRootCause) lines.push('', `**${L.likelyRootCause()}**:${p.likelyRootCause}`);
  if (p.assumptions.length) lines.push('', `**${L.assumptions()}**:`, bulletList(p.assumptions));
  if (p.changeSteps.length) lines.push('', `**${L.changeSteps()}**:`, bulletList(p.changeSteps));
  if (p.testSteps.length) lines.push('', `**${L.testSteps()}**:`, bulletList(p.testSteps));
  if (p.risks.length) lines.push('', `**${L.risks()}**:`, bulletList(p.risks));
  if (p.openQuestions.length) lines.push('', `**${L.openQuestions()}**:`, bulletList(p.openQuestions));
  lines.push('', p.canStartCodingAgent ? L.canStartAgentYes() : L.canStartAgentNo());
  return lines.join('\n');
}
