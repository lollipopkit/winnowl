import { describe, expect, it } from 'vitest';
import { classifyStreamFailure, isRetryableStreamFailure, shouldTryAnotherModel } from '../src/failure.js';

describe('classifyStreamFailure(§LLM 失败归因)', () => {
  it('模型护栏拒绝 → content_filter', () => {
    for (const m of [
      'Response was filtered due to content_filter',
      'The content was flagged by moderation',
      'blocked by content policy',
      'The model refused to answer',
      'request blocked by safety system',
    ]) {
      expect(classifyStreamFailure(m)).toBe('content_filter');
    }
  });

  it('上下文超限 → context_overflow(同模型不重试,可换模型)', () => {
    for (const m of [
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.",
      '400 {"error":{"code":"context_length_exceeded"}}',
      'prompt is too long: 210000 tokens > 200000 maximum',
      'input is too long for requested model',
    ]) {
      expect(classifyStreamFailure(m)).toBe('context_overflow');
    }
    expect(isRetryableStreamFailure('context_overflow')).toBe(false);
    expect(shouldTryAnotherModel('context_overflow')).toBe(true);
  });

  it('某个模型没有可用额度 → model_unavailable:不在同一模型上重试,换模型', () => {
    for (const m of [
      'OpenAI API error (529): {"code":"model_unavailable","message":"All credentials for model gpt-6-luna are temporarily unavailable"}',
      '429 {"error":{"code":"model_cooldown","message":"All credentials for model gpt-6-luna are cooling down","reset_seconds":8163,"type":"rate_limit_error"}}',
      '404 {"error":{"message":"no channel serves model claude-haiku-5-5","type":"invalid_request_error","code":"model_not_found"}}',
    ]) {
      expect(classifyStreamFailure(m)).toBe('model_unavailable');
    }
    expect(isRetryableStreamFailure('model_unavailable')).toBe(false);
    expect(shouldTryAnotherModel('model_unavailable')).toBe(true);
  });

  it('网关/传输层 → gateway_transport', () => {
    for (const m of [
      'Could not parse message into JSON', // observed SSE event:error symptom
      'event: error',
      'read ECONNRESET',
      'fetch failed',
      '502 Bad Gateway',
      '503 Service Unavailable',
      'stream ended unexpectedly',
    ]) {
      expect(classifyStreamFailure(m)).toBe('gateway_transport');
    }
  });

  // Rate limits are key-scoped and must stay distinct from gateway_transport so they skip model fallback.
  it('限流/配额 → rate_limit(可重试,但不该触发换模型)', () => {
    for (const m of [
      '429 Too Many Requests',
      'OpenAI API error (429): {"code":"concurrency_limit_exceeded","message":"concurrency limit (7 concurrent requests) exceeded for this API key"}',
      'rate_limit_exceeded',
      'monthly quota exceeded',
    ]) {
      expect(classifyStreamFailure(m)).toBe('rate_limit');
    }
    expect(isRetryableStreamFailure('rate_limit')).toBe(true);
    expect(shouldTryAnotherModel('rate_limit')).toBe(false);
  });

  it('换模型可能有救的:护栏/网关/超时/未知', () => {
    for (const k of ['content_filter', 'context_overflow', 'gateway_transport', 'timeout', 'unknown'] as const) {
      expect(shouldTryAnotherModel(k)).toBe(true);
    }
  });

  it('纯超时 → timeout(网关 504/gateway timeout 归 transport 不归此)', () => {
    expect(classifyStreamFailure('request timed out after 60s')).toBe('timeout');
    expect(classifyStreamFailure('ETIMEDOUT')).toBe('timeout');
    expect(classifyStreamFailure('deadline exceeded')).toBe('timeout');
    expect(classifyStreamFailure('504 Gateway Timeout')).toBe('gateway_transport');
  });

  it('空/无法判定 → unknown(保守按可重试,绝不误判护栏)', () => {
    expect(classifyStreamFailure(undefined)).toBe('unknown');
    expect(classifyStreamFailure('')).toBe('unknown');
    expect(classifyStreamFailure('some unexpected internal error xyz')).toBe('unknown');
  });

  it('isRetryableStreamFailure:仅 content_filter 不可重试', () => {
    expect(isRetryableStreamFailure('content_filter')).toBe(false);
    expect(isRetryableStreamFailure('gateway_transport')).toBe(true);
    expect(isRetryableStreamFailure('timeout')).toBe(true);
    expect(isRetryableStreamFailure('unknown')).toBe(true);
  });
});
