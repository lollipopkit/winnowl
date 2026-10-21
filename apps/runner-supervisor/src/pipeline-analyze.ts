import { createHash } from 'node:crypto';
import type { Model, StreamFn } from '@reviewbot/agent-pi';
import { publishTopLevelComment, type PublishContext } from '@reviewbot/publisher';
import type { Db } from '@reviewbot/db';
import type { ChangeRequestRef } from '@reviewbot/domain';
import {
  analyzeRootCause,
  correlateWithChanges,
  decideComment,
  normalizeDiagnostics,
  redactSecrets,
  type ChangedCode,
  type FailedJob,
} from '@reviewbot/pipeline-analysis';
import type { RootCause } from '@reviewbot/pipeline-analysis';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { JobExecutionError, type JobHandler } from './supervisor.js';

export interface PipelineAnalyzePayload {
  tenantId: string;
  repositoryId: string;
  changeRequestId: string;
  revisionId: string;
  headSha: string;
}

export interface PipelineAnalyzeEnv {
  provider: SourceControlProvider;
  /** Whether code is part of this change (diff/anchor). */
  changed: ChangedCode;
  model: Model<string>;
  streamFn: StreamFn;
  changeSummary?: string;
  /** Output language passed to the root-cause agent; omitted means English. */
  language?: string;
}

export interface PipelineAnalyzeContext {
  payload: PipelineAnalyzePayload;
  changeRequest: ChangeRequestRef;
  db: Db;
}

export interface PipelineAnalyzeDeps {
  buildEnv: (ctx: PipelineAnalyzeContext) => Promise<PipelineAnalyzeEnv>;
}

/** CI conclusions treated as failures (cancelled is not analyzed). */
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
function isFailure(conclusion: string | undefined): boolean {
  return conclusion !== undefined && FAILURE_CONCLUSIONS.has(conclusion);
}

/**
 * Strips the per-line timestamp prefix GitHub Actions adds to job logs (`2026-07-16T06:00:00.1234567Z <line>`);
 * otherwise diagnostic normalization (anchored at `^file:line`) cannot match.
 */
function stripLogTimestamps(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/gm, '');
}

/**
 * pipeline_analyze: root-cause analysis of a CI failure, commented when it adds value.
 * Logs → redact → normalize → relate to the change → root-cause agent → dedupe.
 */
export function createPipelineAnalyzeHandler(deps: PipelineAnalyzeDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as PipelineAnalyzePayload;

    const cr = await db
      .selectFrom('change_requests')
      .innerJoin('repositories', 'repositories.id', 'change_requests.repository_id')
      .select([
        'change_requests.id as id',
        'change_requests.repository_id as repository_id',
        'change_requests.native_id as native_id',
        'change_requests.number as number',
        'change_requests.kind as kind',
        'repositories.provider_host_id as provider_host_id',
      ])
      .where('change_requests.id', '=', payload.changeRequestId)
      .executeTakeFirst();
    if (!cr) throw new JobExecutionError(`change request not found: ${payload.changeRequestId}`, 'repository_invalid', false);
    const changeRequest: ChangeRequestRef = {
      id: cr.id,
      repositoryId: cr.repository_id,
      nativeId: cr.native_id,
      number: cr.number,
      kind: cr.kind === 'merge-request' ? 'merge-request' : 'pull-request',
    };

    const env = await deps.buildEnv({ payload, changeRequest, db });

    const runs = await env.provider.pipelines.listRuns(changeRequest);
    const failedRuns = runs.filter((r) => isFailure(r.conclusion));

    const failedJobs: FailedJob[] = [];
    for (const run of failedRuns) {
      const jobs = await env.provider.pipelines.getJobs(run.ref);
      for (const j of jobs) {
        if (!isFailure(j.conclusion)) continue;
        const logs = await env.provider.pipelines.getLogs(j.ref);
        const redacted = redactSecrets(stripLogTimestamps(logs.text));
        const diagnostics = correlateWithChanges(normalizeDiagnostics(redacted.text), env.changed);
        failedJobs.push({ jobId: j.ref.nativeId, name: j.name, conclusion: j.conclusion ?? 'failure', diagnostics });
      }
    }

    if (failedJobs.length === 0) {
      log('pipeline analyze: no failed CI jobs', { changeRequestId: payload.changeRequestId, headSha: payload.headSha });
      return;
    }

    const rootCause = await analyzeRootCause(failedJobs, {
      model: env.model,
      streamFn: env.streamFn,
      ...(env.changeSummary !== undefined ? { changeSummary: env.changeSummary } : {}),
      ...(env.language !== undefined ? { language: env.language } : {}),
    });

    const diagnostics = failedJobs.flatMap((j) => j.diagnostics);
    const decision = decideComment({ diagnostics, ciAlreadyShowsError: false, rootCause });
    if (!decision.shouldComment) {
      log('pipeline analyze: no incremental value, skip comment', {
        changeRequestId: payload.changeRequestId,
        reasons: decision.reasons,
      });
      return;
    }

    // Stable root-cause fingerprint: excludes per-run check-run/job ids so the same cause across heads
    // does not refresh the comment.
    const fingerprint = ciRootCauseFingerprint(rootCause, failedJobs);

    // Top-level comment upsert: one rolling comment per PR; skipped when the root cause is unchanged.
    const publishCtx: PublishContext = {
      db,
      discussions: env.provider.discussions,
      fetchCurrentHeadSha: async () => payload.headSha,
    };
    const result = await publishTopLevelComment(publishCtx, {
      tenantId: payload.tenantId,
      repositoryId: payload.repositoryId,
      changeRequest,
      changeRequestId: payload.changeRequestId,
      providerHostId: cr.provider_host_id,
      kind: 'ci-analysis',
      bodyMarkdown: renderComment(rootCause, failedJobs, decision.valueAdds),
      fingerprint,
    });
    log('pipeline analyze: published', {
      changeRequestId: payload.changeRequestId,
      failedJobs: failedJobs.length,
      valueAdds: decision.valueAdds,
      publishStatus: result.status,
    });
  };
}

