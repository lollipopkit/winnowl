import { describe, expect, it } from 'vitest';
import type { PromptBundle } from '@reviewbot/prompts';
import {
  publishReview,
  type ProducedReview,
  type ReviewOrchestratorDeps,
} from '../src/orchestrator.js';
import { sectionCoverage } from '../src/coverage.js';

const bundle = (role: string): PromptBundle => ({
  role,
  system: role,
  task: role,
  version: 1,
  digest: role,
});

// Coverage ledger accounting boundaries. Over-recording means a file is never dug again;
// under-recording means auto-approve stays off and every round re-explores everything.
function depsWith(
  overrides: Partial<ReviewOrchestratorDeps> & { uncoveredPaths: readonly string[] },
): ReviewOrchestratorDeps {
  return {
    source: {
      listChangedFiles: async () => [],
      readFile: async () => undefined,
      searchCode: async () => [],
    },
    model: { id: 'test' },
    bundles: {
      mapper: bundle('mapper'),
      reviewer: bundle('reviewer'),
      synthesizer: bundle('synthesizer'),
      verifier: bundle('verifier'),
      refuter: bundle('refuter'),
    },
    publishContext: {},
    // These test ledger accounting, not publishing: take the shortest path (description update, no approve)
    // to avoid a full provider faux.
    updateSummaryDescription: async () => {},
    autoApprove: false,
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
    ...overrides,
  } as unknown as ReviewOrchestratorDeps;
}

describe('cross-round coverage ledger', () => {
  it('never credits a scope for a file another scope owns', async () => {
    // A finished and reports reading b.ts; b.ts belongs to B, which was cut by the wall clock.
    // Recording b.ts would mark it prior and drop it from every scope, so it would never be dug.
    const produced: ProducedReview = {
      staged: [],
      ledger: {
        scopes: [
          { id: 'a', title: 'a', changeSummary: 'a', obligations: [], files: ['a.ts'] },
          { id: 'b', title: 'b', changeSummary: 'b', obligations: [], files: ['b.ts'] },
        ],
        scopeOutcomes: [
          {
            scopeId: 'a',
            status: 'complete',
            candidateIds: [],
            exploredEntities: ['a.ts', 'b.ts'],
          },
        ],
        candidates: [],
        mapStatus: 'complete',
        coverage: { scopesTotal: 2, scopesComplete: 1 },
      },
    } as unknown as ProducedReview;

    const outcome = await publishReview(produced, depsWith({ uncoveredPaths: ['a.ts', 'b.ts'] }));

    expect(outcome.coveredPaths).toEqual(['a.ts']);
    expect(outcome.unreachedPaths).toEqual(['b.ts']);
  });

  it('does not credit a file while another scope sharing it is unfinished', async () => {
    // A big scope split into two parts: part 1 finished, part 2 was cut.
    // big.ts's second half was never reviewed; recording it would skip it next round.
    const produced: ProducedReview = {
      staged: [],
      ledger: {
        scopes: [
          { id: 'p1', title: 'x (part 1/2)', changeSummary: 'x', obligations: [], files: ['big.ts'] },
          { id: 'p2', title: 'x (part 2/2)', changeSummary: 'x', obligations: [], files: ['big.ts', 'small.ts'] },
        ],
        scopeOutcomes: [{ scopeId: 'p1', status: 'complete', candidateIds: [], exploredEntities: ['big.ts'] }],
        candidates: [],
        mapStatus: 'complete',
        coverage: { scopesTotal: 2, scopesComplete: 1 },
      },
    } as unknown as ProducedReview;

    const outcome = await publishReview(produced, depsWith({ uncoveredPaths: ['big.ts', 'small.ts'] }));

    expect(outcome.coveredPaths ?? []).toEqual([]);
    expect(outcome.unreachedPaths).toEqual(['big.ts', 'small.ts']);
  });

  it('falls back to the declared files when exploredEntities carries no path', async () => {
    // exploredEntities is only `string[]` in the schema, so the model may put symbol names there.
    // Then fall back to the scope's declared files instead of treating the round as zero coverage.
    const produced: ProducedReview = {
      staged: [],
      ledger: {
        scopes: [{ id: 'a', title: 'a', changeSummary: 'a', obligations: [], files: ['a.ts'] }],
        scopeOutcomes: [
          {
            scopeId: 'a',
            status: 'complete',
            candidateIds: [],
            exploredEntities: ['handleReview', 'WorkspaceSourceProvider'],
          },
        ],
        candidates: [],
        mapStatus: 'complete',
        coverage: { scopesTotal: 1, scopesComplete: 1 },
      },
    } as unknown as ProducedReview;

    const outcome = await publishReview(produced, depsWith({ uncoveredPaths: ['a.ts'] }));

    expect(outcome.coveredPaths).toEqual(['a.ts']);
    expect(outcome.unreachedPaths).toEqual([]);
  });

  it('separates a deduplicated candidate from one the capacity gate dropped', async () => {
    // Neither candidate is staged, for opposite reasons: deduped ones were verified by their representative (file recorded);
    // ones cut by cost cap / wall clock lack a result (file not recorded, re-reviewed next round).
    const ledgerBase = {
      scopes: [
        {
          id: 'a',
          title: 'a',
          changeSummary: 'a',
          obligations: [],
          files: ['dup.ts', 'capped.ts'],
        },
      ],
      scopeOutcomes: [
        {
          scopeId: 'a',
          status: 'complete',
          candidateIds: [],
          exploredEntities: ['dup.ts', 'capped.ts'],
        },
      ],
      candidates: [
        { id: 'c-dup', path: 'dup.ts', claim: 'dup', category: 'correctness' },
        { id: 'c-capped', path: 'capped.ts', claim: 'capped', category: 'correctness' },
      ],
      mapStatus: 'complete',
      coverage: { scopesTotal: 1, scopesComplete: 1 },
    };
    const produced: ProducedReview = {
      staged: [],
      ledger: ledgerBase,
      unverifiedCandidateIds: ['c-capped'],
    } as unknown as ProducedReview;

    const outcome = await publishReview(
      produced,
      depsWith({
        uncoveredPaths: ['dup.ts', 'capped.ts'],
        reviewContractDigest: 'c'.repeat(64),
        reviewFileStates: [
          { path: 'dup.ts', materialDigest: 'a'.repeat(64) },
          { path: 'capped.ts', materialDigest: 'b'.repeat(64) },
        ],
      }),
    );

    expect(outcome.coveredPaths).toEqual(['dup.ts']);
    expect(outcome.coveredFiles?.map((f) => f.path)).toEqual(['dup.ts']);
    expect(outcome.unreachedPaths).toEqual(['capped.ts']);
  });

  // Covered files carry dependencies = files the covering scope read that this PR did not change.
  it('attaches what each covering scope read as the covered file dependencies', async () => {
    const produced: ProducedReview = {
      staged: [],
      ledger: {
        scopes: [{ id: 'a', title: 'a', changeSummary: 'a', obligations: [], files: ['a.ts'] }],
        scopeOutcomes: [
          {
            scopeId: 'a',
            status: 'complete',
            candidateIds: [],
            exploredEntities: ['a.ts'],
            // b.ts is also changed by this PR: if it changes again it re-enters the round itself, so it is not a dependency of a.ts.
            readPaths: ['./a.ts', 'b.ts', 'lib/util.ts', 'types.ts'],
            // Only results for the scope's own files count; other.ts written incidentally does not.
            fileNotes: [
              { path: './a.ts', summary: 'a() now validates input via util.check()' },
              { path: 'other.ts', summary: 'not this scope' },
            ],
          },
        ],
        candidates: [],
        mapStatus: 'complete',
        coverage: { scopesTotal: 1, scopesComplete: 1 },
      },
    } as unknown as ProducedReview;

    const outcome = await publishReview(
      produced,
      depsWith({
        uncoveredPaths: ['a.ts'],
        reviewContractDigest: 'c'.repeat(64),
        reviewFileStates: [
          { path: 'a.ts', materialDigest: 'a'.repeat(64) },
          { path: 'b.ts', materialDigest: 'b'.repeat(64) },
        ],
      }),
    );

    expect(outcome.coveredFiles).toEqual([
      {
        path: 'a.ts',
        materialDigest: 'a'.repeat(64),
        dependencies: ['lib/util.ts', 'types.ts'],
        note: 'a() now validates input via util.check()',
      },
    ]);
  });
});

