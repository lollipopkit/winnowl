import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawWebhookDelivery } from '@reviewbot/provider-contracts';
import {
  normalizeGithubWebhook,
  parseGithubDelivery,
  verifyGithubWebhook,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../../fixtures/github');

function loadFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), 'utf8');
}

const SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

function delivery(eventType: string, body: string, signature?: string): RawWebhookDelivery {
  return parseGithubDelivery(
    {
      'x-github-event': eventType,
      'x-github-delivery': 'delivery-1',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    body,
    'host-1',
    '2026-07-15T00:00:00.000Z',
  );
}

describe('GitHub webhook 验签', () => {
  const body = loadFixture('pull_request.opened.json');

  it('正确签名通过', () => {
    const result = verifyGithubWebhook(delivery('pull_request', body, sign(body)), SECRET);
    expect(result.valid).toBe(true);
  });

  it('错误密钥失败', () => {
    const result = verifyGithubWebhook(delivery('pull_request', body, sign(body)), 'wrong');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('缺失签名头失败', () => {
    const result = verifyGithubWebhook(delivery('pull_request', body), SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_signature');
  });

  it('篡改 body 后签名失配', () => {
    const tampered = body.replace('opened', 'closed');
    const result = verifyGithubWebhook(delivery('pull_request', tampered, sign(body)), SECRET);
    expect(result.valid).toBe(false);
  });

  it('header names are matched case-insensitively', () => {
    const raw = parseGithubDelivery(
      {
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'mixed-case',
        'X-Hub-Signature-256': sign(body),
      },
      body,
      'host-1',
      '2026-07-15T00:00:00.000Z',
    );
    expect(raw.eventType).toBe('pull_request');
    expect(raw.deliveryId).toBe('mixed-case');
    expect(verifyGithubWebhook(raw, SECRET).valid).toBe(true);
  });
});

describe('GitHub webhook 归一化', () => {
  it('pull_request:head/base 仓库不同(或 fork 已删)→ sourceIsFork,缺仓库信息则省略', () => {
    const fixture = JSON.parse(loadFixture('pull_request.opened.json'));
    const withRepos = (head: unknown, base: unknown) => {
      const [event] = normalizeGithubWebhook(
        delivery(
          'pull_request',
          JSON.stringify({
            ...fixture,
            pull_request: {
              ...fixture.pull_request,
              head: { ...fixture.pull_request.head, repo: head },
              base: { ...fixture.pull_request.base, repo: base },
            },
          }),
        ),
      );
      return event?.type === 'change-request.opened' ? event.sourceIsFork : 'wrong-type';
    };
    expect(withRepos({ id: 1 }, { id: 1 })).toBe(false);
    expect(withRepos({ id: 2 }, { id: 1 })).toBe(true);
    expect(withRepos(null, { id: 1 })).toBe(true);
    expect(withRepos(undefined, { id: 1 })).toBeUndefined();
  });

  it('pull_request.opened → change-request.opened(含分支/SHA/draft)', () => {
    const body = loadFixture('pull_request.opened.json');
    const [event] = normalizeGithubWebhook(delivery('pull_request', body));
    expect(event).toMatchObject({
      type: 'change-request.opened',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sourceBranch: 'feature/login',
      targetBranch: 'main',
      draft: false,
    });
    if (event?.type === 'change-request.opened') {
      expect(event.change.number).toBe(42);
      expect(event.change.repo.namespace).toBe('acme');
      expect(event.change.repo.name).toBe('app');
      expect(event.actor.login).toBe('alice');
    }
  });

  it('synchronize → change-request.updated(commit-pushed,含 previousHeadSha)', () => {
    const body = JSON.stringify({
      action: 'synchronize',
      before: 'cccc',
      after: 'dddd',
      pull_request: {
        id: 1,
        number: 3,
        head: { sha: 'dddd', ref: 'f' },
        base: { sha: 'eeee', ref: 'main' },
      },
      repository: {
        id: 1,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      sender: { id: 1, login: 'bob', type: 'User' },
    });
    const [event] = normalizeGithubWebhook(delivery('pull_request', body));
    expect(event).toMatchObject({
      type: 'change-request.updated',
      reason: 'commit-pushed',
      headSha: 'dddd',
      previousHeadSha: 'cccc',
      reviewers: [],
    });
  });

  it('closed + merged → change-request.merged', () => {
    const body = JSON.stringify({
      action: 'closed',
      pull_request: {
        id: 1,
        number: 3,
        merged: true,
        merge_commit_sha: 'mmmm',
        head: { sha: 'h', ref: 'f' },
        base: { sha: 'b', ref: 'main' },
      },
      repository: {
        id: 1,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      sender: { id: 1, login: 'bob', type: 'User' },
    });
    const [event] = normalizeGithubWebhook(delivery('pull_request', body));
    expect(event).toMatchObject({ type: 'change-request.merged', mergeCommitSha: 'mmmm' });
  });

  it('issue_comment on PR → comment.created(target=change-request)', () => {
    const body = JSON.stringify({
      action: 'created',
      issue: { id: 10, number: 42, pull_request: { url: 'x' } },
      comment: { id: 99, body: '@winnowl review', user: { id: 2, login: 'carol', type: 'User' } },
      repository: {
        id: 1,
        name: 'app',
        default_branch: 'main',
        clone_url: 'x',
        owner: { login: 'acme' },
      },
      sender: { id: 2, login: 'carol', type: 'User' },
    });
    const [event] = normalizeGithubWebhook(delivery('issue_comment', body));
    expect(event?.type).toBe('comment.created');
    if (event?.type === 'comment.created') {
      expect(event.target.kind).toBe('change-request');
      expect(event.body).toBe('@winnowl review');
    }
  });

  it('pull_request_review_comment(行内)→ comment.created(target=change-request,§26)', () => {
    const body = JSON.stringify({
      action: 'created',
      pull_request: { id: 10, number: 42, draft: false },
      comment: { id: 77, body: '@winnowl explain this', user: { id: 2, login: 'carol', type: 'User' }, path: 'src/x.ts', line: 5 },
      repository: { id: 1, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
      sender: { id: 2, login: 'carol', type: 'User' },
    });
    const [event] = normalizeGithubWebhook(delivery('pull_request_review_comment', body));
    expect(event?.type).toBe('comment.created');
    if (event?.type === 'comment.created') {
      expect(event.target.kind).toBe('change-request');
      expect(event.commentNativeId).toBe('77');
      expect(event.body).toBe('@winnowl explain this');
      // New thread (no in_reply_to_id): thread id = the comment's own id.
      expect(event.reviewThread).toEqual({ path: 'src/x.ts', threadNativeId: '77' });
    }
  });

  it('回复 bot 的 finding 评论 → 线程 id 取 in_reply_to_id(首条),不是回复自身 id', () => {
    // Commands are replies; the thread id must be the first comment's, not the reply's.
    const body = JSON.stringify({
      action: 'created',
      pull_request: { id: 10, number: 42, draft: false },
      comment: { id: 99, in_reply_to_id: 77, body: '@winnowl ignore', user: { id: 2, login: 'carol', type: 'User' }, path: 'src/x.ts', line: 5 },
      repository: { id: 1, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
      sender: { id: 2, login: 'carol', type: 'User' },
    });
    const [event] = normalizeGithubWebhook(delivery('pull_request_review_comment', body));
    if (event?.type === 'comment.created') {
      expect(event.commentNativeId).toBe('99');
      expect(event.reviewThread).toEqual({ path: 'src/x.ts', threadNativeId: '77' });
    } else {
      throw new Error('expected comment.created');
    }
  });

  it('原生 stacked PR(2026-07-30 预览):pull_request.stack 归一化透传;非 stack 成员不带', () => {
    const stacked = JSON.stringify({
      action: 'opened',
      pull_request: {
        id: 10,
        number: 42,
        draft: false,
        head: { sha: 'aaaa', ref: 'feat/layer-2' },
        base: { sha: 'bbbb', ref: 'feat/layer-1' }, // direct base is the layer below
        stack: { id: 7, size: 3, position: 2, base: { ref: 'main', sha: 'cccc' } }, // the stack lands on main
      },
      repository: { id: 1, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
      sender: { id: 2, login: 'carol', type: 'User' },
    });
    const [event] = normalizeGithubWebhook(delivery('pull_request', stacked));
    if (event?.type === 'change-request.opened') {
      expect(event.targetBranch).toBe('feat/layer-1');
      expect(event.stack).toEqual({ id: '7', size: 3, position: 2, baseRef: 'main', baseSha: 'cccc' });
    } else {
      throw new Error('expected change-request.opened');
    }
    const plain = JSON.stringify({
      action: 'opened',
      pull_request: { id: 11, number: 43, draft: false, head: { sha: 'a', ref: 'feat/x' }, base: { sha: 'b', ref: 'main' } },
      repository: { id: 1, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
      sender: { id: 2, login: 'carol', type: 'User' },
    });
    const [plainEvent] = normalizeGithubWebhook(delivery('pull_request', plain));
    if (plainEvent?.type === 'change-request.opened') expect(plainEvent.stack).toBeUndefined();
  });

  it('workflow_run.completed → pipeline.completed(含 headSha/conclusion)', () => {
    const body = JSON.stringify({
      action: 'completed',
      workflow_run: { id: 555, head_sha: 'deadbeef', status: 'completed', conclusion: 'failure' },
      repository: { id: 1, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
      sender: { id: 2, login: 'ci', type: 'Bot' },
    });
    const [event] = normalizeGithubWebhook(delivery('workflow_run', body));
    expect(event?.type).toBe('pipeline.completed');
    if (event?.type === 'pipeline.completed') {
      expect(event.headSha).toBe('deadbeef');
      expect(event.conclusion).toBe('failure');
      expect(event.repo.repoNativeId).toBe('1');
    }
  });

  it('workflow_run 非 completed → ignored', () => {
    const body = JSON.stringify({ action: 'requested', workflow_run: { id: 1, head_sha: 'x', status: 'queued', conclusion: null }, repository: { id: 1, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } }, sender: { id: 2, login: 'ci', type: 'Bot' } });
    const [event] = normalizeGithubWebhook(delivery('workflow_run', body));
    expect(event).toEqual({ type: 'ignored', reason: 'workflow_run:requested' });
  });

  it('issues.opened → issue.opened(含标题/正文/编号)', () => {
    const body = JSON.stringify({
      action: 'opened',
      issue: { id: 321, number: 8, title: 'Crash on start', body: 'repro steps' },
      repository: { id: 1, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } },
      sender: { id: 2, login: 'dave', type: 'User' },
    });
    const [event] = normalizeGithubWebhook(delivery('issues', body));
    expect(event?.type).toBe('issue.opened');
    if (event?.type === 'issue.opened') {
      expect(event.number).toBe(8);
      expect(event.nativeId).toBe('321');
      expect(event.title).toBe('Crash on start');
    }
  });

  it('issues(PR 伪装)/非 opened → ignored', () => {
    const prLike = JSON.stringify({ action: 'opened', issue: { id: 1, number: 1, title: 't', body: '', pull_request: { url: 'x' } }, repository: { id: 1, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } }, sender: { id: 2, login: 'd', type: 'User' } });
    expect(normalizeGithubWebhook(delivery('issues', prLike))[0]).toEqual({ type: 'ignored', reason: 'issues:opened' });
    const edited = JSON.stringify({ action: 'edited', issue: { id: 1, number: 1, title: 't', body: '' }, repository: { id: 1, name: 'app', default_branch: 'main', clone_url: 'x', owner: { login: 'acme' } }, sender: { id: 2, login: 'd', type: 'User' } });
    expect(normalizeGithubWebhook(delivery('issues', edited))[0]).toEqual({ type: 'ignored', reason: 'issues:edited' });
  });

  it('表单模式(x-www-form-urlencoded)→ 取 payload 解码后归一化(§9.1)', () => {
    const json = loadFixture('pull_request.opened.json');
    const formBody = `payload=${encodeURIComponent(json)}`;
    const raw = parseGithubDelivery(
      { 'x-github-event': 'pull_request', 'x-github-delivery': 'd-form', 'content-type': 'application/x-www-form-urlencoded' },
      formBody,
      'host-1',
      '2026-07-17T00:00:00.000Z',
    );
    // The signature is verified on the raw form body.
    expect(verifyGithubWebhook({ ...raw, headers: { ...raw.headers, 'x-hub-signature-256': sign(formBody) } }, SECRET).valid).toBe(true);
    const [event] = normalizeGithubWebhook(raw);
    expect(event?.type).toBe('change-request.opened');
  });

  it('未处理事件 → ignored,不静默丢失', () => {
    const [event] = normalizeGithubWebhook(delivery('star', '{}'));
    expect(event).toEqual({ type: 'ignored', reason: 'unhandled_event:star' });
  });

  it('非法 JSON → ignored:invalid_json', () => {
    const [event] = normalizeGithubWebhook(delivery('pull_request', 'not json'));
    expect(event).toEqual({ type: 'ignored', reason: 'invalid_json' });
  });
});