/** Root-cause fingerprint over stable fields (excludes volatile check-run/job ids). */
function ciRootCauseFingerprint(rootCause: RootCause, failedJobs: FailedJob[]): string {
  const diagKeys = failedJobs
    .flatMap((j) => j.diagnostics.map((d) => `${d.file ?? ''}:${d.message}`))
    .sort();
  const locKeys = rootCause.codeLocations.map((l) => `${l.file}:${l.line ?? ''}`).sort();
  const payload = JSON.stringify({
    summary: rootCause.summary,
    fix: rootCause.verifiableFix ?? '',
    cause: rootCause.causingChange ?? '',
    locs: locKeys,
    diags: [...new Set(diagKeys)],
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Comment body. Scaffolding (headings/labels/footer) is English; body language follows `language`. */
function renderComment(rootCause: RootCause, failedJobs: FailedJob[], valueAdds: string[]): string {
  const lines: string[] = ['### CI failure root-cause analysis', '', rootCause.summary.trim()];
  // Model text often contains numbered lists: labels and body must be on separate lines, or GitHub
  // does not render `1.` as a list.
  if (rootCause.causingChange) lines.push('', '**Attribution**', '', rootCause.causingChange.trim());
  if (rootCause.verifiableFix) lines.push('', '**Verifiable fix**', '', rootCause.verifiableFix.trim());

  const onChanged = failedJobs
    .flatMap((j) => j.diagnostics.filter((d) => d.onChangedCode).map((d) => ({ job: j.name, d })))
    .slice(0, 10);
  if (onChanged.length > 0) {
    // A blank line before a list, or the first item may not render as a list after a bold paragraph.
    lines.push('', '**Diagnostics on changed code**', '');
    for (const { job, d } of onChanged) {
      lines.push(`- \`${d.file ?? '?'}:${d.line ?? '?'}\` (${job}) ${d.message}`);
    }
  }

  if (rootCause.sameRootCauseGroups.some((g) => g.length > 1)) {
    const groups = rootCause.sameRootCauseGroups.filter((g) => g.length > 1).map((g) => g.join(', '));
    lines.push('', `**Same root cause**: ${groups.join('; ')}`);
  }

  lines.push('', `_Incremental value: ${valueAdds.join(', ')}; confidence ${(rootCause.confidence * 100).toFixed(0)}%. Passing CI ≠ absence of defects (§29.4)._`);
  return lines.join('\n');
}
