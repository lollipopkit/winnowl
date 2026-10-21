import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawWebhookDelivery } from '@reviewbot/provider-contracts';
import { normalizeGitlabWebhook, parseGitlabDelivery, verifyGitlabWebhook } from '../src/index.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/gitlab');

const SECRET = 'gl-secret';

function delivery(event: string, payload: unknown, token?: string): RawWebhookDelivery {
  return parseGitlabDelivery(
    { 'x-gitlab-event': event, ...(token ? { 'x-gitlab-token': token } : {}) },
    JSON.stringify(payload),
    'host-1',
    '2026-07-15T00:00:00.000Z',
  );
}

const project = {
  id: 55,
  path_with_namespace: 'acme/app',
  name: 'app',
  git_http_url: 'https://gitlab.com/acme/app.git',
  default_branch: 'main',
};

describe('GitLab webhook 验签', () => {
  it('token 匹配通过', () => {
    const d = delivery('Merge Request Hook', {}, SECRET);
    expect(verifyGitlabWebhook(d, SECRET).valid).toBe(true);
  });
  it('token 不匹配失败', () => {
    const d = delivery('Merge Request Hook', {}, 'wrong');
    expect(verifyGitlabWebhook(d, SECRET).valid).toBe(false);
  });
  it('缺失 token 失败', () => {
    const d = delivery('Merge Request Hook', {});
    expect(verifyGitlabWebhook(d, SECRET).reason).toBe('missing_token');
  });
  it('header names are matched case-insensitively', () => {
    const raw = parseGitlabDelivery(
      {
        'X-GitLab-Event': 'Pipeline Hook',
        'X-GitLab-Event-UUID': 'mixed',
        'X-GitLab-Token': SECRET,
      },
      '{}',
      'host-1',
      '2026-07-15T00:00:00.000Z',
    );
    expect(raw.eventType).toBe('Pipeline Hook');
    expect(raw.deliveryId).toBe('mixed');
    expect(verifyGitlabWebhook(raw, SECRET).valid).toBe(true);
  });
});

