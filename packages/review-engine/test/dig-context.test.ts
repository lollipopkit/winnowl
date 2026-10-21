import { describe, expect, it } from 'vitest';
import { createRoutingFauxAgent } from '@reviewbot/agent-pi';
import { loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import { uuidv7 } from '@reviewbot/ids';
import { runReviewPipeline, type ReviewEngineDeps } from '../src/index.js';

// `fork-map` gives every dig the same map transcript; siblings cannot see each other (unlike `sessionReuse`).
// An identical shared prefix is what makes prompt-cache hits possible.
const CANDIDATE = {
  claim: 'c', category: 'correctness', suspectedSeverity: 'low',
  path: 'app.py', primaryAnchorText: 'return a + b', changeRelationHypothesis: 'introduced',
};

// Marker that can only reach the transcript via map's read tool.
const MAP_MARK = 'MAP-ONLY-MARKER';
const source = {
  listChangedFiles: async () => [{ path: 'app.py', status: 'modified' as const }],
  readFile: async () => `def add(a, b):  # ${MAP_MARK}\n    return a + b\n`,
  searchCode: async () => [],
};

async function deps(faux: ReturnType<typeof createRoutingFauxAgent>): Promise<ReviewEngineDeps> {
  const loaded = await loadPromptBundles(['mapper', 'reviewer', 'synthesizer']);
  return {
    source: source as unknown as ReviewEngineDeps['source'],
    model: faux.model,
    streamFn: faux.streamFn,
    bundles: {
      mapper: loaded.mapper as PromptBundle,
      reviewer: loaded.reviewer as PromptBundle,
      synthesizer: loaded.synthesizer as PromptBundle,
    },
    budget: { maxTurns: 8, maxToolCalls: 16 },
    newId: () => uuidv7(),
    digConcurrency: 1,
  };
}

function scenario(): ReturnType<typeof createRoutingFauxAgent> {
  const faux = createRoutingFauxAgent();
  faux.setStageResponses({
    submit_plan: [
      // Map reads the file once so the marker enters the transcript via a tool result;
      // plain assistant text would end the agent loop immediately (no finalization tool called).
      faux.assistant(faux.toolCall('read_source', { path: 'app.py' })),
      faux.assistant(faux.toolCall('submit_plan', {
        scopes: [
          { title: 's1', changeSummary: 'a', obligations: [{ kind: 'correctness', description: 'x' }] },
          { title: 's2', changeSummary: 'b', obligations: [{ kind: 'correctness', description: 'y' }] },
        ],
      })),
    ],
    complete_section: [
      faux.assistant(faux.toolCall('submit_finding', { ...CANDIDATE, claim: 'DIG1-MARKER' })),
      faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
      faux.assistant(faux.toolCall('submit_finding', { ...CANDIDATE, claim: 'c2' })),
      faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py'] })),
    ],
    submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'x' }))],
  });
  return faux;
}

describe('review.dig_context', () => {
  it('fresh(默认)→ 每个 dig 从零开始,看不到 map 说过的话', async () => {
    const faux = scenario();
    const ledger = await runReviewPipeline(await deps(faux));
    expect(ledger.coverage).toEqual({ scopesTotal: 2, scopesComplete: 2 });
    const digPrompts = faux.messagesFor('complete_section');
    for (const p of digPrompts) expect(JSON.stringify(p)).not.toContain(MAP_MARK);
  });

  it('fork-map → 每个 dig 都带上 map 的 transcript,而且是同一份(兄弟互不可见)', async () => {
    const faux = scenario();
    const ledger = await runReviewPipeline({ ...(await deps(faux)), digForkFromMap: true });
    expect(ledger.coverage).toEqual({ scopesTotal: 2, scopesComplete: 2 });
    const digPrompts = faux.messagesFor('complete_section');
    expect(digPrompts.length).toBeGreaterThanOrEqual(2);
    for (const p of digPrompts) expect(JSON.stringify(p)).toContain(MAP_MARK);
    // The second dig must not see the first dig's output.
    expect(JSON.stringify(digPrompts[digPrompts.length - 1])).not.toContain('DIG1-MARKER');
  });
});

describe('review.subagents 的 prompt 提示', () => {
  it('未启用 → dig 的 task 里不提 investigate(不能提一个它没有的工具)', async () => {
    const faux = scenario();
    await runReviewPipeline(await deps(faux));
    const digs = faux.messagesFor('complete_section');
    for (const m of digs) expect(JSON.stringify(m)).not.toContain('investigate');
  });

  it('启用 → 父的 task 里提;**子的 task 里不提**(子没有这个工具)', async () => {
    const faux = scenario();
    await runReviewPipeline({
      ...(await deps(faux)),
      subagents: { maxTasks: 4, maxConcurrency: 4, budget: { maxTurns: 4, maxToolCalls: 8 } },
    });
    const digs = faux.messagesFor('complete_section');
    expect(digs.length).toBeGreaterThan(0);
    expect(JSON.stringify(digs[0])).toContain('investigate');
    // Child isolation (not in the child's readTools) is pinned by agent-pi unit tests;
    // here we only pin that the hint appears in the parent's task.
  });
});