describe('change summary in the PR description', () => {
  it('lists each planned section once: no split parts, no fallback sections', async () => {
    let description = '';
    const produced: ProducedReview = {
      staged: [],
      ledger: {
        scopes: [
          { id: 'p1', title: 'Ingest', changeSummary: 'Adds ingest.', obligations: [], files: ['a.ts'], part: { index: 1, total: 2, sectionId: 'p1' } },
          { id: 'p2', title: 'Ingest', changeSummary: 'Adds ingest.', obligations: [], files: ['a.ts'], part: { index: 2, total: 2, sectionId: 'p1' } },
          { id: 'r1', title: 'Other changes in src', changeSummary: 'x', obligations: [], files: ['b.ts'], origin: 'remainder' },
          { id: 's1', title: 'Docs', changeSummary: 'Updates docs.', obligations: [], files: ['c.md'] },
        ],
        scopeOutcomes: ['p1', 'r1', 's1'].map((scopeId) => ({ scopeId, status: 'complete', candidateIds: [], exploredEntities: [] })),
        candidates: [],
        mapStatus: 'complete',
        coverage: { scopesTotal: 4, scopesComplete: 3 },
      },
    } as unknown as ProducedReview;

    await publishReview(
      produced,
      depsWith({ uncoveredPaths: [], updateSummaryDescription: async (text: string) => void (description = text) }),
    );

    expect(description.match(/\*\*Ingest\*\*/g)).toHaveLength(1);
    expect(description).toContain('**Docs**');
    expect(description).not.toContain('Other changes');
    expect(description).not.toContain('part');
    // "Reviewed x/y areas" counts areas: part 2 of Ingest did not finish so the area is incomplete; the fallback scope is not an area.
    expect(sectionCoverage({ scopes: produced.ledger.scopes, scopeOutcomes: produced.ledger.scopeOutcomes } as never)).toEqual({
      completed: 1,
      total: 2,
    });
  });
});

describe('review in rounds', () => {
  it('reports deferred files separately from unassigned ones', async () => {
    const produced: ProducedReview = {
      staged: [],
      ledger: {
        scopes: [{ id: 'a', title: 'a', changeSummary: 'a', obligations: [], files: ['a.ts'] }],
        scopeOutcomes: [{ scopeId: 'a', status: 'complete', candidateIds: [], exploredEntities: ['a.ts'] }],
        candidates: [],
        mapStatus: 'complete',
        coverage: { scopesTotal: 1, scopesComplete: 1 },
      },
    } as unknown as ProducedReview;

    const outcome = await publishReview(
      produced,
      depsWith({ uncoveredPaths: ['a.ts', 'b.ts', 'c.ts'], deferredPaths: ['b.ts', 'c.ts'] }),
    );

    expect(outcome.coveredPaths).toEqual(['a.ts']);
    expect(outcome.deferredPaths).toEqual(['b.ts', 'c.ts']);
    expect(outcome.unplannedPaths).toEqual([]);
    expect(outcome.unreachedPaths).toEqual([]);
  });
});
