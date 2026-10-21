import { describe, expect, it } from 'vitest';
import { guardMentions, neutralizeMentions, type RichComment, type SourceControlProvider } from '../src/index.js';

describe('neutralizeMentions', () => {
  it('neutralizes prose mentions, including scopes and teams', () => {
    expect(neutralizeMentions('cc @alice, (@bob) and @org/team')).toBe('cc @<!-- -->alice, (@<!-- -->bob) and @<!-- -->org/team');
    expect(neutralizeMentions('upgrade @babel/core')).toBe('upgrade @<!-- -->babel/core');
    expect(neutralizeMentions('> **Title**\n> @alice did it')).toBe('> **Title**\n> @<!-- -->alice did it');
  });

  it('leaves emails, URLs and versions alone', () => {
    const text = 'mail a@b.com, see https://medium.com/@alice/post, ?u=@x, lodash@4.17.21';
    expect(neutralizeMentions(text)).toBe(text);
  });

  it('leaves code and HTML comments alone', () => {
    const text = [
      'run `@winnowl review` or ``a ` @x``',
      '```ts',
      '@Injectable()',
      '```',
      '> ~~~',
      '> @decorator',
      '> ~~~',
      '<!-- winnowl:status @alice -->',
    ].join('\n');
    expect(neutralizeMentions(text)).toBe(text);
  });

  it('keeps allowed logins (case-insensitive) and is idempotent', () => {
    const once = neutralizeMentions('@Alice needs access; @bob.', ['alice']);
    expect(once).toBe('@Alice needs access; @<!-- -->bob.');
    expect(neutralizeMentions(once, ['alice'])).toBe(once);
  });

  it('treats an unclosed backtick run as prose', () => {
    expect(neutralizeMentions('a ` @x')).toBe('a ` @<!-- -->x');
  });
});

describe('guardMentions', () => {
  it('guards every outgoing body and keeps the rest of the provider intact', async () => {
    const sent: string[] = [];
    const record = (b: RichComment) => {
      sent.push(b.markdown);
      return Promise.resolve({ nativeId: '1' });
    };
    const raw = {
      kind: 'github',
      changes: { create: (_r: unknown, i: { body: RichComment }) => record(i.body) },
      discussions: {
        createTopLevelComment: (_t: unknown, b: RichComment) => record(b),
        createInlineComment: (_r: unknown, _a: unknown, b: RichComment) => record(b),
        reply: (_t: unknown, b: RichComment) => record(b),
        editComment: async (_c: unknown, b: RichComment) => void (await record(b)),
        createReviewBatch: async (_r: unknown, review: { summary?: RichComment; comments: { body: RichComment }[] }) => {
          await record(review.summary!);
          for (const c of review.comments) await record(c.body);
          return { nativeId: '1' };
        },
      },
      issues: {
        create: (_r: unknown, i: { body: RichComment }) => record(i.body),
        comment: (_r: unknown, b: RichComment) => record(b),
      },
      checks: { createOrUpdate: (_r: unknown, i: { summary?: string }) => record({ markdown: i.summary ?? '' }) },
    } as unknown as SourceControlProvider;
    const p = guardMentions(raw);
    const body = { markdown: '@x' };
    const idem = { key: 'k' };
    const any = {} as never;
    await p.changes.create(any, { title: 't', body } as never, idem);
    await p.discussions.createTopLevelComment(any, body, idem);
    await p.discussions.createInlineComment(any, any, body, idem);
    await p.discussions.reply(any, body, idem);
    await p.discussions.editComment(any, { markdown: '@x @y', mentions: ['y'] });
    await p.discussions.createReviewBatch!(any, { event: 'comment', summary: body, comments: [{ anchor: any, body }] }, idem);
    await p.issues.create(any, { title: 't', body }, idem);
    await p.issues.comment(any, body, idem);
    await p.checks.createOrUpdate(any, { name: 'n', status: 'completed', headSha: 's', summary: '@x' }, idem);
    expect(sent).toEqual([...Array(4).fill('@<!-- -->x'), '@<!-- -->x @y', ...Array(5).fill('@<!-- -->x')]);
    expect(p.kind).toBe('github');
  });
});
