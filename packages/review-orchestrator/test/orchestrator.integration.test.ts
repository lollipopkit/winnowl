import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRoutingFauxAgent } from '@reviewbot/agent-pi';
import { WorkspaceSourceProvider } from '@reviewbot/code-intel';
import { createDb, type Db } from '@reviewbot/db';
import type { ChangeRequestRef } from '@reviewbot/domain';
import { uuidv7 } from '@reviewbot/ids';
import { loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import type {
  ChangeRequestRef as CR,
  CommentReceipt,
  DiscussionThread,
  IdempotencyContext,
  ProviderAnchor,
  ReviewBatch,
  ReviewReceipt,
  RichComment,
} from '@reviewbot/provider-contracts';
import { resolveProfile } from '@reviewbot/review-profile';
import { createManualClock, startMigratedPostgres, type ManualClock } from '@reviewbot/testkit';
import { ReviewIncompleteError, runReviewAndPublish, type ReviewOrchestratorDeps } from '../src/index.js';

const TENANT = uuidv7();
const HOST = uuidv7();
const REPO = uuidv7();
const CR_ID = uuidv7();
const REVISION_ID = uuidv7();
const HEAD = 'head-sha-1';

const CHANGE_REQUEST: ChangeRequestRef = { id: CR_ID, repositoryId: REPO, nativeId: '42', number: 42, kind: 'pull-request' };

class StubDiscussions {
  comments: { nativeId: string; body: string }[] = [];
  threads: DiscussionThread[] = [];
  createInlineComment = async (_ref: CR, _anchor: ProviderAnchor, body: RichComment, _idem: IdempotencyContext): Promise<CommentReceipt> => {
    const nativeId = `c${this.comments.length + 1}`;
    this.comments.push({ nativeId, body: body.markdown });
    return { nativeId, url: 'u' };
  };
  topLevel: { nativeId: string; body: string }[] = [];
  createTopLevelComment = async (_target: unknown, body: RichComment, _idem: IdempotencyContext): Promise<CommentReceipt> => {
    const nativeId = `t${this.topLevel.length + 1}`;
    this.topLevel.push({ nativeId, body: body.markdown });
    return { nativeId, url: 'u' };
  };
  reviewBatches: { event: string; summary?: string; comments: { path: string; line?: number; body: string }[] }[] = [];
  createReviewBatch = async (_ref: CR, review: ReviewBatch, _idem: IdempotencyContext): Promise<ReviewReceipt> => {
    this.reviewBatches.push({
      event: review.event,
      ...(review.summary ? { summary: review.summary.markdown } : {}),
      comments: review.comments.map((c) => ({ path: c.anchor.path, line: c.anchor.line, body: c.body.markdown })),
    });
    return { nativeId: `r${this.reviewBatches.length}` };
  };
  listThreads = async (): Promise<DiscussionThread[]> => this.threads;
}

describe('runReviewAndPublish 端到端', () => {
  let stop: () => Promise<void>;
  let db: Db;
  let dir: string;
  let source: WorkspaceSourceProvider;
  let bundles: ReviewOrchestratorDeps['bundles'];

  beforeAll(async () => {
    const pg = await startMigratedPostgres();
    db = createDb(pg.pool);
    stop = pg.stop;
    await db.insertInto('tenants').values({ id: TENANT, name: 'acme', region: null, created_at: new Date() }).execute();

    dir = await mkdtemp(join(tmpdir(), 'rvb-orch-'));
    await writeFile(join(dir, 'app.py'), 'def add(a, b):\n    return a + b\n');
    source = new WorkspaceSourceProvider(dir, [{ path: 'app.py', status: 'modified' }]);

    const loaded = await loadPromptBundles(['mapper', 'reviewer', 'synthesizer', 'verifier', 'refuter']);
    bundles = {
      mapper: loaded.mapper as PromptBundle,
      reviewer: loaded.reviewer as PromptBundle,
      synthesizer: loaded.synthesizer as PromptBundle,
      verifier: loaded.verifier as PromptBundle,
      refuter: loaded.refuter as PromptBundle,
    };
  });

  afterAll(async () => {
    await stop?.();
    await rm(dir, { recursive: true, force: true });
  });

  it('探索→verify→matrix→锚点→幂等发布,产出 inline 评论与 publication_record', async () => {
    const discussions = new StubDiscussions();
    // Routing faux: each stage owns its response queue (routed by finalization tool), so concurrent invocations consume independently of order.
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'no cross-scope issues' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });

    const deps: ReviewOrchestratorDeps = {
      source,
      model: faux.model,
      streamFn: faux.streamFn,
      bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 },
      newId: () => uuidv7(),
      changeSummary: 'change add()',
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: {
        tenantId: TENANT,
        repositoryId: REPO,
        changeRequest: CHANGE_REQUEST,
        changeRequestId: CR_ID,
        revisionId: REVISION_ID,
        revisionSha: HEAD,
        providerHostId: HOST,
        expectedHeadSha: HEAD,
      },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.candidateCount).toBe(1);
    expect(outcome.publishedInline).toBe(1);
    expect(outcome.publishedSummary).toBe(true);
    expect(outcome.coverage).toEqual({ scopesTotal: 1, scopesComplete: 1 });
    expect(Object.keys(outcome.stageMs ?? {}).sort()).toEqual(['dig', 'map', 'publish', 'verifyTail']);
    const finding = outcome.findings[0]!;
    expect(finding.placement).toBe('inline');
    expect(finding.decision.status).toBe('confirmed');
    expect(finding.decision.blocking).toBe(true);
    expect(finding.codeContext?.lines.length).toBeGreaterThan(0);
    expect(finding.codeContext!.startLine).toBeLessThanOrEqual(finding.anchor!.line);

    // One PR review batch = summary body + inline comments.
    expect(discussions.reviewBatches).toHaveLength(1);
    expect(discussions.comments).toHaveLength(0);
    const batch = discussions.reviewBatches[0]!;
    expect(batch.event).toBe('request-changes');
    expect(batch.comments).toHaveLength(1);
    expect(batch.comments[0]!.body).toContain('winnowl:finding=');
    expect(batch.comments[0]!.body).toContain('🧩');
    expect(batch.summary).toContain('Actionable comments posted:');
    const rec = await db.selectFrom('publication_records').selectAll().where('kind', '=', 'review').executeTakeFirstOrThrow();
    expect(rec.state).toBe('published');
  });

  // Presentation order is severity descending; exploration output order is unrelated to severity.
  it('inline 评论与摘要索引均按严重度降序(探索产出顺序不决定呈现顺序)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        // The lighter one is produced first, so without sorting it would come first.
        faux.assistant(faux.toolCall('submit_finding', { claim: 'operand types are never validated', category: 'correctness', suspectedSeverity: 'medium', path: 'app.py', primaryAnchorText: 'def add(a, b):', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('submit_finding', { claim: 'add returns the difference instead of the sum', category: 'correctness', suspectedSeverity: 'critical', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [
        faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'medium', confirmation: 'independently-verified', residualUncertainty: [] })),
        faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'critical', confirmation: 'independently-verified', residualUncertainty: [] })),
      ],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] })), faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });

    await runReviewAndPublish({
      source, model: faux.model, streamFn: faux.streamFn, bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
    });

    const batch = discussions.reviewBatches[0]!;
    expect(batch.comments).toHaveLength(2);
    expect(batch.comments[0]!.body).toContain('🔴 **Critical**');
    expect(batch.comments[0]!.body).toContain('add returns the difference');
    expect(batch.comments[1]!.body).toContain('🟡 **Minor**');
    // The summary's confirmed index uses the same order.
    const summary = batch.summary ?? '';
    expect(summary.indexOf('add returns the difference')).toBeLessThan(summary.indexOf('operand types are never validated'));
  });

  it('锚点不在变更行 → inline 降级 summary(GitHub 对 diff 外行整单 422,2026-07-21 conduit#148)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'no cross-scope issues' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      // The anchor text resolves to a line, but that line is outside the diff's changed lines.
      isChangedLine: () => false,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
    };
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.candidateCount).toBe(1);
    expect(outcome.publishedInline).toBe(0); // No inline that would risk a 422.
    expect(outcome.findings[0]!.placement).toBe('folded'); // Finding is kept, folded.
    // The demotion reason must stay distinguishable (anchor outside the diff), not collapse into `summary`.
    expect(outcome.findings[0]!.demotions).toEqual(['anchor-outside-diff']);
    for (const b of discussions.reviewBatches) expect(b.comments).toHaveLength(0);
    // Out-of-diff findings go to the out-of-range section, each with its file (internal demotion enum is not exposed).
    const summary = discussions.reviewBatches.at(-1)?.summary ?? '';
    expect(summary).toContain('Outside diff range comments (1)');
    expect(summary).toContain('<summary>app.py');
    expect(summary).not.toContain('anchor-outside-diff');
  });

  it('§依赖门禁:确定性 CVE finding 并入发布 —— introduced+critical 阻断 approve,preexisting 不阻断,tool-confirmed 免 verify', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    // No agent findings; without the dependency gate this would approve.
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }))],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'clean' }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      autoApprove: true,
      dependencyFindings: [
        { claim: '依赖 `django@2.2.0` 受 critical 级公告 GHSA-x 影响;应升级。', path: 'requirements.txt', severity: 'critical', advisoryId: 'GHSA-x', introduced: true, blocking: true },
        { claim: '依赖 `old@1.0` 旧漏洞。', path: 'other.lock', severity: 'critical', advisoryId: 'GHSA-old', introduced: false, blocking: false },
      ],
    };
    const outcome = await runReviewAndPublish(deps);

    // Synthetic findings skip verify and are tool-confirmed.
    const dep = outcome.findings.find((f) => f.primaryAnchorText === 'GHSA-x')!;
    expect(dep.verdict.confirmation).toBe('tool-confirmed');
    expect(dep.decision.blocking).toBe(true);
    expect(dep.verdict.changeRelation).toBe('introduced');
    const pre = outcome.findings.find((f) => f.primaryAnchorText === 'GHSA-old')!;
    expect(pre.decision.blocking).toBe(false);
    expect(pre.verdict.changeRelation).toBe('preexisting-unrelated');
    // Blocking -> no approve; a visible review is still posted with 0 inline so the reason is visible.
    expect(discussions.reviewBatches).toHaveLength(1);
    expect(discussions.reviewBatches[0]!.event).toBe('request-changes');
    expect(discussions.reviewBatches[0]!.summary).toContain('GHSA-x');
    // With 0 inline the summary must state why it did not approve; otherwise it reads like a clean PR.
    expect(discussions.reviewBatches[0]!.summary).toContain('1 blocking finding(s) still stand');
    expect(discussions.reviewBatches[0]!.summary).not.toContain('No blocking issues found');
  });

  it('只有非 blocking 依赖 advisory → approve,summary 照样列出,不随 0 inline 消失(flutter_server_box#1632)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      autoApprove: true,
      // With description capability the summary has no top-level fallback; the review is its only outlet.
      updateSummaryDescription: async () => {},
      dependencyFindings: [
        { claim: '依赖 `old@1.0` 旧漏洞。', path: 'other.lock', severity: 'critical', advisoryId: 'GHSA-old', introduced: false, blocking: false },
      ],
    };
    const outcome = await runReviewAndPublish(deps);

    expect(outcome.reviewEvent).toBe('approve');
    expect(outcome.publishedInline).toBe(0);
    expect(discussions.reviewBatches).toHaveLength(1);
    expect(discussions.reviewBatches[0]!.event).toBe('approve');
    expect(discussions.reviewBatches[0]!.summary).toContain('`old@1.0`');
    expect(outcome.resultsPosted).toBe(true);
  });

  it('pre-verify 去重(§加速#2):同文件 claim 近似的两候选只 verify 一次', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    // Two near-identical same-file candidates -> claim Dice >= threshold -> the second skips verify.
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add returns a plus b plus one instead of a plus b', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add returns a plus b plus one rather than a plus b', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      // Only one verdict/refutation queued: if dedup fails the queue runs dry and findings > 1.
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
    };
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.candidateCount).toBe(2); // candidateCount counts all discovered candidates.
    expect(outcome.findings).toHaveLength(1); // Only one reaches verify (pre-verify dedup).
    expect(outcome.publishedInline).toBe(1);
  });

  it('batch 去重策略(§加速#2):barrier 统一去重后只 verify 存活者', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    // Two differently worded candidates (token-Dice would not merge) -> the injected batch strategy suppresses the second.
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'add returns a plus b plus one (off by one)', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('submit_finding', { claim: 'summation overshoots by a single unit in the add helper', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      // Batch strategy is a barrier: dedup after the whole pipeline produced, then verify survivors.
      dedupStrategy: { kind: 'batch', dedupe: async (cands) => new Set(cands.slice(1).map((c) => c.id)) },
    };
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.candidateCount).toBe(2);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.publishedInline).toBe(1);
  });

  it('注入 updateSummaryDescription → Summary 进 PR 描述,inline 融合 batch(§25.1,类 CodeRabbit)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    let prBody = '';
    const deps: ReviewOrchestratorDeps = {
      source,
      model: faux.model,
      streamFn: faux.streamFn,
      bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 },
      newId: () => uuidv7(),
      changeSummary: 'change add()',
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      updateSummaryDescription: async (md: string) => {
        prBody = md;
      },
    };

    const outcome = await runReviewAndPublish(deps);
    expect(outcome.publishedInline).toBe(1);
    expect(outcome.publishedSummary).toBe(true);
    // PR description = change overview (Map scopes), without findings (avoid duplicating inline).
    expect(prBody).toContain('## Summary');
    expect(prBody).toContain('### Changes');
    expect(prBody).toContain('add()');
    expect(prBody).not.toContain('off-by-one in add');
    expect(discussions.reviewBatches).toHaveLength(1);
    expect(discussions.reviewBatches[0]!.comments).toHaveLength(1);
    expect(discussions.reviewBatches[0]!.comments[0]!.body).toContain('off-by-one in add');
    // Review body is the summary; changeIntent is already in the description, so no walkthrough here.
    expect(discussions.reviewBatches[0]!.summary).toContain('Actionable comments posted:');
    expect(discussions.reviewBatches[0]!.summary).not.toContain('added to the PR description');
    expect(discussions.topLevel).toHaveLength(0);
  });

  it('slop 类别 → 折叠进 summary(不 inline、不阻断),profile 传入不改验证标准(§36)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'maintainability', description: 'clean' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'redundant comment restates code', category: 'meaningless-comment', suspectedSeverity: 'low', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'low', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });

    const deps: ReviewOrchestratorDeps = {
      source,
      model: faux.model,
      streamFn: faux.streamFn,
      bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 },
      newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      // Separate revisionId: the summary idempotency key is `summary:{revisionId}`.
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      profile: resolveProfile('balanced'),
    };

    const outcome = await runReviewAndPublish(deps);
    const f = outcome.findings[0]!;
    expect(f.slop).toBe(true);
    // Low's confirmation bar is independently-verified; this one meets it and passes the gate,
    // then slop's forceSummary folds it into "other findings". Below-bar ones go to low-evidence (next case).
    expect(f.placement).toBe('folded');
    expect(outcome.publishedInline).toBe(0);
    expect(discussions.comments).toHaveLength(0);

    // slop + low = nitpick, non-blocking; the only new finding -> comment, not approve.
    // No inline, so the summary is posted top-level with the item in the folded Nitpick section.
    expect(f.decision.kind).toBe('nit');
    expect(f.decision.blocking).toBe(false);
    expect(outcome.publishedSummary).toBe(true);
    expect(discussions.reviewBatches).toHaveLength(0);
    expect(discussions.topLevel).toHaveLength(1);
    const summary = discussions.topLevel[0]!.body;
    expect(summary).toContain('<details>');
    expect(summary).toContain('Nitpick');
    expect(summary).toContain('redundant comment restates code');
  });

  it('nit(打磨类)锚得住就 inline —— 走独立名额,不计入 actionable;名额=0 时折叠进 🧹 Nitpick 区', async () => {
    // maintainability (non-blocking category) + medium + independently-verified -> matrix says `nit`.
    const nitRun = async (maxInlineNits: number) => {
      const discussions = new StubDiscussions();
      const faux = createRoutingFauxAgent();
      faux.setStageResponses({
        submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'maintainability', description: 'clean' }] }] }))],
        complete_section: [
          faux.assistant(faux.toolCall('submit_finding', { claim: 'parameter name shadows the outer binding', category: 'maintainability', suspectedSeverity: 'medium', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
          faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
        ],
        submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
        submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'medium', confirmation: 'independently-verified', residualUncertainty: [] }))],
        confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
      });
      const deps: ReviewOrchestratorDeps = {
        source, model: faux.model, streamFn: faux.streamFn, bundles,
        budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
        readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
        isChangedLine: () => true,
        publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
        publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
        noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits },
      };
      return { outcome: await runReviewAndPublish(deps), discussions };
    };

    // (1) With quota: posted inline (Nitpick header), not counted as actionable, still auto-approve.
    const withBudget = await nitRun(1);
    const nit = withBudget.outcome.findings[0]!;
    expect(nit.decision.kind).toBe('nit');
    expect(nit.placement).toBe('inline');
    expect(withBudget.outcome.publishedInline).toBe(1);
    const batch = withBudget.discussions.reviewBatches[0]!;
    // Only nitpicks this round -> comment.
    expect(batch.event).toBe('comment');
    expect(batch.comments[0]!.body).toContain('🧹 **Nitpick**');
    expect(batch.summary).toContain('**Actionable comments posted: 0**');
    expect(batch.summary).toContain('<summary>🧹 Nitpick comments (1)</summary>');
    expect(batch.summary).toContain('parameter name shadows the outer binding (inline)');
    // Must not land in "other findings" (that is for formal findings that could not be inlined).
    expect(batch.summary).not.toContain('Additional findings from this change');

    // (2) Quota 0: folded into the Nitpick section, not posted inline, not dropped.
    const noBudget = await nitRun(0);
    // The category axis survives demotion: still a nit after folding.
    expect(noBudget.outcome.findings[0]!.decision.kind).toBe('nit');
    expect(noBudget.outcome.findings[0]!.placement).toBe('folded');
    expect(noBudget.outcome.publishedInline).toBe(0);
    // No inline and no blocking -> no review; the summary is posted top-level.
    expect(noBudget.discussions.reviewBatches).toHaveLength(0);
    const folded = noBudget.discussions.topLevel[0]!.body;
    expect(folded).toContain('<summary>🧹 Nitpick comments (1)</summary>');
    expect(folded).toContain('parameter name shadows the outer binding (summary)');
  });

  it('a candidate whose verification never finished keeps the review from approving', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum' }], files: ['app.py'] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'add() returns the wrong sum for negative input', category: 'correctness', suspectedSeverity: 'medium', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant('Still reading.'), faux.assistant('Still reading.')], // Neither attempt (including the auto-rerun) submits.
    });
    const outcome = await runReviewAndPublish({
      source, model: faux.model, streamFn: faux.streamFn, bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD }, noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
    });
    expect([outcome.reviewEvent, ...discussions.reviewBatches.map((b) => b.event)]).not.toContain('approve');
  });

  // app.py has only two lines, so it holds at most two distinct-anchor findings; hence two cases.
  it('publication:summary_overflow=false 丢弃超名额项,但 blocking 的不丢(门禁不受呈现开关影响)', async () => {
    const run = async (extra: Partial<ReviewOrchestratorDeps>) => {
      const discussions = new StubDiscussions();
      const faux = createRoutingFauxAgent();
      faux.setStageResponses({
        submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
        complete_section: [
          faux.assistant(faux.toolCall('submit_finding', { claim: 'add returns the difference', category: 'correctness', suspectedSeverity: 'medium', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
          faux.assistant(faux.toolCall('submit_finding', { claim: 'operands are never validated', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'def add(a, b):', changeRelationHypothesis: 'introduced' })),
          faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
        ],
        submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
        submit_assessment: [
          // (1) preexisting -> confirmed but non-blocking, droppable when over quota.
          faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: false, reachable: true, actionable: true, changeRelation: 'preexisting-relevant', severity: 'medium', confirmation: 'independently-verified', residualUncertainty: [] })),
          // (2) high accept upheld by refuter -> blocking, must not be dropped.
          faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] })),
        ],
        confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] })), faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
      });
      const deps: ReviewOrchestratorDeps = {
        source, model: faux.model, streamFn: faux.streamFn, bundles,
        budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
        readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
        isChangedLine: () => true,
        publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
        publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
        noiseBudget: { maxInlineComments: 0, maxInlinePerFile: 3, maxInlineNits: 0 }, // Both exceed the total quota.
        ...extra,
      };
      return { outcome: await runReviewAndPublish(deps), discussions };
    };
    const find = (r: Awaited<ReturnType<typeof run>>, prefix: string) => r.outcome.findings.find((f) => f.claim.startsWith(prefix));

    // (1) Default: overflow folds into the overflow section with the limiting quota named.
    const kept = await run({});
    expect(kept.discussions.reviewBatches[0]?.summary ?? '').toMatch(/add returns the difference \(app\.py:\d+\) — over the inline comment limit/);
    expect(find(kept, 'add returns')?.suppressed).toBeUndefined();

    // (2) summary_overflow=false: non-blocking overflow is dropped.
    const dropped = await run({ summaryOverflow: false });
    const droppedSummary = dropped.discussions.reviewBatches[0]?.summary ?? '';
    expect(find(dropped, 'add returns')?.suppressed).toBe(true);
    expect(find(dropped, 'add returns')?.suppressReason).toBe('quota');
    expect(droppedSummary).not.toContain('add returns the difference');
    // Blocking is never dropped, otherwise a presentation toggle would open the gate.
    expect(find(dropped, 'operands are never validated')?.decision.blocking).toBe(true);
    expect(find(dropped, 'operands are never validated')?.suppressed).toBeUndefined();
    expect(droppedSummary).toContain('operands are never validated');
  });

  it('publication:show_unverified_risks=false 不渲染 ⚠️ 区(finding 本身不受影响)', async () => {
    const run = async (extra: Partial<ReviewOrchestratorDeps>) => {
      const discussions = new StubDiscussions();
      const faux = createRoutingFauxAgent();
      faux.setStageResponses({
        submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
        complete_section: [
          faux.assistant(faux.toolCall('submit_finding', { claim: 'overflow is unchecked for large operands', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
          faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
        ],
        submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
        // uncertain + high severity -> unconfirmed risk.
        submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'uncertain', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'hypothesis', residualUncertainty: [] }))],
        confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
      });
      const deps: ReviewOrchestratorDeps = {
        source, model: faux.model, streamFn: faux.streamFn, bundles,
        budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
        readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
        isChangedLine: () => true,
        publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
        publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
        noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
        ...extra,
      };
      return { outcome: await runReviewAndPublish(deps), discussions };
    };

    const shown = await run({});
    expect(shown.discussions.reviewBatches[0]?.summary ?? '').toContain('<summary>⚠️ Unverified risks (1)</summary>');

    const hidden = await run({ showUnverifiedRisks: false });
    const summary = hidden.discussions.reviewBatches[0]?.summary ?? '';
    expect(summary).not.toContain('Unverified risks');
    expect(summary).not.toContain('overflow is unchecked');
    // Not rendered, but the finding still exists (persistence and gating unchanged).
    expect(hidden.outcome.findings[0]?.decision.status).toBe('uncertain');
    expect(hidden.outcome.findings[0]?.suppressed).toBeUndefined();
  });

  // Gate: no new findings this round (would approve), but a prior blocking finding exists.
  // extra: submit_resolution responses for gate re-verification (setStageResponses can only be called once).
  const cleanRun = (faux: ReturnType<typeof createRoutingFauxAgent>, extra: Record<string, unknown[]> = {}) =>
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'ok' }] }] }))],
      complete_section: [faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }))],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      ...extra,
    });
  const gateDeps = (
    faux: ReturnType<typeof createRoutingFauxAgent>,
    discussions: StubDiscussions,
    priorBlockingFindings: ReviewOrchestratorDeps['priorBlockingFindings'],
    filesChangedSince?: ReviewOrchestratorDeps['filesChangedSince'],
  ): ReviewOrchestratorDeps => ({
    source,
    model: faux.model,
    streamFn: faux.streamFn,
    bundles,
    budget: { maxTurns: 8, maxToolCalls: 16 },
    newId: () => uuidv7(),
    readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
    isChangedLine: () => true,
    publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
    publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
    noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
    profile: resolveProfile('balanced'),
    ...(priorBlockingFindings ? { priorBlockingFindings } : {}),
    ...(filesChangedSince ? { filesChangedSince } : {}),
  });

  it('门禁:本轮无新 blocking,但历史 blocking 的文件自那轮起没动过 → 不 approve + summary 列出', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    cleanRun(faux); // No findings and no submit_resolution response: reaching the LLM means the prefilter did not apply.
    const deps = gateDeps(
      faux,
      discussions,
      [{ findingId: uuidv7(), fingerprint: 'prior-fp-1', claim: 'add() must sum a and b', anchorText: 'return a + b', path: 'app.py', lastSeenHeadSha: 'sha-prev' }],
      async () => new Set(['README.md']), // app.py untouched -> still-present.
    );
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.unresolvedPriorBlocking).toHaveLength(1);
    expect(outcome.unresolvedPriorBlocking![0]!.method).toBe('file-unchanged');
    // Gate holds: a visible review (event=comment) is posted even with 0 new inline, listing unresolved items.
    const batch = discussions.reviewBatches[0]!;
    expect(batch.event).toBe('request-changes');
    expect(batch.summary).toContain('Unresolved from previous review');
    expect(discussions.reviewBatches.some((b) => b.event === 'approve')).toBe(false);
    // The aggregated prompt must include it first in the unresolved group: it is the only thing blocking approve.
    expect(batch.summary).toContain('## Unresolved from the previous review — these block approval, fix them first (1)');
    expect(batch.summary).toContain('Review comments at @app.py:\n- add() must sum a and b');
  });

  // Non-blocking prior item: its file was reviewed this round but it was not re-reported. Same re-verification as the gate, but the result does not enter blocking.
  it('非 blocking 历史项:文件动过且核验判 fixed → resolved;没动 → 留在「此前已报」,不挡 approve', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    cleanRun(faux, { submit_resolution: [faux.assistant(faux.toolCall('submit_resolution', { status: 'fixed', reasoning: 'bound corrected' }))] });
    const open = (fingerprint: string, claim: string, lastSeenHeadSha: string) => ({
      findingId: uuidv7(), fingerprint, category: 'correctness', claim, severity: 'medium', path: 'app.py',
      anchorText: 'return a + b', lastSeenHeadSha,
    });
    const fixedOne = open('open-fp-fixed', 'off-by-one in the upper bound', 'sha-touched');
    const stillOne = open('open-fp-still', 'sum overflows for large operands', 'sha-untouched');
    const deps: ReviewOrchestratorDeps = {
      ...gateDeps(faux, discussions, undefined, async (sha) => (sha === 'sha-touched' ? new Set(['app.py']) : new Set<string>())),
      openPriorFindings: [fixedOne, stillOne],
    };
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.resolvedFindingIds).toEqual([fixedOne.findingId]);
    const batch = discussions.reviewBatches[0]!;
    expect(batch.event).toBe('approve');
    expect(batch.summary).toContain('sum overflows for large operands');
    expect(batch.summary).not.toContain('off-by-one in the upper bound');
  });

  it('门禁:历史 blocking 的文件动过 + 定向核验判 fixed → resolved + approve', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    cleanRun(faux, { submit_resolution: [faux.assistant(faux.toolCall('submit_resolution', { status: 'fixed', reasoning: 'guard added' }))] });
    const deps = gateDeps(
      faux,
      discussions,
      [{ findingId: uuidv7(), fingerprint: 'prior-fp-2', claim: 'missing zero guard', anchorText: 'return a / b  // no guard', path: 'app.py', lastSeenHeadSha: 'sha-prev' }],
      async () => new Set(['app.py']),
    );
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.resolvedFingerprints).toEqual(['prior-fp-2']);
    expect(outcome.unresolvedPriorBlocking ?? []).toHaveLength(0);
    expect(discussions.reviewBatches[0]!.event).toBe('approve');
  });

  // The anchor text still exists verbatim in head because the fix landed outside the anchor; the criterion is
  // "was the file touched", so this must reach the LLM and be judged resolved.
  it('门禁:锚文本原样保留但文件动过 → 仍交 LLM,判 fixed 则 approve', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    cleanRun(faux, { submit_resolution: [faux.assistant(faux.toolCall('submit_resolution', { status: 'fixed', reasoning: 'inputs are validated before the sum' }))] });
    const deps = gateDeps(
      faux,
      discussions,
      [{ findingId: uuidv7(), fingerprint: 'prior-fp-3', claim: 'add() must reject non-numbers', anchorText: 'return a + b', path: 'app.py', lastSeenHeadSha: 'sha-prev' }],
      async () => new Set(['app.py']),
    );
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.unresolvedPriorBlocking ?? []).toHaveLength(0);
    expect(outcome.resolvedFingerprints).toEqual(['prior-fp-3']);
    expect(discussions.reviewBatches[0]!.event).toBe('approve');
  });

  // A verifier that admits the fix landed but flags a residual sub-case: the old finding is resolved,
  // and the new issue goes through verify -> anchor -> matrix -> quota as a fresh candidate.
  it('对账判「已修但另有问题」→ 旧的 resolved,新问题重新 inline(不继承旧身份)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    cleanRun(faux, {
      submit_resolution: [
        faux.assistant(
          faux.toolCall('submit_resolution', {
            status: 'fixed',
            reasoning: 'the guard is in place now',
            newIssue: {
              claim: 'the new guard also rejects negative divisors, which callers rely on',
              path: 'app.py',
              anchorText: 'return a + b',
              category: 'correctness',
              suspectedSeverity: 'medium',
            },
          }),
        ),
      ],
      // The new issue goes through the same verification chain (medium blocks -> refuter).
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
      submit_assessment: [
        faux.assistant(
          faux.toolCall('submit_assessment', {
            decision: 'accept',
            introducedByChange: true,
            reachable: true,
            actionable: true,
            changeRelation: 'introduced',
            severity: 'medium',
            confirmation: 'independently-verified',
            residualUncertainty: [],
          }),
        ),
      ],
    });
    const deps = gateDeps(
      faux,
      discussions,
      [{ findingId: uuidv7(), fingerprint: 'prior-fp-new-issue', claim: 'divide() must guard zero', anchorText: 'return a + b', path: 'app.py', lastSeenHeadSha: 'sha-prev' }],
      async () => new Set(['app.py']),
    );
    const outcome = await runReviewAndPublish(deps);

    // Old: resolved, leaves the gate.
    expect(outcome.resolvedFingerprints).toEqual(['prior-fp-new-issue']);
    expect(outcome.unresolvedPriorBlocking ?? []).toHaveLength(0);

    // New: appears as this round's finding, inline, without inheriting the old identity.
    const fresh = outcome.findings.find((f) => f.claim.includes('negative divisors'));
    expect(fresh).toBeDefined();
    expect(fresh!.placement).toBe('inline');
    expect(fresh!.matchedFindingId).toBeUndefined();
    expect(fresh!.incremental).not.toBe('persisted');
    expect(outcome.publishedInline).toBe(1);
  });

  // The zero-LLM prefilter's gap: a multi-file claim may be fixed in another file while the flagged file is untouched.
  it('门禁:flagged 文件没动,但 claim 提到的另一个文件动过 → 仍交 LLM', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    cleanRun(faux, { submit_resolution: [faux.assistant(faux.toolCall('submit_resolution', { status: 'fixed', reasoning: 'the lock moved into helper.py' }))] });
    const deps = gateDeps(
      faux,
      discussions,
      [
        {
          findingId: uuidv7(),
          fingerprint: 'prior-fp-crossfile',
          claim: 'add() in app.py races with the writer in helper.py',
          anchorText: 'return a + b',
          path: 'app.py',
          lastSeenHeadSha: 'sha-prev',
        },
      ],
      // app.py untouched, but helper.py named in the claim changed -> no zero-LLM shortcut.
      async () => new Set(['helper.py']),
    );
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.resolvedFingerprints).toEqual(['prior-fp-crossfile']);
    expect(discussions.reviewBatches[0]!.event).toBe('approve');
  });

  // Stale archival is the only path that retires a finding silently, so these cases pin the must-not-archive boundaries.
  describe('陈旧归档(§stale)', () => {
    const staleDeps = (
      faux: ReturnType<typeof createRoutingFauxAgent>,
      discussions: StubDiscussions,
      staleCandidates: ReviewOrchestratorDeps['staleCandidates'],
      changed: string[],
      priorBlockingFindings: ReviewOrchestratorDeps['priorBlockingFindings'] = [],
    ): ReviewOrchestratorDeps => ({
      ...gateDeps(faux, discussions, priorBlockingFindings, async () => new Set(changed)),
      ...(staleCandidates ? { staleCandidates } : {}),
    });

    it('连续多轮未复现 + 文件动过 → 归档', async () => {
      const discussions = new StubDiscussions();
      const faux = createRoutingFauxAgent();
      cleanRun(faux);
      const outcome = await runReviewAndPublish(
        staleDeps(faux, discussions, [{ findingId: 'f-stale', fingerprint: 'fp-stale', path: 'app.py', lastSeenHeadSha: 'sha-old' }], ['app.py']),
      );
      expect(outcome.staleFindingIds).toEqual(['f-stale']);
    });

    it('文件一行没动 → 不归档(代码没变,凭什么说它没了)', async () => {
      const discussions = new StubDiscussions();
      const faux = createRoutingFauxAgent();
      cleanRun(faux);
      const outcome = await runReviewAndPublish(
        staleDeps(faux, discussions, [{ findingId: 'f-stale', fingerprint: 'fp-stale', path: 'app.py', lastSeenHeadSha: 'sha-old' }], ['README.md']),
      );
      expect(outcome.staleFindingIds ?? []).toEqual([]);
    });

    it('缺 path 或缺基准 sha → 不归档(判不了就不动它)', async () => {
      const discussions = new StubDiscussions();
      const faux = createRoutingFauxAgent();
      cleanRun(faux);
      const outcome = await runReviewAndPublish(
        staleDeps(
          faux,
          discussions,
          [
            { findingId: 'f-nopath', fingerprint: 'fp-a', lastSeenHeadSha: 'sha-old' },
            { findingId: 'f-nosha', fingerprint: 'fp-b', path: 'app.py' },
          ],
          ['app.py'],
        ),
      );
      expect(outcome.staleFindingIds ?? []).toEqual([]);
    });

    // Still-blocking findings are never archived: the gate may only be opened by evidence.
    it('仍 blocking → 不归档', async () => {
      const discussions = new StubDiscussions();
      const faux = createRoutingFauxAgent();
      cleanRun(faux, { submit_resolution: [faux.assistant(faux.toolCall('submit_resolution', { status: 'still-present', reasoning: 'still there' }))] });
      const outcome = await runReviewAndPublish(
        staleDeps(
          faux,
          discussions,
          [{ findingId: 'f-blocking', fingerprint: 'fp-blocking', path: 'app.py', lastSeenHeadSha: 'sha-old' }],
          ['app.py'],
          [{ findingId: 'f-blocking', fingerprint: 'fp-blocking', claim: 'still broken', anchorText: 'return a + b', path: 'app.py', lastSeenHeadSha: 'sha-old' }],
        ),
      );
      expect(outcome.staleFindingIds ?? []).toEqual([]);
    });

    it('未注入候选(设置为 off)→ 一条都不归档', async () => {
      const discussions = new StubDiscussions();
      const faux = createRoutingFauxAgent();
      cleanRun(faux);
      const outcome = await runReviewAndPublish(staleDeps(faux, discussions, undefined, ['app.py']));
      expect(outcome.staleFindingIds).toBeUndefined();
    });
  });

  it('门禁:LLM 判仍未修 → 未修复那一行带上核验理由(作者才知道分歧在哪)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    cleanRun(faux, { submit_resolution: [faux.assistant(faux.toolCall('submit_resolution', { status: 'still-present', reasoning: 'the guard only covers the first argument' }))] });
    const deps = gateDeps(
      faux,
      discussions,
      [{ findingId: uuidv7(), fingerprint: 'prior-fp-4', claim: 'add() must reject non-numbers', anchorText: 'return a + b', path: 'app.py', lastSeenHeadSha: 'sha-prev' }],
      async () => new Set(['app.py']),
    );
    await runReviewAndPublish(deps);
    expect(discussions.reviewBatches[0]!.summary).toContain('app.py: add() must reject non-numbers — the guard only covers the first argument');
  });

  // Cross-round identity: the same defect moved to another file with a rewritten claim, so the strong fingerprint misses.
  // It must not be both re-reported as new and sent to reconciliation as an unreproduced prior blocking.
  it('跨轮身份:claim 重写 + 代码搬到别的文件 → 仍认得出是同一条,且不再挡两次门', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'sum is computed off by one', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const PRIOR_ID = uuidv7();
    // The matcher is an injectable strategy; this stubs "model says they match". Accuracy is covered by match.test.ts.
    let matcherCalls = 0;
    const deps: ReviewOrchestratorDeps = {
      ...gateDeps(faux, discussions, [
        // The prior blocking's file old/helper.py is gone from head; reconciliation would judge it not-applicable.
        { findingId: PRIOR_ID, fingerprint: 'prior-fp-moved', claim: 'off-by-one when adding', anchorText: 'return a + b', path: 'old/helper.py' },
      ]),
      priorFingerprints: new Set(['prior-fp-moved']),
      priorFindings: [
        { findingId: PRIOR_ID, fingerprint: 'prior-fp-moved', category: 'correctness', claim: 'off-by-one when adding', path: 'old/helper.py', codeWindow: 'return a + b' },
      ],
      findingMatcher: async (subjects) => {
        matcherCalls += 1;
        return new Map(subjects.map((s) => [s.id, { priorFindingId: PRIOR_ID, priorFingerprint: 'prior-fp-moved', method: 'llm' as const }]));
      },
    };

    const outcome = await runReviewAndPublish(deps);
    expect(matcherCalls).toBe(1); // Judged once per batch, not per finding.
    expect(outcome.findings[0]!.incremental).toBe('persisted'); // Matched even though fingerprint and path both differ.
    expect(outcome.findings[0]!.matchedFindingId).toBe(PRIOR_ID);
    expect(outcome.publishedInline).toBe(0); // A recurrence does not repeat the inline.
    // The prior one must not be sent to reconciliation, or it would block the gate a second time.
    expect(outcome.unresolvedPriorBlocking ?? []).toHaveLength(0);
    expect(discussions.reviewBatches[0]!.summary).toContain('Previously reported');
  });

  // Attribution re-judged: only issues introduced by this change block. Last round introduced, this round preexisting:
  // it must leave the gate and not be reconciled back into blockingCount as still-present.
  // No submit_resolution response: entering reconciliation fails loudly.
  it('归因改判为 preexisting → 历史 blocking 从门禁上下来,照常呈现并 approve', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'sum is computed off by one', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      // Exploration guessed introduced; verification re-judges preexisting-relevant (attribution is verification's conclusion).
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: false, reachable: true, actionable: true, changeRelation: 'preexisting-relevant', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const PRIOR_ID = uuidv7();
    const deps: ReviewOrchestratorDeps = {
      ...gateDeps(faux, discussions, [
        { findingId: PRIOR_ID, fingerprint: 'prior-fp-reattributed', claim: 'off-by-one when adding', anchorText: 'return a + b', path: 'app.py' },
      ]),
      priorFindings: [
        { findingId: PRIOR_ID, fingerprint: 'prior-fp-reattributed', category: 'correctness', claim: 'off-by-one when adding', path: 'app.py', codeWindow: 'return a + b' },
      ],
      findingMatcher: async (subjects) =>
        new Map(subjects.map((s) => [s.id, { priorFindingId: PRIOR_ID, priorFingerprint: 'prior-fp-reattributed', method: 'llm' as const }])),
    };

    const outcome = await runReviewAndPublish(deps);
    // Still confirmed, just not blocking.
    expect(outcome.findings[0]!.decision.status).toBe('confirmed');
    expect(outcome.findings[0]!.decision.blocking).toBe(false);
    expect(outcome.unresolvedPriorBlocking ?? []).toHaveLength(0);
    expect(discussions.reviewBatches[0]!.event).toBe('approve');
  });

  // Same shape + `reviews.block_preexisting: true`: preexisting blocks again, still adjudicated this round (no duplicate reconciliation).
  it('block_preexisting=true → 归因为 preexisting 也阻断,不 approve', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'sum is computed off by one', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: false, reachable: true, actionable: true, changeRelation: 'preexisting-relevant', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const PRIOR_ID = uuidv7();
    const deps: ReviewOrchestratorDeps = {
      ...gateDeps(faux, discussions, [
        { findingId: PRIOR_ID, fingerprint: 'prior-fp-legacy', claim: 'off-by-one when adding', anchorText: 'return a + b', path: 'app.py' },
      ]),
      blockPreexisting: true,
      priorFindings: [
        { findingId: PRIOR_ID, fingerprint: 'prior-fp-legacy', category: 'correctness', claim: 'off-by-one when adding', path: 'app.py', codeWindow: 'return a + b' },
      ],
      findingMatcher: async (subjects) =>
        new Map(subjects.map((s) => [s.id, { priorFindingId: PRIOR_ID, priorFingerprint: 'prior-fp-legacy', method: 'llm' as const }])),
    };

    const outcome = await runReviewAndPublish(deps);
    expect(outcome.findings[0]!.decision.blocking).toBe(true);
    // This round's blocking already adjudicated the prior item -> not reconciled again.
    expect(outcome.unresolvedPriorBlocking ?? []).toHaveLength(0);
    expect(discussions.reviewBatches.some((b) => b.event === 'approve')).toBe(false);
  });

  it('report_preexisting_unrelated=off → 抑制历史无关 finding(§37)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'ok' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'preexisting bug unrelated to change', category: 'correctness', suspectedSeverity: 'medium', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'preexisting-unrelated' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: false, reachable: true, actionable: true, changeRelation: 'preexisting-unrelated', severity: 'medium', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source,
      model: faux.model,
      streamFn: faux.streamFn,
      bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 },
      newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      reportPreexistingUnrelated: 'off',
    };
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.findings[0]!.suppressed).toBe(true);
    expect(outcome.findings[0]!.suppressReason).toBe('unrelated');
    expect(outcome.publishedInline).toBe(0);
    // All suppressed -> no blocking -> auto-approve with 0 comments and no top-level comment.
    expect(discussions.reviewBatches).toHaveLength(1);
    expect(discussions.reviewBatches[0]!.event).toBe('approve');
    expect(discussions.reviewBatches[0]!.comments).toHaveLength(0);
    expect(discussions.topLevel).toHaveLength(0);
  });

  it('增量(§24):指纹命中上批 → persisted,不重复 inline,折叠进 Previously reported', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source,
      model: faux.model,
      streamFn: faux.streamFn,
      bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 },
      newId: () => uuidv7(),
      changeSummary: 'change add()',
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      computeFingerprint: () => 'fp-persist', // Matches the previous batch's fingerprint.
      priorFingerprints: new Set(['fp-persist']),
    };

    const outcome = await runReviewAndPublish(deps);
    expect(outcome.findings[0]!.incremental).toBe('persisted');
    expect(outcome.publishedInline).toBe(0); // A recurrence does not repeat the inline.
    // Blocking (including persisted unresolved) -> a visible review even with 0 new inline;
    // the Previously reported section is in the review body.
    expect(discussions.reviewBatches).toHaveLength(1);
    expect(discussions.reviewBatches[0]!.event).toBe('request-changes');
    expect(discussions.reviewBatches[0]!.comments).toHaveLength(0);
    expect(discussions.reviewBatches[0]!.summary).toContain('Previously reported');
  });

  it('§25.2 可提交建议:校验通过 → 渲染 ```suggestion 且锚点扩到建议范围;行号对不上 → 只发 finding', async () => {
    // Line 2 of app.py is `    return a + b` (see beforeAll).
    const withSuggestion = (suggestion: unknown) => ({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [
        faux.assistant(
          faux.toolCall('submit_assessment', {
            decision: 'accept', introducedByChange: true, reachable: true, actionable: true,
            changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [],
            suggestion,
          }),
        ),
      ],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    let faux = createRoutingFauxAgent();
    const run = async (suggestion: unknown) => {
      const discussions = new StubDiscussions();
      faux = createRoutingFauxAgent();
      faux.setStageResponses(withSuggestion(suggestion) as never);
      const outcome = await runReviewAndPublish({
        source, model: faux.model, streamFn: faux.streamFn, bundles,
        budget: { maxTurns: 8, maxToolCalls: 16 },
        newId: () => uuidv7(),
        changeSummary: 'change add()',
        readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
        isChangedLine: () => true,
        publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
        publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
        noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      });
      return { outcome, batch: discussions.reviewBatches[0] };
    };

    // (1) originalText matches head verbatim -> suggestion rendered.
    const okRun = await run({ startLine: 2, endLine: 2, originalText: '    return a + b', replacement: '    return a + b + 0' });
    expect(okRun.batch?.comments[0]!.body).toContain('```suggestion');
    expect(okRun.outcome.suggestions?.published).toBe(1);

    // (2) Line mismatch -> suggestion dropped, the finding is still published.
    const badRun = await run({ startLine: 2, endLine: 2, originalText: 'def add(a, b):', replacement: 'def add(a, b, c):' });
    expect(badRun.batch?.comments).toHaveLength(1);
    expect(badRun.batch?.comments[0]!.body).not.toContain('```suggestion');
    expect(badRun.outcome.suggestions?.rejected['text-mismatch']).toBe(1);
  });

  it('§44 Phase 0:分阶段用量拆分忠实(各段之和 = 总量;verify 单列)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const outcome = await runReviewAndPublish({
      source,
      model: faux.model,
      streamFn: faux.streamFn,
      bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 },
      newId: () => uuidv7(),
      changeSummary: 'change add()',
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
    });
    // The faux model emits no usage -> totals and per-stage breakdown are both absent (not zero rows).
    // Contract: with usage, the breakdown exists and sums up; without, both are absent.
    if (outcome.usage === undefined) {
      expect(outcome.stageUsage).toBeUndefined();
      return;
    }
    const stages = Object.values(outcome.stageUsage ?? {});
    expect(stages.length).toBeGreaterThan(0);
    const summed = stages.reduce((a, b) => a + b.costUsd, 0);
    expect(summed).toBeCloseTo(outcome.usage.costUsd, 6);
  });

  it('§26.4 已忽略指纹 → 整体抑制:不 inline、不落 findings、不进门禁,只在折叠段留痕', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source,
      model: faux.model,
      streamFn: faux.streamFn,
      bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 },
      newId: () => uuidv7(),
      changeSummary: 'change add()',
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      // Neither strong nor weak fingerprint matches (rewording and new anchor text);
      // only same file + same category + similar claim can match.
      computeFingerprint: () => 'fp-this-round-wording',
      computeWeakFingerprint: () => 'weak-this-round-anchor',
      dismissedFindings: [
        {
          fingerprint: 'fp-some-earlier-wording',
          weakFingerprint: 'weak-some-earlier-anchor',
          category: 'correctness',
          path: 'app.py',
          claim: 'off by one in the add function', // Different wording, same root cause as 'off-by-one in add'.
        },
      ],
    };

    const outcome = await runReviewAndPublish(deps);
    // Suppressed findings are not persisted, so they never re-enter the gate or the fix target set.
    expect(outcome.findings[0]!.suppressed).toBe(true);
    expect(outcome.findings[0]!.suppressReason).toBe('dismissed');
    expect(outcome.publishedInline).toBe(0);
    expect(discussions.reviewBatches[0]?.comments ?? []).toHaveLength(0);
  });

  it('auto_approve=false → 无 blocking 也不 approve(兜底 comment)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'ok' }] }] }))],
      complete_section: [faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }))],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      autoApprove: false,
    };
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.candidateCount).toBe(0);
    // autoApprove=false: no approve; no inline and no description -> fallback top-level summary.
    expect(discussions.reviewBatches).toHaveLength(0);
    expect(discussions.topLevel).toHaveLength(1);
    expect(discussions.topLevel[0]!.body).toContain('Actionable comments posted: 0');
  });

  it('merge_gate 启用 + blocking → review event=request-changes', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'none' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
    };
    const outcome = await runReviewAndPublish(deps);
    expect(outcome.findings[0]!.decision.blocking).toBe(true);
    expect(discussions.reviewBatches).toHaveLength(1);
    expect(discussions.reviewBatches[0]!.event).toBe('request-changes');
  });

  it('探索未完成门禁:map 不 finalize(模型/网关故障)→ 抛 ReviewIncompleteError,不发布 approve', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    // submit_plan stage only replies with text, never calls the tool -> map does not finalize.
    faux.setStageResponses({ submit_plan: [faux.assistant('gateway error, no tool call')] });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 3, maxToolCalls: 6 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
    };
    const err = await runReviewAndPublish(deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewIncompleteError);
    // A model/gateway failure is not a wall-clock cut: it must stay retryable.
    expect((err as ReviewIncompleteError).deadlineCut).toBeUndefined();
    // No review is published (in particular no approve).
    expect(discussions.reviewBatches).toHaveLength(0);
    expect(discussions.topLevel).toHaveLength(0);
  });

  it('map 完成、全部 dig 因模型冷却失败 → ReviewIncompleteError 带 dig 的 failureKind(job 才走模型档退避)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    const cooldown = faux.assistant('', {
      stopReason: 'error',
      errorMessage: '429 {"code":"model_cooldown","message":"All credentials for model gpt-6-luna are cooling down","reset_seconds":8163}',
    });
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [cooldown, cooldown, cooldown],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 3, maxToolCalls: 6 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
    };
    const err = await runReviewAndPublish(deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewIncompleteError);
    expect((err as ReviewIncompleteError).failureKind).toBe('model_unavailable');
    expect((err as ReviewIncompleteError).failureDetail).toContain('model_cooldown');
    expect(discussions.reviewBatches).toHaveLength(0);
  });

  // Stage-deadline degradation: if candidates were already submitted, continue with them instead of failing the run,
  // but incomplete coverage must not approve.
  // Each file read costs 200ms on an injected clock (no real sleep) and the dig budget is 300ms:
  // the candidate is submitted at t=200, the next read moves the clock to t=400 and aborts the
  // stage signal, so the finishing tool is never called -> scope incomplete, candidate in hand.
  const slowSource = (clock: ManualClock): ReviewOrchestratorDeps['source'] =>
    // Inherit from the provider instance: a spread would drop its prototype methods (listChangedFiles).
    Object.assign(Object.create(source) as ReviewOrchestratorDeps['source'], {
      readFile: async (p: string) => { clock.advance(200); return source.readFile(p); },
    });

  it('dig 墙钟到点 + 0 scope 完成但有候选 → 不抛错,候选照常验证发布,且**不 approve**', async () => {
    const discussions = new StubDiscussions();
    const clock = createManualClock();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('read_source', { path: 'app.py' })),
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'low', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('read_source', { path: 'app.py' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      // Verification rejects -> no blocking, so the event would approve; coverage must stop it.
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'reject', introducedByChange: false, reachable: false, actionable: false, changeRelation: 'introduced', severity: 'low', confirmation: 'unverified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source: slowSource(clock), model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
      digConcurrency: 1,
      stageBudgetMs: { dig: 300 },
      stageClock: clock,
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.coverage).toEqual({ scopesTotal: 1, scopesComplete: 0 });
    expect(outcome.candidateCount).toBe(1);
    // Must not throw: the candidate is carried out and verified. With 0 findings no empty comment is posted;
    // the gap is expressed via the `review-health` check and by never approving.
    expect(discussions.reviewBatches.some((b) => b.event === 'approve')).toBe(false);
  });

  it('dig 墙钟到点 + 一个候选都没有 → 仍抛 ReviewIncompleteError(「干净」与「没跑成」在证据上分不开)', async () => {
    const discussions = new StubDiscussions();
    const clock = createManualClock();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('read_source', { path: 'app.py' })),
        faux.assistant(faux.toolCall('read_source', { path: 'app.py' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
    });
    const deps: ReviewOrchestratorDeps = {
      source: slowSource(clock), model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
      digConcurrency: 1,
      stageBudgetMs: { dig: 300 },
      stageClock: clock,
    };

    // deadlineCut marks it terminal for classifyJobError: a retry burns the same wall clock again.
    await expect(runReviewAndPublish(deps)).rejects.toMatchObject({
      name: 'ReviewIncompleteError',
      message: expect.stringMatching(/阶段墙钟到点/),
      deadlineCut: true,
    });
    expect(discussions.reviewBatches).toHaveLength(0);
  });

  // Approve uses PR-level coverage across rounds, not this round's scopesComplete/scopesTotal.
  it('map 规划到了但没跑到的文件 → 不 approve(缺口不进正文)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      // Both scopes are planned (files given), but the second one did not finish (blocked).
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [
        { title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }], files: ['app.py'] },
        { title: 'rest', changeSummary: 'rest', obligations: [{ kind: 'correctness', description: 'rest correct' }], files: ['planned_a.py', 'planned_b.py'] },
      ] }))],
      complete_section: [
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
        faux.assistant(faux.toolCall('complete_section', { status: 'blocked', exploredEntities: [] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'x' }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
      botMention: '@winnowl',
      digConcurrency: 1, // Consume the complete_section queue in order so scopes map 1:1 to statuses.
      // The ledger says all three are uncovered; map planned all three, only the app.py scope finished.
      uncoveredPaths: ['app.py', 'planned_a.py', 'planned_b.py'],
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.coverage).toEqual({ scopesTotal: 2, scopesComplete: 1 });
    expect(outcome.coveredPaths).toEqual(['app.py']);
    expect(outcome.unreachedPaths).toEqual(['planned_a.py', 'planned_b.py']);
    expect(outcome.unplannedPaths).toEqual([]);
    // The gap is not in the PR body, but must never approve.
    expect(discussions.reviewBatches.some((b) => b.event === 'approve')).toBe(false);
    for (const b of discussions.reviewBatches) expect(b.summary ?? '').not.toContain('planned_a.py');
  });

  it('账本说这个 PR 已经全覆盖 → 照常 approve', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }], files: ['app.py'] }] }))],
      complete_section: [faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
      uncoveredPaths: ['app.py'],
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.unreachedPaths).toEqual([]);
    expect(outcome.unplannedPaths).toEqual([]);
    expect(discussions.reviewBatches[0]!.event).toBe('approve');
  });

  // `ReviewScope.files` is optional in the schema; when map gives none, coverage is unknown, not empty.
  // Fall back to per-round coverage, otherwise no PR could ever approve.
  it('map 一条 files 都没给 → 账本这一轮用不上,退回单轮口径(否则永不 approve)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      // Deliberately no files.
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
      uncoveredPaths: ['app.py'],
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.coveredPaths).toBeUndefined();
    // Both gap fields absent = "ledger unused this round", not "confirmed no gap".
    expect(outcome.unreachedPaths).toBeUndefined();
    expect(outcome.unplannedPaths).toBeUndefined();
    // Per-round coverage is full (1/1) -> approve.
    expect(outcome.coverage).toEqual({ scopesTotal: 1, scopesComplete: 1 });
    expect(discussions.reviewBatches[0]!.event).toBe('approve');
  });

  // Changed files claimed by no scope block approve. Generated code is split off before map and engine backfills
  // scopes map missed, so what reaches here is genuinely unreviewed.
  it('没被任何 scope 认领的文件 → 不 approve,清单不进 PR 正文', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }], files: ['app.py'] }] }))],
      complete_section: [faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
      uncoveredPaths: ['app.py', 'pnpm-lock.yaml'],
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.unreachedPaths).toEqual([]);
    expect(outcome.unplannedPaths).toEqual(['pnpm-lock.yaml']);
    expect(discussions.reviewBatches.every((b) => b.event !== 'approve')).toBe(true);
    // Their list and cause stay out of the PR body (internal vocabulary);
    // only logs, console and the check summary (counts) carry them.
    const summary = discussions.reviewBatches[0]?.summary ?? '';
    expect(summary).not.toContain('pnpm-lock.yaml');
    expect(summary.toLowerCase()).not.toContain('scope');
  });

  // Cooperative cancellation: a new head arrives -> the in-flight review stops early and does not publish the old head's result.
  it('取消发生在 dig 之前 → 跳过剩余探索,不抛 ReviewIncompleteError(取消≠模型故障),零发布', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }))],
    });
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: CR_ID, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
      isCancelled: () => true,
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.cancelled).toBe(true);
    // Cancellation is checked before Map, so no scope is planned or run and the
    // incomplete-review gate cannot retry a superseded head.
    expect(outcome.coverage).toEqual({ scopesTotal: 0, scopesComplete: 0 });
    expect(outcome.publishedInline).toBe(0);
    expect(discussions.reviewBatches).toHaveLength(0);
    expect(discussions.topLevel).toHaveLength(0);
  });

  it('取消发生在 verify 之前 → 候选不验证、不发布(verify 是最贵扇出)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    let verifyCalls = 0;
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'off-by-one in add', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'no cross-scope issues' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    // Exploration finishes and yields a candidate; cancellation happens at the dedup gate before verify.
    let cancelled = false;
    const cancelCrId = uuidv7(); // CR owned by this case so publication_records assertions are isolated.
    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => {
        verifyCalls += 1; // Anchor source is read after verify in stageOne, so a call means verify was not blocked.
        return (await source.readFile(p))?.split('\n') ?? [];
      },
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: cancelCrId, revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
      dedupStrategy: { kind: 'incremental', isDuplicate: () => { cancelled = true; return false; } },
      isCancelled: () => cancelled,
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.cancelled).toBe(true);
    expect(outcome.candidateCount).toBe(1);
    expect(verifyCalls).toBe(0); // No verify/refute ran for it.
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.publishedInline).toBe(0);
    expect(discussions.reviewBatches).toHaveLength(0);
    expect(await db.selectFrom('publication_records').select('id').where('change_request_id', '=', cancelCrId).executeTakeFirst()).toBeUndefined();
  });

  // Matrix "do not publish" findings: refuted-as-false is not presented at all; unverified goes to low-evidence
  // and is excluded from fix instructions.
  it('verifier 判为假 → 整条不发布(不进折叠区、不进 agent 指令、不落 findings)', async () => {
    const discussions = new StubDiscussions();
    const stageResponses = (f: ReturnType<typeof createRoutingFauxAgent>) => ({
      submit_plan: [f.assistant(f.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        f.assistant(f.toolCall('submit_finding', { claim: 'add() returns the difference', category: 'correctness', suspectedSeverity: 'high', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        f.assistant(f.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [f.assistant(f.toolCall('submit_summary', { note: 'no cross-scope issues' }))],
      // Independent verification read the code and concluded it does not hold.
      submit_assessment: [f.assistant(f.toolCall('submit_assessment', { decision: 'reject', introducedByChange: false, reachable: false, actionable: false, changeRelation: 'unknown', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [f.assistant(f.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const faux = createRoutingFauxAgent();
    faux.setStageResponses(stageResponses(faux));

    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]!.suppressed).toBe(true); // Not presented, not persisted.
    expect(outcome.findings[0]!.suppressReason).toBe('not-confirmed');
    expect(outcome.publishedInline).toBe(0);
    const summary = discussions.reviewBatches[0]?.summary ?? '';
    expect(summary).toContain('Actionable comments posted: 0');
    expect(summary).not.toContain('Additional findings from this change');
    expect(summary).not.toContain('address this finding'); // The aggregated prompt section must be absent.
    // The suppressed section is hidden by default (`publication.show_suppressed_details`, default false).
    expect(summary).not.toContain('Suppressed and duplicate diagnostics');

    // Enabled -> visible. faux stage replies are single-use, so the second run uses a fresh one.
    const audit = new StubDiscussions();
    const faux2 = createRoutingFauxAgent();
    faux2.setStageResponses(stageResponses(faux2));
    const auditOutcome = await runReviewAndPublish({
      ...deps,
      model: faux2.model,
      streamFn: faux2.streamFn,
      showSuppressedDetails: true,
      publishContext: { ...deps.publishContext, discussions: audit },
      publishTarget: { ...deps.publishTarget, changeRequestId: uuidv7(), revisionId: uuidv7() },
    });
    expect(auditOutcome.findings[0]!.suppressed).toBe(true);
    expect(audit.reviewBatches[0]?.summary ?? '').toContain('Suppressed and duplicate diagnostics');
  });

  it('没验成(未达确认门槛)→ 低证据区,不进「其他 finding」也不进 agent 指令', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'add() may overflow on large inputs', category: 'correctness', suspectedSeverity: 'medium', path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'no cross-scope issues' }))],
      // accept, but medium needs independently-verified; code-supported falls short.
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'medium', confirmation: 'code-supported', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });

    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.findings[0]!.decision.status).toBe('uncertain');
    expect(outcome.findings[0]!.suppressed).toBeUndefined(); // Presented, but not as a conclusion.
    expect(outcome.publishedInline).toBe(0);
    const summary = discussions.reviewBatches[0]?.summary ?? '';
    expect(summary).toContain('Unconfirmed leads');
    expect(summary).toContain('add() may overflow on large inputs');
    expect(summary).not.toContain('Additional findings from this change'); // Not mixed into the confirmed findings.
    expect(summary).not.toContain('address this finding'); // Unconfirmed findings are excluded from fix instructions.
    expect(summary).not.toMatch(/🟡 \*\*Medium\*\* add\(\) may overflow/); // No severity badge.
  });

  it('模型编出来的路径不进聚合 Prompt(head 读不到 → 只留 claim,不指错文件)', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    // The model wrote an uncertain path `apps/worker/src/domain?` that does not exist in head.
    const bogusPath = 'apps/worker/src/domain?';
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [
        faux.assistant(faux.toolCall('submit_finding', { claim: 'per-memo budget is not enforced', category: 'correctness', suspectedSeverity: 'high', path: bogusPath, primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'no cross-scope issues' }))],
      submit_assessment: [faux.assistant(faux.toolCall('submit_assessment', { decision: 'accept', introducedByChange: true, reachable: true, actionable: true, changeRelation: 'introduced', severity: 'high', confirmation: 'independently-verified', residualUncertainty: [] }))],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });

    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
    };

    const outcome = await runReviewAndPublish(deps);

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]!.pathExists).toBe(false);
    expect(outcome.publishedInline).toBe(0); // Cannot anchor: folded into the summary.
    const summary = discussions.reviewBatches[0]?.summary ?? '';
    // The finding is kept, but the bogus path must not reach the agent instructions.
    expect(summary).toContain('per-memo budget is not enforced');
    expect(summary).not.toContain(bogusPath);
    expect(summary).toContain('Somewhere in the code under review, address this finding:');
  });

  // Files skipped incrementally are not reviewed, so their prior findings cannot recur;
  // carry them over or they vanish from the summary and agent instructions.
  it('增量跳过的文件上的历史 finding 并入「此前已报」;被忽略的不带', async () => {
    const discussions = new StubDiscussions();
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [faux.assistant(faux.toolCall('submit_plan', { scopes: [{ title: 'add()', changeSummary: 'add', obligations: [{ kind: 'correctness', description: 'sum correct' }] }] }))],
      complete_section: [faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] }))],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'no cross-scope issues' }))],
    });
    const carried = (claim: string, path: string) => ({
      findingId: uuidv7(), fingerprint: uuidv7(), category: 'correctness', claim, severity: 'medium', path, line: 3,
    });

    const deps: ReviewOrchestratorDeps = {
      source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 8, maxToolCalls: 16 }, newId: () => uuidv7(),
      readHeadLines: async (p) => (await source.readFile(p))?.split('\n') ?? [],
      isChangedLine: () => true,
      publishContext: { db, discussions, fetchCurrentHeadSha: async () => HEAD },
      publishTarget: { tenantId: TENANT, repositoryId: REPO, changeRequest: CHANGE_REQUEST, changeRequestId: uuidv7(), revisionId: uuidv7(), revisionSha: HEAD, providerHostId: HOST, expectedHeadSha: HEAD },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 }, profile: resolveProfile('balanced'),
      carriedFindings: [
        carried('expired cache entries are never evicted', 'cache.js'),
        carried('pad throws on negative width', 'format.js'),
      ],
      dismissedFindings: [{ fingerprint: 'other', category: 'correctness', claim: 'pad throws on negative width', path: 'format.js' }],
    };

    await runReviewAndPublish(deps);

    const summary = discussions.reviewBatches[0]?.summary ?? '';
    expect(summary).toContain('expired cache entries are never evicted');
    expect(summary).toContain('Review comments at @cache.js:\n- Around line 3: ');
    expect(summary).not.toContain('pad throws on negative width');
  });
});
