import { beforeAll, describe, expect, it } from 'vitest';
import { createFauxAgent, createRoutingFauxAgent, type SourceProvider } from '@reviewbot/agent-pi';
import { loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import { verifyCandidateWithVotes, type VerifiableCandidate, type VerifyDeps } from '../src/index.js';

const source: SourceProvider = {
  listChangedFiles: async () => [{ path: 'a.ts', status: 'modified' }],
  readFile: async () => 'function f(x) { return x + 1 }',
  searchCode: async () => [],
};

// maintainability/low skips the refuter, so one vote = one submit_assessment.
const candidate: VerifiableCandidate = {
  id: 'c1',
  claim: 'naming could be clearer',
  category: 'maintainability',
  suspectedSeverity: 'low',
  primaryAnchorText: 'return x + 1',
  changeRelationHypothesis: 'introduced',
};

const BASE = {
  introducedByChange: true,
  reachable: true,
  actionable: true,
  changeRelation: 'introduced',
  residualUncertainty: [],
};

let bundles: { verifier: PromptBundle; refuter: PromptBundle };

beforeAll(async () => {
  const loaded = await loadPromptBundles(['verifier', 'refuter']);
  bundles = { verifier: loaded.verifier!, refuter: loaded.refuter! };
});

function deps(faux: ReturnType<typeof createFauxAgent>): VerifyDeps {
  return { source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 6, maxToolCalls: 12 } };
}

function verdictOf(decision: string, severity = 'low', confirmation = 'independently-verified', residual: string[] = []) {
  return { ...BASE, decision, severity, confirmation, residualUncertainty: residual };
}

describe('verifyCandidateWithVotes(§36 多投票)', () => {
  it('votes=1 退化为单次 verify(零行为变化)', async () => {
    const faux = createFauxAgent();
    faux.setResponses([faux.assistant(faux.toolCall('submit_assessment', verdictOf('accept')))]);
    const r = await verifyCandidateWithVotes(deps(faux), candidate, 1);
    expect(r.verdict.decision).toBe('accept');
  });

  it('多数 accept → accept;severity 取中位(偶数偏低)、confirmation 取最低、residual 并集', async () => {
    // medium needs the refuter; votes run concurrently, so responses are queued per finalization tool.
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      submit_assessment: [
        faux.assistant(faux.toolCall('submit_assessment', verdictOf('accept', 'medium', 'independently-verified', ['a']))),
        faux.assistant(faux.toolCall('submit_assessment', verdictOf('accept', 'low', 'code-supported', ['b']))),
        faux.assistant(faux.toolCall('submit_assessment', verdictOf('reject'))),
      ],
      confirm_assessment: [faux.assistant(faux.toolCall('confirm_assessment', { decision: 'uphold', arguments: [] }))],
    });
    const r = await verifyCandidateWithVotes(
      { source, model: faux.model, streamFn: faux.streamFn, bundles, budget: { maxTurns: 6, maxToolCalls: 12 } },
      candidate,
      3,
    );
    expect(r.verdict.decision).toBe('accept');
    expect(r.verdict.severity).toBe('low'); // lower of two
    expect(r.verdict.confirmation).toBe('code-supported'); // lowest level
    expect([...r.verdict.residualUncertainty].sort()).toEqual(['a', 'b']);
  });

  it('accept 无多数(1/3)→ 降 uncertain(不可阻断)', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('submit_assessment', verdictOf('accept'))),
      faux.assistant(faux.toolCall('submit_assessment', verdictOf('reject'))),
      faux.assistant(faux.toolCall('submit_assessment', verdictOf('reject'))),
    ]);
    const r = await verifyCandidateWithVotes(deps(faux), candidate, 3);
    expect(r.verdict.decision).toBe('uncertain');
  });

  it('全 reject → reject', async () => {
    const faux = createFauxAgent();
    faux.setResponses([
      faux.assistant(faux.toolCall('submit_assessment', verdictOf('reject'))),
      faux.assistant(faux.toolCall('submit_assessment', verdictOf('reject'))),
      faux.assistant(faux.toolCall('submit_assessment', verdictOf('reject'))),
    ]);
    const r = await verifyCandidateWithVotes(deps(faux), candidate, 3);
    expect(r.verdict.decision).toBe('reject');
  });
});
