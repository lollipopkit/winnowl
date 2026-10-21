import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawWebhookDelivery } from '@reviewbot/provider-contracts';
import {
  normalizeForgejoWebhook,
  parseForgejoDelivery,
  verifyForgejoWebhook,
} from '../src/index.js';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/forgejo');

const SECRET = 'fj-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
}

function delivery(event: string, payload: unknown, signature?: string): RawWebhookDelivery {
  const body = JSON.stringify(payload);
  return parseForgejoDelivery(
    { 'x-forgejo-event': event, ...(signature ? { 'x-forgejo-signature': signature } : {}) },
    body,
    'host-1',
    '2026-07-15T00:00:00.000Z',
  );
}

const repository = {
  id: 900,
  name: 'app',
  owner: { id: 1, login: 'acme' },
  clone_url: 'https://forgejo.example/acme/app.git',
  default_branch: 'main',
};

describe('Forgejo webhook 验签', () => {
  it('HMAC 正确通过', () => {
    const body = JSON.stringify({ action: 'opened' });
    const d = parseForgejoDelivery(
      { 'x-forgejo-event': 'pull_request', 'x-forgejo-signature': sign(body) },
      body,
      'host-1',
      '2026-07-15T00:00:00.000Z',
    );
    expect(verifyForgejoWebhook(d, SECRET).valid).toBe(true);
  });
  it('错误密钥失败', () => {
    const body = JSON.stringify({ action: 'opened' });
    const d = parseForgejoDelivery(
      { 'x-forgejo-event': 'pull_request', 'x-forgejo-signature': sign(body) },
      body,
      'host-1',
      '2026-07-15T00:00:00.000Z',
    );
    expect(verifyForgejoWebhook(d, 'wrong').valid).toBe(false);
  });
  it('也接受 x-gitea-signature', () => {
    const body = JSON.stringify({ a: 1 });
    const d = parseForgejoDelivery(
      { 'x-gitea-event': 'push', 'x-gitea-signature': sign(body) },
      body,
      'host-1',
      '2026-07-15T00:00:00.000Z',
    );
    expect(verifyForgejoWebhook(d, SECRET).valid).toBe(true);
  });
  it('header names are matched case-insensitively', () => {
    const body = JSON.stringify({ action: 'opened' });
    const d = parseForgejoDelivery(
      { 'X-Forgejo-Event': 'pull_request', 'X-Forgejo-Signature': sign(body) },
      body,
      'host-1',
      '2026-07-15T00:00:00.000Z',
    );
    expect(d.eventType).toBe('pull_request');
    expect(verifyForgejoWebhook(d, SECRET).valid).toBe(true);
  });
});

