import { currentLlmTraceContext, getTracer, llmTraceAttributes, SpanStatusCode, type Span } from '@reviewbot/telemetry';

/*
 * Tool call spans (OTel `gen_ai` execute_tool convention). They are siblings of generation spans under the
 * stage span, not children: tools run after the model turn returns, so nesting would inflate generation time.
 * Arguments and output are never recorded (customer source code), only sizes and status.
 */

/** No-op when telemetry is disabled. */
const toolTracer = getTracer('agent-pi');

export interface ToolCallOutcome {
  /** Before truncation. */
  outputBytes?: number;
  truncated?: boolean;
  /** Tool-reported error (pi encodes it in the result instead of throwing). */
  isError?: boolean;
}

function startToolSpan(toolName: string, attributes: Record<string, string | number | boolean> = {}): Span {
  return toolTracer.startSpan(`execute_tool ${toolName}`, {
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': toolName,
      // Every span needs these itself: Langfuse does not inherit `langfuse.trace.metadata.*` from parents.
      ...llmTraceAttributes(currentLlmTraceContext()),
      ...attributes,
    },
  });
}

export function observeToolCall(toolName: string): { settle: (outcome?: ToolCallOutcome) => void } {
  const span = startToolSpan(toolName);
  let settled = false;
  return {
    settle: (outcome?: ToolCallOutcome) => {
      if (settled) return;
      settled = true;
      if (outcome?.outputBytes !== undefined) span.setAttribute('tool.output_bytes', outcome.outputBytes);
      if (outcome?.truncated) span.setAttribute('tool.truncated', true);
      if (outcome?.isError) span.setStatus({ code: SpanStatusCode.ERROR, message: 'tool reported an error' });
      else span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    },
  };
}

/** Records a blocked call as a closed span; pi skips `afterToolCall` for blocked calls, so settle would never run. */
export function observeBlockedToolCall(toolName: string, reason: 'not-permitted' | 'budget-exhausted'): void {
  const span = startToolSpan(toolName, { 'tool.blocked_reason': reason });
  span.setStatus({ code: SpanStatusCode.ERROR, message: `blocked: ${reason}` });
  span.end();
}
