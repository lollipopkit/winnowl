import { describe, expect, it } from 'vitest';
import { createRoutingFauxAgent } from '@reviewbot/agent-pi';
import { loadPromptBundles, type PromptBundle } from '@reviewbot/prompts';
import { uuidv7 } from '@reviewbot/ids';
import { runReviewPipeline, type ReviewEngineDeps } from '../src/index.js';

const source = {
  listChangedFiles: async () => [
    { path: 'app.py', status: 'modified' as const },
    { path: 'gone.py', status: 'deleted' as const },
  ],
  readFile: async (path: string) => (path === 'app.py' ? 'HEAD-ONLY-TEXT\n' : null),
  searchCode: async () => [],
};

const PATCHES = {
  'app.py': '--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-REMOVED-MARKER\n+HEAD-ONLY-TEXT',
  'gone.py': '--- a/gone.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-DELETED-FILE-MARKER',
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
    plannedScopes: [
      { title: 's', changeSummary: 'c', obligations: [{ kind: 'correctness', description: 'x' }], files: ['app.py', 'gone.py'] },
    ],
  };
}

describe('dig sees the change as a diff', () => {
  it('prefetches each file\'s diff (removed lines and deleted files included) and offers read_diff', async () => {
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      complete_section: [
        faux.assistant(faux.toolCall('read_diff', { path: 'gone.py' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'complete', exploredEntities: ['app.py', 'gone.py'] })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'x' }))],
    });
    const ledger = await runReviewPipeline({ ...(await deps(faux)), filePatches: PATCHES });
    const dig = JSON.stringify(faux.messagesFor('complete_section'));
    expect(dig).toContain('REMOVED-MARKER');
    expect(dig).toContain('DELETED-FILE-MARKER');
    expect(dig).toContain('// app.py — diff');
    expect(ledger.scopeOutcomes[0]!.status).toBe('complete');
  });

  it('records the reason a section reports for not completing', async () => {
    const faux = createRoutingFauxAgent();
    faux.setStageResponses({
      complete_section: [
        faux.assistant(faux.toolCall('complete_section', { status: 'incomplete', exploredEntities: [], reason: 'gone.py not read' })),
        faux.assistant(faux.toolCall('complete_section', { status: 'incomplete', exploredEntities: [], reason: 'gone.py not read' })),
      ],
      submit_summary: [faux.assistant(faux.toolCall('submit_summary', { note: 'x' }))],
    });
    const ledger = await runReviewPipeline({ ...(await deps(faux)), filePatches: PATCHES });
    expect(ledger.scopeOutcomes[0]!.incompleteReason).toBe('reported incomplete: gone.py not read');
  });
});
