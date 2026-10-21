import { describe, expect, it } from 'vitest';
import { resolveModelSourceFromEnv, runAgentInvocation, Type } from '../src/index.js';

/**
 * Real LLM end to end; opt-in only (LLM_* in .env alone does not enable it):
 *   LLM_LIVE=1 pnpm vitest run --project unit packages/agent-pi/test/live-model.test.ts
 * For a model outside the pi catalog, also set LLM_TEMPLATE_MODEL (e.g. gpt-4o).
 */
const live = process.env.LLM_LIVE && process.env.LLM_MODEL && process.env.LLM_PROVIDER ? describe : describe.skip;

const RESULT = Type.Object({ value: Type.Number() });

live('真实 LLM 连通(§15.3)', () => {
  it('模型 + streamFn 经 agent 完成一次终结调用', async () => {
    const source = resolveModelSourceFromEnv();
    expect(source).not.toBeNull();
    const result = await runAgentInvocation({
      systemPrompt: 'You return exact answers via the tool.',
      task: 'Call submit_result with value exactly 42.',
      model: source!.model,
      streamFn: source!.streamFn,
      readTools: [],
      finalization: { name: 'submit_result', description: 'Submit the number.', label: 'Submit', schema: RESULT },
      budget: { maxTurns: 3, maxToolCalls: 4 },
    });
    expect(result.status).toBe('complete');
    expect((result.finalization as { value: number }).value).toBe(42);
  }, 60_000);
});