describe('GitLab webhook 归一化', () => {
  it('merge_request open → change-request.opened', () => {
    const [event] = normalizeGitlabWebhook(
      delivery('Merge Request Hook', {
        object_kind: 'merge_request',
        project,
        user: { id: 7, username: 'alice' },
        object_attributes: {
          id: 5001,
          iid: 7,
          action: 'open',
          source_branch: 'f',
          target_branch: 'main',
          last_commit: { id: 'aaaa' },
          work_in_progress: false,
        },
      }),
    );
    expect(event).toMatchObject({ type: 'change-request.opened', headSha: 'aaaa' });
    if (event?.type === 'change-request.opened') {
      expect(event.change.number).toBe(7);
      expect(event.change.repo.namespace).toBe('acme');
      expect(event.change.repo.name).toBe('app');
    }
  });

  it('merge_request:source/target project 不同 → sourceIsFork,缺 project id 则省略', () => {
    const forkOf = (ids: object) => {
      const [event] = normalizeGitlabWebhook(
        delivery('Merge Request Hook', {
          object_kind: 'merge_request',
          project,
          user: { id: 7, username: 'alice' },
          object_attributes: {
            id: 5001,
            iid: 7,
            action: 'open',
            source_branch: 'main',
            target_branch: 'main',
            last_commit: { id: 'aaaa' },
            ...ids,
          },
        }),
      );
      return event?.type === 'change-request.opened' ? event.sourceIsFork : 'wrong-type';
    };
    expect(forkOf({ source_project_id: 1, target_project_id: 1 })).toBe(false);
    expect(forkOf({ source_project_id: 2, target_project_id: 1 })).toBe(true);
    expect(forkOf({})).toBeUndefined();
  });

  it('merge_request update(含 oldrev)→ change-request.updated commit-pushed', () => {
    const [event] = normalizeGitlabWebhook(
      delivery('Merge Request Hook', {
        object_kind: 'merge_request',
        project,
        user: { id: 7, username: 'alice' },
        object_attributes: {
          id: 5001,
          iid: 7,
          action: 'update',
          oldrev: 'oldd',
          source_branch: 'f',
          target_branch: 'main',
          last_commit: { id: 'newd' },
        },
      }),
    );
    expect(event).toMatchObject({
      type: 'change-request.updated',
      reason: 'commit-pushed',
      previousHeadSha: 'oldd',
    });
  });

  it('note on MR → comment.created', () => {
    const [event] = normalizeGitlabWebhook(
      delivery('Note Hook', {
        object_kind: 'note',
        project,
        user: { id: 7, username: 'alice' },
        object_attributes: { id: 99, note: 'hi', noteable_type: 'MergeRequest' },
        merge_request: { iid: 7, id: 5001 },
      }),
    );
    expect(event?.type).toBe('comment.created');
    if (event?.type === 'comment.created') {
      expect(event.body).toBe('hi');
      expect(event.target.kind).toBe('change-request');
    }
  });

  it('editing an MR note → comment.edited, not a new comment (no previous body or author from GitLab)', () => {
    const [event] = normalizeGitlabWebhook(
      delivery('Note Hook', {
        object_kind: 'note',
        project,
        user: { id: 7, username: 'alice' },
        object_attributes: { id: 99, action: 'update', note: '- [x] ticked', noteable_type: 'MergeRequest' },
        merge_request: { iid: 7, id: 5001 },
      }),
    );
    expect(event).toMatchObject({ type: 'comment.edited', commentNativeId: '99', body: '- [x] ticked', actor: { login: 'alice' } });
    expect(event).not.toHaveProperty('previousBody');
    expect(event).not.toHaveProperty('author');
  });

  it('MR draft → ready emits change-request.ready; other updates carry the current draft flag', () => {
    const mr = (changes: unknown, draft: boolean) =>
      delivery('Merge Request Hook', {
        object_kind: 'merge_request',
        project,
        user: { id: 7, username: 'alice' },
        object_attributes: { id: 5001, iid: 7, action: 'update', source_branch: 'f', target_branch: 'main', draft, last_commit: { id: 'h1' } },
        changes,
      });
    expect(normalizeGitlabWebhook(mr({ draft: { previous: true, current: false } }, false))[0]?.type).toBe(
      'change-request.ready',
    );
    expect(normalizeGitlabWebhook(mr({ draft: { previous: false, current: true } }, true))[0]).toMatchObject({
      type: 'change-request.updated',
      draft: true,
    });
  });

  it('recorded fixture: merge_request.open → change-request.opened(§45.3)', () => {
    const body = readFileSync(resolve(fixturesDir, 'merge_request.open.json'), 'utf8');
    const [event] = normalizeGitlabWebhook(
      parseGitlabDelivery(
        { 'x-gitlab-event': 'Merge Request Hook' },
        body,
        'host-1',
        '2026-07-15T00:00:00.000Z',
      ),
    );
    expect(event?.type).toBe('change-request.opened');
  });

  it('push → push.received', () => {
    const [event] = normalizeGitlabWebhook(
      delivery('Push Hook', {
        object_kind: 'push',
        project,
        user: { id: 7, username: 'alice' },
        ref: 'refs/heads/main',
        before: 'x',
        after: 'y',
      }),
    );
    expect(event).toMatchObject({ type: 'push.received', ref: 'refs/heads/main', afterSha: 'y' });
  });

  it('completed pipeline → pipeline.completed', () => {
    const [event] = normalizeGitlabWebhook(
      delivery('Pipeline Hook', {
        object_kind: 'pipeline',
        project,
        user: { id: 7, username: 'alice' },
        object_attributes: { status: 'failed', sha: 'deadbeef' },
      }),
    );
    expect(event).toMatchObject({
      type: 'pipeline.completed',
      headSha: 'deadbeef',
      status: 'completed',
      conclusion: 'failure',
    });
  });

  it('running pipeline remains ignored', () => {
    const [event] = normalizeGitlabWebhook(
      delivery('Pipeline Hook', {
        object_kind: 'pipeline',
        project,
        object_attributes: { status: 'running', sha: 'deadbeef' },
      }),
    );
    expect(event).toEqual({ type: 'ignored', reason: 'pipeline:running' });
  });
});
