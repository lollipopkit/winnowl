import { createHash } from 'node:crypto';
import {
  buildSourceTools,
  languageInstruction,
  runAgentInvocation,
  Type,
  type AgentBudget,
  type ModelTier,
  type ResolvedModelSource,
} from '@reviewbot/agent-pi';
import type { ChangeRequestRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import { decideForReview } from '@reviewbot/entitlement';
import type { SourceControlProvider } from '@reviewbot/provider-contracts';
import { publishTopLevelComment, type PublishContext } from '@reviewbot/publisher';
import { CodePlaneReader, loadEffectiveConfig, type CodePlane } from '@reviewbot/review-runtime';
import { botName } from '@reviewbot/domain';
import { billRevision } from './learning-propose.js';
import { botMessages } from './locale.js';
import { addUsage, newUsage } from './propose-common.js';
import { JobExecutionError, type JobHandler } from './supervisor.js';

/**
 * cross_repo_analyze job: read-only analysis of one consumer after a producer contract change.
 * Quota gate → shallow clone consumer (deleted after) → one targeted invocation → on impact: idempotent
 * consumer issue + producer PR rolling comment; otherwise audit only. Billed to the producer revision.
 * The consumer is always read-only; fixes go through the consumer's own CR.
 */

export interface CrossRepoAnalyzePayload {
  tenantId: string;
  sourceRepositoryId: string;
  revisionId: string;
  consumer: { repositoryId: string; relationshipId: string; kind: string; instructions?: string };
  triggers: { kind: string; files: string[] }[];
  contractContext: { path: string; headContent: string; truncated: boolean }[];
}

export interface CrossRepoAnalyzeDeps {
  resolveModel: (tier?: ModelTier) => ResolvedModelSource | null;
  /** Opens a shallow workspace of the consumer repository (the caller scopes the token). */
  openRepository: (repo: { installationId: string; nativeId: string; cloneUrl: string }) => Promise<CodePlane>;
  buildProvider: (repositoryId: string) => Promise<SourceControlProvider>;
}

const IMPACT_SCHEMA = Type.Object({
  path: Type.String({ description: 'File in THIS repository containing the impacted call site.' }),
  claim: Type.String({ description: 'What breaks or changes behavior, and why, referencing the upstream contract change.' }),
  severity: Type.String({ description: 'critical | high | medium | low' }),
  evidence: Type.String({ description: 'The relevant code excerpt or usage you verified with the read tools.' }),
});
const COMPLETE_SCHEMA = Type.Object({ summary: Type.String({ description: 'One-paragraph overall impact assessment.' }) });

const ANALYZE_BUDGET: AgentBudget = { maxTurns: 14, maxToolCalls: 40 };

interface Impact {
  path: string;
  claim: string;
  severity: string;
  evidence: string;
}

function coerceImpact(raw: unknown): Impact | null {
  const r = raw as Partial<Impact> | undefined;
  if (!r?.path || !r.claim) return null;
  const sev = ['critical', 'high', 'medium', 'low'].includes(String(r.severity).toLowerCase()) ? String(r.severity).toLowerCase() : 'medium';
  return { path: r.path, claim: r.claim, severity: sev, evidence: r.evidence ?? '' };
}

/** Targeted analysis task (describes only this task, not the orchestration). */
function buildTask(input: { sourceRepo: string; payload: CrossRepoAnalyzePayload; language?: string }): string {
  const { payload } = input;
  const contracts = payload.contractContext
    .map((c) => `--- ${c.path}${c.truncated ? ' (truncated)' : ''} ---\n${c.headContent}`)
    .join('\n\n');
  return [
    `An upstream repository (${input.sourceRepo}) that this repository depends on (${payload.consumer.kind} relationship) changed its contract surface.`,
    `Changed contract files: ${payload.triggers.flatMap((t) => t.files).join(', ')} (categories: ${payload.triggers.map((t) => t.kind).join(', ')}).`,
    contracts ? `Current (post-change) content of the contract files:\n\n${contracts}` : 'Contract file contents unavailable; reason from the changed paths.',
    payload.consumer.instructions ? `Relationship notes from the administrator: ${payload.consumer.instructions}` : '',
    'Use the read tools to inspect THIS repository (read-only) and find call sites, schema usages, or generated-client surfaces that the upstream change may break or silently alter.',
    'Report each concrete impact with submit_impact (verify the usage actually exists — do not speculate from file names). When done, call complete_analysis. If nothing is impacted, call complete_analysis directly.',
    languageInstruction(input.language, 'impact claims and the summary'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function createCrossRepoAnalyzeHandler(deps: CrossRepoAnalyzeDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as CrossRepoAnalyzePayload;

    // Quota gate: over quota (reject/queue) → skip; degrade → cheap tier.
    const gate = await decideForReview(db, payload.tenantId);
    if (gate.block) {
      log('cross-repo-analyze skipped: over quota', { tenantId: payload.tenantId, reason: gate.reason });
      return;
    }
    const model = deps.resolveModel(gate.effectiveTier);
    if (!model) {
      log('cross-repo-analyze: no model configured', { revisionId: payload.revisionId });
      return;
    }

    const [sourceRepo, consumerRepo] = await Promise.all([
      db.selectFrom('repositories').select(['namespace', 'name', 'provider_host_id']).where('id', '=', payload.sourceRepositoryId).executeTakeFirstOrThrow(),
      db
        .selectFrom('repositories')
        .select(['installation_id', 'clone_url', 'namespace', 'name', 'provider_host_id', 'native_id', 'default_branch'])
        .where('id', '=', payload.consumer.repositoryId)
        .executeTakeFirstOrThrow(),
    ]);
    const sourceRepoName = `${sourceRepo.namespace}/${sourceRepo.name}`;
    const consumerRepoName = `${consumerRepo.namespace}/${consumerRepo.name}`;

    const cr = await db
      .selectFrom('revisions as rev')
      .innerJoin('change_requests as c', 'c.id', 'rev.change_request_id')
      .select(['c.id as id', 'c.native_id as nativeId', 'c.number as number', 'c.kind as kind', 'rev.head_sha as headSha'])
      .where('rev.id', '=', payload.revisionId)
      .executeTakeFirstOrThrow();

    // Output language follows the consumer repo (the issue is for its maintainers).
    const consumerCfg = await loadEffectiveConfig(db, payload.tenantId, payload.consumer.repositoryId);
    const language = consumerCfg.language;

    const usage = newUsage();
    const impacts: Impact[] = [];
    let summary = '';
    const workspace = await deps.openRepository({
      installationId: consumerRepo.installation_id,
      nativeId: consumerRepo.native_id,
      cloneUrl: consumerRepo.clone_url,
    });
    try {
      const source = new CodePlaneReader(workspace).source;
      const result = await runAgentInvocation({
        systemPrompt:
          'You analyze the impact of an upstream dependency contract change on a downstream repository. You have read-only tools over the downstream repository. Be precise and evidence-based: only report impacts you verified in the code.',
        task: buildTask({ sourceRepo: sourceRepoName, payload, ...(language !== undefined ? { language } : {}) }),
        model: model.model,
        streamFn: model.streamFn,
        readTools: buildSourceTools(source),
        collectors: [
          {
            name: 'submit_impact',
            description: 'Report one verified impacted call site in this repository.',
            label: 'Submit impact',
            schema: IMPACT_SCHEMA,
          },
        ],
        finalization: { name: 'complete_analysis', description: 'Finish the impact analysis with an overall summary.', label: 'Complete analysis', schema: COMPLETE_SCHEMA },
        budget: ANALYZE_BUDGET,
      });
      addUsage(usage, result.usage);
      // An incomplete invocation (stream error / budget exhausted) fails the job (retryable); never
      // treat it as "no impact".
      if (result.status !== 'complete') {
        throw new JobExecutionError(
          `cross-repo 分析未完成:${result.status}${result.errorMessage ? `(${result.errorMessage})` : ''}`,
          'retryable_runner',
          true,
        );
      }
      for (const raw of result.collected?.['submit_impact'] ?? []) {
        const impact = coerceImpact(raw);
        if (impact) impacts.push(impact);
      }
      summary = String((result.finalization as { summary?: unknown } | undefined)?.summary ?? '');
    } finally {
      await workspace.dispose().catch(() => undefined);
    }

    let issueUrl: string | undefined;
    if (impacts.length > 0) {
      const L = botMessages(language).crossRepo;
      const crLink = `${sourceRepoName}#${cr.number}`;
      const body = [
        L.issueIntro({ source: sourceRepoName, crLink, kind: payload.consumer.kind }),
        '',
        ...impacts.map((i) => L.issueImpact({ severity: i.severity, path: i.path, claim: i.claim })),
        ...(summary ? ['', summary] : []),
        '',
        L.issueFooter({ bot: botName() }),
      ].join('\n');
      const provider = await deps.buildProvider(payload.consumer.repositoryId);
      const issue = await provider.issues.create(
        {
          id: payload.consumer.repositoryId,
          providerHostId: consumerRepo.provider_host_id,
          installationId: consumerRepo.installation_id,
          nativeId: consumerRepo.native_id,
          namespace: consumerRepo.namespace,
          name: consumerRepo.name,
          cloneUrl: consumerRepo.clone_url,
          defaultBranch: consumerRepo.default_branch,
        },
        { title: L.issueTitle({ source: sourceRepoName, cr: String(cr.number) }), body: { markdown: body }, labels: [botName(), 'cross-repo'] },
        { key: `xrepo:${payload.revisionId}:${payload.consumer.repositoryId}` },
      );
      issueUrl = (issue as { url?: string } | undefined)?.url;

      // Rolling comment upsert: one per CR, with a per-consumer kind suffix so jobs don't overwrite each other.
      const producerCfg = await loadEffectiveConfig(db, payload.tenantId, payload.sourceRepositoryId);
      const PL = botMessages(producerCfg.language).crossRepo;
      const producerBody = [
        PL.producerNote({ count: 1 }),
        PL.producerLine({ repo: consumerRepoName, impacts: impacts.length, issueLink: issueUrl ? ` — ${issueUrl}` : '' }),
        '',
        PL.producerFooter(),
      ].join('\n');
      const producerProvider = await deps.buildProvider(payload.sourceRepositoryId);
      const changeRequest: ChangeRequestRef = { id: cr.id, repositoryId: payload.sourceRepositoryId, nativeId: cr.nativeId, number: cr.number, kind: cr.kind as ChangeRequestRef['kind'] };
      const publishCtx: PublishContext = { db, discussions: producerProvider.discussions, fetchCurrentHeadSha: async () => cr.headSha };
      await publishTopLevelComment(publishCtx, {
        tenantId: payload.tenantId,
        repositoryId: payload.sourceRepositoryId,
        changeRequest,
        changeRequestId: cr.id,
        providerHostId: sourceRepo.provider_host_id,
        kind: `cross-repo:${payload.consumer.repositoryId}`,
        bodyMarkdown: producerBody,
        fingerprint: createHash('sha256').update(impacts.map((i) => `${i.path} ${i.claim}`).join('\n')).digest('hex'),
      }).catch((err) => log('cross-repo-analyze: producer comment failed (issue already filed)', { error: err instanceof Error ? err.message : String(err) }));
    }

    await billRevision(db, payload.revisionId, usage);
    await db
      .insertInto('audit_events')
      .values({
        id: uuidv7(),
        tenant_id: payload.tenantId,
        actor: 'cross-repo-analyze',
        action: 'cross-repo.analyzed',
        target: payload.consumer.repositoryId,
        detail: {
          sourceRepositoryId: payload.sourceRepositoryId,
          revisionId: payload.revisionId,
          relationshipId: payload.consumer.relationshipId,
          impacts: impacts.length,
          ...(issueUrl ? { issueUrl } : {}),
          usage: { totalTokens: usage.totalTokens, costUsd: usage.costUsd },
        },
        created_at: new Date(),
      })
      .execute();
    log('cross-repo-analyze done', { consumer: consumerRepoName, impacts: impacts.length });
  };
}
