import { describe, expect, it } from 'vitest';
import { createRoutingFauxAgent, type SourceProvider } from '@reviewbot/agent-pi';
import type { PromptBundle } from '@reviewbot/prompts';
import {
  produceReview,
  publishReview,
  type ProducedReview,
  type ReviewOrchestratorDeps,
} from '../src/orchestrator.js';

const bundle = (role: string): PromptBundle => ({
  role,
  system: role,
  task: role,
  version: 1,
  digest: role,
});
const bundles = {
  mapper: bundle('mapper'),
  reviewer: bundle('reviewer'),
  synthesizer: bundle('synthesizer'),
  verifier: bundle('verifier'),
  refuter: bundle('refuter'),
};

describe('incremental review verification', () => {
  it('does not verify a candidate anchored in an unchanged prior-review file', async () => {
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [
        faux.assistant(
          faux.toolCall('submit_plan', {
            scopes: [
              {
                title: 'delta',
                changeSummary: 'delta',
                obligations: [{ kind: 'correctness', description: 'check delta' }],
                files: ['new.ts'],
              },
            ],
          }),
        ),
      ],
      complete_section: [
        faux.assistant(
          faux.toolCall('submit_finding', {
            claim: 'old defect',
            category: 'correctness',
            suspectedSeverity: 'high',
            path: './dir/old.ts',
            primaryAnchorText: 'old();',
            changeRelationHypothesis: 'introduced',
          }),
        ),
        faux.assistant(
          faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['new.ts'] }),
        ),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'done' }))],
      // No verifier response is provided: reaching verification would fail this test.
    });
    const source: SourceProvider = {
      listChangedFiles: async () => [{ path: 'new.ts', status: 'modified' }],
      readFile: async (path) => (path.includes('old.ts') ? 'old();\n' : 'new();\n'),
      searchCode: async () => [],
    };
    const deps: ReviewOrchestratorDeps = {
      source,
      model: faux.model,
      streamFn: faux.streamFn,
      bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 },
      newId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
      priorReviewedPaths: ['dir\\old.ts'],
      readHeadLines: async (path) => (await source.readFile(path))?.split('\n') ?? [],
      isChangedLine: () => true,
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      publishContext: {} as ReviewOrchestratorDeps['publishContext'],
      publishTarget: {
        tenantId: '',
        repositoryId: '',
        changeRequestId: '',
        revisionId: '',
        revisionSha: '',
        providerHostId: '',
        expectedHeadSha: '',
        changeRequest: { id: '', repositoryId: '', nativeId: '', number: 1, kind: 'pull-request' },
      },
    };

    const produced = await produceReview(deps);

    expect(produced.ledger.candidates).toHaveLength(1);
    expect(produced.staged).toHaveLength(0);
  });

  it('does not cover a file whose candidate did not reach verification', async () => {
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_plan: [
        faux.assistant(
          faux.toolCall('submit_plan', {
            scopes: [
              {
                title: 'delta',
                changeSummary: 'delta',
                obligations: [{ kind: 'correctness', description: 'check delta' }],
                files: ['new.ts'],
              },
            ],
          }),
        ),
      ],
      complete_section: [
        faux.assistant(
          faux.toolCall('submit_finding', {
            claim: 'new defect',
            category: 'correctness',
            suspectedSeverity: 'high',
            path: './new.ts',
            primaryAnchorText: 'new();',
            changeRelationHypothesis: 'introduced',
          }),
        ),
        faux.assistant(
          faux.toolCall('complete_section', {
            status: 'complete',
            exploredEntities: ['./new.ts'],
          }),
        ),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'done' }))],
    });
    const source: SourceProvider = {
      listChangedFiles: async () => [{ path: 'new.ts', status: 'modified' }],
      readFile: async () => 'new();\n',
      searchCode: async () => [],
    };
    const deps: ReviewOrchestratorDeps = {
      source,
      model: faux.model,
      streamFn: faux.streamFn,
      bundles,
      budget: { maxTurns: 8, maxToolCalls: 16 },
      newId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
      reviewFileStates: [{ path: 'new.ts', materialDigest: 'a'.repeat(64) }],
      reviewContractDigest: 'b'.repeat(64),
      dedupStrategy: {
        kind: 'batch',
        dedupe: async (candidates) => new Set(candidates.map((candidate) => candidate.id)),
      },
      readHeadLines: async () => ['new();'],
      isChangedLine: () => true,
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      publishContext: {} as ReviewOrchestratorDeps['publishContext'],
      publishTarget: {
        tenantId: '',
        repositoryId: '',
        changeRequestId: '',
        revisionId: '',
        revisionSha: '',
        providerHostId: '',
        expectedHeadSha: '',
        changeRequest: { id: '', repositoryId: '', nativeId: '', number: 1, kind: 'pull-request' },
      },
    };

    const produced = await produceReview(deps);

    expect(produced.ledger.candidates[0]?.path).toBe('new.ts');
    expect(produced.staged).toHaveLength(0);
  });

  it('does not approve when cross-scope synthesis hits its deadline', async () => {
    let descriptionUpdates = 0;
    const produced: ProducedReview = {
      staged: [],
      ledger: {
        scopes: [
          { id: 'one', title: 'one', changeSummary: 'one', obligations: [] },
          { id: 'two', title: 'two', changeSummary: 'two', obligations: [] },
        ],
        scopeOutcomes: [
          { scopeId: 'one', status: 'complete', candidateIds: [], exploredEntities: [] },
          { scopeId: 'two', status: 'complete', candidateIds: [], exploredEntities: [] },
        ],
        candidates: [],
        mapStatus: 'complete',
        coverage: { scopesTotal: 2, scopesComplete: 2 },
        deadlineCutStages: ['synthesis'],
      },
    };
    const deps = {
      source: {
        listChangedFiles: async () => [],
        readFile: async () => undefined,
        searchCode: async () => [],
      },
      model: { id: 'test' },
      bundles,
      updateSummaryDescription: async () => {
        descriptionUpdates += 1;
      },
      publishContext: {},
      publishTarget: {
        tenantId: '',
        repositoryId: '',
        changeRequestId: '',
        revisionId: '',
        revisionSha: '',
        providerHostId: '',
        expectedHeadSha: '',
        changeRequest: { id: '', repositoryId: '', nativeId: '', number: 1, kind: 'pull-request' },
      },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      newId: () => 'id',
    } as unknown as ReviewOrchestratorDeps;

    const outcome = await publishReview(produced, deps);

    expect(descriptionUpdates).toBe(1);
    expect(outcome.publishedInline).toBe(0);
  });

  it.each([
    { name: 'synthesis is incomplete', ledger: { synthesisStatus: 'incomplete' as const } },
    { name: 'exploration is cost capped', ledger: { costCappedScopes: 1 } },
  ])('does not approve when $name', async ({ ledger: partialLedger }) => {
    let descriptionUpdates = 0;
    const produced: ProducedReview = {
      staged: [],
      ledger: {
        scopes: [],
        scopeOutcomes: [],
        candidates: [],
        mapStatus: 'complete',
        coverage: { scopesTotal: 0, scopesComplete: 0 },
        ...partialLedger,
      },
    };
    const deps = {
      source: {
        listChangedFiles: async () => [],
        readFile: async () => undefined,
        searchCode: async () => [],
      },
      model: { id: 'test' },
      bundles,
      updateSummaryDescription: async () => {
        descriptionUpdates += 1;
      },
      publishContext: {},
      publishTarget: {
        tenantId: '',
        repositoryId: '',
        changeRequestId: '',
        revisionId: '',
        revisionSha: '',
        providerHostId: '',
        expectedHeadSha: '',
        changeRequest: { id: '', repositoryId: '', nativeId: '', number: 1, kind: 'pull-request' },
      },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      newId: () => 'id',
    } as unknown as ReviewOrchestratorDeps;
    const outcome = await publishReview(produced, deps);
    expect(descriptionUpdates).toBe(1);
    expect(outcome.publishedInline).toBe(0);
  });

  it('rechecks cancellation after finding matching and before provider writes', async () => {
    let cancelled = false;
    let descriptionUpdates = 0;
    const candidate = {
      id: 'candidate',
      source: 'dig' as const,
      claim: 'claim',
      category: 'correctness',
      suspectedSeverity: 'high',
      path: 'new.ts',
      primaryAnchorText: 'new();',
      changeRelationHypothesis: 'introduced',
    };
    const produced = {
      staged: [
        {
          candidate,
          verdict: {
            candidateId: candidate.id,
            decision: 'accept',
            introducedByChange: true,
            reachable: true,
            actionable: true,
            changeRelation: 'introduced',
            severity: 'high',
            confirmation: 'independently-verified',
            residualUncertainty: [],
            incomplete: false,
          },
          decision: { status: 'confirmed', kind: 'defect', placement: 'folded', blocking: true },
          rank: 100,
          pathExists: true,
        },
      ],
      ledger: {
        scopes: [],
        scopeOutcomes: [],
        candidates: [candidate],
        mapStatus: 'complete',
        coverage: { scopesTotal: 0, scopesComplete: 0 },
      },
    } as unknown as ProducedReview;
    const deps = {
      model: { id: 'test' },
      bundles,
      // The contract digest must be set, otherwise "not carried back" would be trivially true.
      reviewContractDigest: 'a'.repeat(64),
      priorFindings: [{ findingId: 'prior', category: 'correctness', claim: 'old' }],
      findingMatcher: async () => {
        cancelled = true;
        return new Map();
      },
      isCancelled: () => cancelled,
      updateSummaryDescription: async () => {
        descriptionUpdates += 1;
      },
      publishContext: {},
      publishTarget: {
        tenantId: '',
        repositoryId: '',
        changeRequestId: '',
        revisionId: '',
        revisionSha: '',
        providerHostId: '',
        expectedHeadSha: '',
        changeRequest: { id: '', repositoryId: '', nativeId: '', number: 1, kind: 'pull-request' },
      },
      noiseBudget: { maxInlineComments: 8, maxInlinePerFile: 3, maxInlineNits: 3 },
      newId: () => 'id',
    } as unknown as ReviewOrchestratorDeps;

    const outcome = await publishReview(produced, deps);

    expect(outcome.cancelled).toBe(true);
    expect(descriptionUpdates).toBe(0);
    // A cancelled run must not hand back the coverage ledger (coveredFiles/reviewContractDigest):
    // the next round would skip those files as already reviewed although they never produced a result.
    expect(outcome.coveredFiles).toBeUndefined();
    expect(outcome.reviewContractDigest).toBeUndefined();
  });
});
