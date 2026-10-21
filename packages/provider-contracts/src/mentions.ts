import type { ChangeRequestApi, CheckApi, DiscussionApi, IssueApi, SourceControlProvider } from './provider.js';
import type { RichComment } from './messaging.js';

/**
 * Neutralises `@name` as `@<!-- -->name` (renders the same, no notification) except logins in `allow`,
 * so attacker-controlled PR text echoed by the LLM cannot ping arbitrary users. Code spans and HTML
 * comments are left as is: `@` there does not notify, and inserting a comment would show or break it.
 */
export function neutralizeMentions(markdown: string, allow: readonly string[] = []): string {
  const allowed = new Set(allow.map((l) => l.toLowerCase()));
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; len: number } | null = null;
  const flush = () => {
    if (prose.length) out.push(neutralizeProse(prose.join('\n'), allowed));
    prose = [];
  };
  for (const line of markdown.split('\n')) {
    const m = /^(?:[ \t]*>)*[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len && !line.slice(m[0].length).trim()) fence = null;
    } else if (m && !(m[1]![0] === '`' && line.slice(m[0].length).includes('`'))) {
      flush();
      out.push(line);
      fence = { char: m[1]![0]!, len: m[1]!.length };
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** HTML comment | inline code | `@name` not preceded by a word char or URL fragment. */
const PROSE_TOKEN = /<!--[\s\S]*?-->|(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|(?<![\w/=.:@`-])@([A-Za-z0-9_][\w.-]*)/g;

function neutralizeProse(text: string, allowed: ReadonlySet<string>): string {
  return text.replace(PROSE_TOKEN, (whole, _ticks: string | undefined, name: string | undefined) => {
    if (name === undefined || allowed.has(name.replace(/[.-]+$/, '').toLowerCase())) return whole;
    return `@<!-- -->${name}`;
  });
}

const guard = (body: RichComment): RichComment => ({ markdown: neutralizeMentions(body.markdown, body.mentions) });

/**
 * Applies `neutralizeMentions` to every outgoing body at one exit point. `updateDescription` is
 * excluded: the description contains user text, so only winnowl's own section is neutralised.
 */
export function guardMentions<P extends SourceControlProvider>(provider: P): P {
  const { changes, discussions, issues, checks } = provider;
  const guardedChanges: ChangeRequestApi = {
    ...changes,
    create: (repo, input, idem) => changes.create(repo, { ...input, body: guard(input.body) }, idem),
  };
  const guardedDiscussions: DiscussionApi = {
    ...discussions,
    createTopLevelComment: (target, body, idem) => discussions.createTopLevelComment(target, guard(body), idem),
    createInlineComment: (ref, anchor, body, idem) => discussions.createInlineComment(ref, anchor, guard(body), idem),
    reply: (thread, body, idem) => discussions.reply(thread, guard(body), idem),
    editComment: (comment, body) => discussions.editComment(comment, guard(body)),
  };
  const { createReviewBatch } = discussions;
  if (createReviewBatch) {
    guardedDiscussions.createReviewBatch = (ref, review, idem) =>
      createReviewBatch(
        ref,
        {
          ...review,
          ...(review.summary ? { summary: guard(review.summary) } : {}),
          comments: review.comments.map((c) => ({ ...c, body: guard(c.body) })),
        },
        idem,
      );
  }
  const guardedIssues: IssueApi = {
    ...issues,
    create: (repo, input, idem) => issues.create(repo, { ...input, body: guard(input.body) }, idem),
    comment: (ref, body, idem) => issues.comment(ref, guard(body), idem),
  };
  const guardedChecks: CheckApi = {
    ...checks,
    createOrUpdate: (repo, input, idem) =>
      checks.createOrUpdate(repo, input.summary === undefined ? input : { ...input, summary: neutralizeMentions(input.summary) }, idem),
  };
  // Prototype is the original instance, so all other members stay available.
  return Object.assign(Object.create(provider) as P, {
    changes: guardedChanges,
    discussions: guardedDiscussions,
    issues: guardedIssues,
    checks: guardedChecks,
  });
}