describe('Forgejo webhook 归一化', () => {
  it('pull_request opened → change-request.opened', () => {
    const [event] = normalizeForgejoWebhook(
      delivery('pull_request', {
        action: 'opened',
        repository,
        pull_request: {
          id: 5001,
          number: 7,
          head: { sha: 'aaaa', ref: 'f' },
          base: { sha: 'bbbb', ref: 'main' },
        },
        sender: { id: 7, login: 'alice' },
      }),
    );
    expect(event).toMatchObject({ type: 'change-request.opened', headSha: 'aaaa' });
    if (event?.type === 'change-request.opened') {
      expect(event.change.number).toBe(7);
      expect(event.change.repo.namespace).toBe('acme');
    }
  });

  it('pull_request:head/base 仓库不同 → sourceIsFork', () => {
    const forkOf = (headRepo: unknown) => {
      const [event] = normalizeForgejoWebhook(
        delivery('pull_request', {
          action: 'opened',
          repository,
          pull_request: {
            id: 5001,
            number: 7,
            head: { sha: 'aaaa', ref: 'main', repo: headRepo },
            base: { sha: 'bbbb', ref: 'main', repo: { id: 1 } },
          },
          sender: { id: 7, login: 'alice' },
        }),
      );
      return event?.type === 'change-request.opened' ? event.sourceIsFork : 'wrong-type';
    };
    expect(forkOf({ id: 1 })).toBe(false);
    expect(forkOf({ id: 2 })).toBe(true);
    expect(forkOf(null)).toBe(true);
  });

  it('pull_request synchronized → change-request.updated commit-pushed', () => {
    const [event] = normalizeForgejoWebhook(
      delivery('pull_request', {
        action: 'synchronized',
        before: 'oldd',
        repository,
        pull_request: {
          id: 5001,
          number: 7,
          head: { sha: 'newd', ref: 'f' },
          base: { sha: 'bbbb', ref: 'main' },
        },
        sender: { id: 7, login: 'alice' },
      }),
    );
    expect(event).toMatchObject({
      type: 'change-request.updated',
      reason: 'commit-pushed',
      headSha: 'newd',
      previousHeadSha: 'oldd',
    });
  });

  it.each(['labeled', 'unlabeled', 'label_updated'])(
    'pull_request %s → metadata update with the complete label mirror',
    (action) => {
      const [event] = normalizeForgejoWebhook(
        delivery('pull_request', {
          action,
          repository,
          pull_request: {
            id: 5001,
            number: 7,
            head: { sha: 'newd', ref: 'f' },
            base: { sha: 'bbbb', ref: 'main' },
            labels: [{ name: 'review' }, { name: 'security' }],
          },
          sender: { id: 7, login: 'alice' },
        }),
      );
      expect(event).toMatchObject({
        type: 'change-request.updated',
        reason: 'metadata-edited',
        labels: ['review', 'security'],
      });
    },
  );

  it('closed+merged → change-request.merged', () => {
    const [event] = normalizeForgejoWebhook(
      delivery('pull_request', {
        action: 'closed',
        repository,
        pull_request: {
          id: 5001,
          number: 7,
          merged: true,
          merge_commit_sha: 'mmmm',
          head: { sha: 'aaaa', ref: 'f' },
          base: { sha: 'bbbb', ref: 'main' },
        },
        sender: { id: 7, login: 'alice' },
      }),
    );
    expect(event).toMatchObject({ type: 'change-request.merged', mergeCommitSha: 'mmmm' });
  });

  it('recorded fixture: pull_request.opened → change-request.opened(§45.3)', () => {
    const body = readFileSync(resolve(fixturesDir, 'pull_request.opened.json'), 'utf8');
    const [event] = normalizeForgejoWebhook(
      parseForgejoDelivery(
        { 'x-forgejo-event': 'pull_request' },
        body,
        'host-1',
        '2026-07-15T00:00:00.000Z',
      ),
    );
    expect(event?.type).toBe('change-request.opened');
  });

  it('issue_comment on PR → comment.created', () => {
    const [event] = normalizeForgejoWebhook(
      delivery('issue_comment', {
        action: 'created',
        repository,
        issue: { id: 10, number: 7, pull_request: {} },
        comment: { id: 99, body: '@winnowl review', user: { id: 2, login: 'carol' } },
        sender: { id: 2, login: 'carol' },
      }),
    );
    expect(event?.type).toBe('comment.created');
    if (event?.type === 'comment.created') {
      expect(event.target.kind).toBe('change-request');
      expect(event.body).toBe('@winnowl review');
    }
  });

  it('editing a PR comment → comment.edited with the previous body, author and editor', () => {
    const [event] = normalizeForgejoWebhook(
      delivery('issue_comment', {
        action: 'edited',
        repository,
        issue: { id: 10, number: 7, pull_request: {} },
        comment: { id: 99, body: '- [x] box', user: { id: 1, login: 'winnowl' } },
        changes: { body: { from: '- [ ] box' } },
        sender: { id: 2, login: 'carol' },
      }),
    );
    expect(event).toMatchObject({
      type: 'comment.edited',
      previousBody: '- [ ] box',
      body: '- [x] box',
      author: { login: 'winnowl' },
      actor: { login: 'carol' },
    });
  });

  it.each([
    null,
    { action: 'opened', repository, pull_request: { head: null, base: {} } },
    { action: 'opened', repository, pull_request: { id: 1, number: 2, head: {}, base: {} } },
  ])('malformed-but-valid JSON is ignored instead of throwing: %j', (payload) => {
    expect(() => normalizeForgejoWebhook(delivery('pull_request', payload))).not.toThrow();
    expect(normalizeForgejoWebhook(delivery('pull_request', payload))[0]).toMatchObject({
      type: 'ignored',
    });
  });
});
