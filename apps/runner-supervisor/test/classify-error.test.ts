import { describe, expect, it } from 'vitest';
import { SandboxCapacityError } from '@reviewbot/sandbox';
import { classifyJobError, JobExecutionError } from '../src/supervisor.js';

describe('classifyJobError', () => {
  it('JobExecutionError 用自带分类', () => {
    expect(classifyJobError(new JobExecutionError('x', 'configuration_invalid', false))).toEqual({ failureClass: 'configuration_invalid', retryable: false });
  });

  it('no sandbox host in time (deploy, busy hour) → retryable_runner, retried', () => {
    expect(classifyJobError(new SandboxCapacityError('no sandbox host could open a workspace in time'))).toEqual({ failureClass: 'retryable_runner', retryable: true });
  });

  it('Provider 403(权限)→ policy_denied,不重试(不再误判 internal_bug)', () => {
    const err = Object.assign(new Error('403'), { status: 403 });
    expect(classifyJobError(err)).toEqual({ failureClass: 'policy_denied', retryable: false });
  });

  it('AgentRequestError 404(sandbox/workspace 没了)→ retryable_runner,而不是 terminal 的 repository_invalid', () => {
    const gone = Object.assign(new Error('sandbox not found'), {
      name: 'AgentRequestError',
      status: 404,
    });
    expect(classifyJobError(gone)).toEqual({ failureClass: 'retryable_runner', retryable: true });
    // Other statuses use the generic rules (403 = permission/config).
    expect(
      classifyJobError(
        Object.assign(new Error('denied'), { name: 'AgentRequestError', status: 403 }),
      ).failureClass,
    ).toBe('policy_denied');
  });

  it('401 → policy_denied;404 → repository_invalid', () => {
    expect(classifyJobError(Object.assign(new Error('401'), { status: 401 })).failureClass).toBe('policy_denied');
    expect(classifyJobError(Object.assign(new Error('404'), { status: 404 })).failureClass).toBe('repository_invalid');
  });

  it('429/5xx → retryable_provider,可重试', () => {
    expect(classifyJobError(Object.assign(new Error('429'), { status: 429 }))).toEqual({ failureClass: 'retryable_provider', retryable: true });
    expect(classifyJobError(Object.assign(new Error('503'), { status: 503 }))).toEqual({ failureClass: 'retryable_provider', retryable: true });
  });

  it('无 status 的未知错误 → internal_bug', () => {
    expect(classifyJobError(new Error('boom'))).toEqual({ failureClass: 'internal_bug', retryable: false });
  });

  it('ReviewIncompleteError 无归类 → retryable_runner,可重试(不静默 approve)', () => {
    const err = Object.assign(new Error('exploration incomplete'), { name: 'ReviewIncompleteError' });
    expect(classifyJobError(err)).toEqual({ failureClass: 'retryable_runner', retryable: true });
  });

  it('ReviewIncompleteError(网关/超时)→ retryable_model,吃分钟级退避而非执行面的秒级', () => {
    for (const failureKind of ['gateway_transport', 'timeout']) {
      const err = Object.assign(new Error('exploration incomplete'), { name: 'ReviewIncompleteError', failureKind });
      expect(classifyJobError(err)).toEqual({ failureClass: 'retryable_model', retryable: true });
    }
  });

  it('ReviewIncompleteError(护栏拒绝)→ 不重试(同一段 prompt 重发只会同样被拒)', () => {
    const err = Object.assign(new Error('exploration incomplete'), {
      name: 'ReviewIncompleteError',
      failureKind: 'content_filter',
    });
    expect(classifyJobError(err)).toEqual({ failureClass: 'retryable_model', retryable: false });
  });

  it('ReviewIncompleteError(墙钟到点且零候选)→ 终态,不重试;优先于 failureKind', () => {
    // The deadline abort itself surfaces as timeout/unknown; deadlineCut must still win.
    for (const failureKind of [undefined, 'timeout', 'gateway_transport', 'unknown']) {
      const err = Object.assign(new Error('exploration incomplete'), {
        name: 'ReviewIncompleteError',
        deadlineCut: true,
        ...(failureKind ? { failureKind } : {}),
      });
      expect(classifyJobError(err)).toEqual({ failureClass: 'budget_exhausted', retryable: false });
    }
  });
});
