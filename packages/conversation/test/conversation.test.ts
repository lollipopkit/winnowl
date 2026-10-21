import { describe, expect, it } from 'vitest';
import { COMMANDS, isReadOnlyIntent, parseCommand, requiresRebuildOnHeadChange } from '../src/index.js';

describe('parseCommand', () => {
  it('识别显式命令(含顺序:full review / fix all 优先)', () => {
    expect(parseCommand('@winnowl full review', 'winnowl')).toMatchObject({ intent: 'full-review', source: 'command' });
    expect(parseCommand('@winnowl review', 'winnowl')).toMatchObject({ intent: 'review' });
    expect(parseCommand('@winnowl fix all', 'winnowl')).toMatchObject({ intent: 'fix-all' });
    expect(parseCommand('@winnowl fix this', 'winnowl')).toMatchObject({ intent: 'fix-finding' });
    expect(parseCommand('@winnowl verify this', 'winnowl')).toMatchObject({ intent: 'reverify' });
  });

  it('approve: whole word only (a write action), with an optional plan id; never a read-only intent', () => {
    expect(parseCommand('@winnowl approve', 'winnowl')).toEqual({ intent: 'approve-plan', source: 'command' });
    expect(parseCommand('@winnowl approve 01a110da', 'winnowl')).toEqual({ intent: 'approve-plan', source: 'command', argument: '01a110da' });
    expect(parseCommand('@winnowl approved this already', 'winnowl')).toBeNull();
    expect(isReadOnlyIntent('approve-plan')).toBe(false);
    expect(parseCommand('@winnowl approve learning 3f9a1c2d', 'winnowl')).toEqual({ intent: 'approve-learning', source: 'command', argument: '3f9a1c2d' });
    expect(parseCommand('@winnowl propose learning org prefer explicit errors', 'winnowl')).toEqual({ intent: 'propose-learning', source: 'command', argument: 'org prefer explicit errors' });
    expect(isReadOnlyIntent('approve-learning')).toBe(false);
  });

  it('run 捕获命令参数', () => {
    expect(parseCommand('@winnowl run npm test', 'winnowl')).toMatchObject({ intent: 'run-command', argument: 'npm test' });
  });

  it('finishing / issue 命令(add comments / implement / generate diagram)', () => {
    expect(parseCommand('@winnowl add comments to parser', 'winnowl')).toMatchObject({ intent: 'add-comments', argument: 'to parser' });
    expect(parseCommand('@winnowl implement retry logic', 'winnowl')).toMatchObject({ intent: 'implement-issue', argument: 'retry logic' });
    expect(parseCommand('@winnowl generate diagram for auth flow', 'winnowl')).toMatchObject({ intent: 'generate-diagram', argument: 'for auth flow' });
    expect(parseCommand('@winnowl generate docs', 'winnowl')).toMatchObject({ intent: 'generate-docs' });
  });

  it('内置命令别名(§26.4 简写)', () => {
    expect(parseCommand('@winnowl r', 'winnowl')).toMatchObject({ intent: 'review', source: 'command' });
    expect(parseCommand('@winnowl rev', 'winnowl')).toMatchObject({ intent: 'review' });
    expect(parseCommand('@winnowl fr', 'winnowl')).toMatchObject({ intent: 'full-review' });
    expect(parseCommand('@winnowl gd auth flow', 'winnowl')).toMatchObject({ intent: 'generate-diagram', argument: 'auth flow' });
    expect(parseCommand('@winnowl diagram', 'winnowl')).toMatchObject({ intent: 'generate-diagram' });
    expect(parseCommand('@winnowl rv 5', 'winnowl')).toMatchObject({ intent: 'reverify', argument: '5' });
    expect(parseCommand('@winnowl config', 'winnowl')).toMatchObject({ intent: 'show-config' });
  });

  it('别名严格整词匹配:短别名不误吞主命令(r 不吞 run/resolve;f 不吞 fix/feedback)', () => {
    // the 'r' alias must not swallow run / resolve conflict / review
    expect(parseCommand('@winnowl run npm test', 'winnowl')).toMatchObject({ intent: 'run-command', argument: 'npm test' });
    expect(parseCommand('@winnowl resolve conflict in a.ts', 'winnowl')).toMatchObject({ intent: 'resolve-conflict' });
    expect(parseCommand('@winnowl review', 'winnowl')).toMatchObject({ intent: 'review' });
    // the 'f' alias must not swallow feedback / fix all
    expect(parseCommand('@winnowl feedback false-positive', 'winnowl')).toMatchObject({ intent: 'feedback' });
    expect(parseCommand('@winnowl fix all', 'winnowl')).toMatchObject({ intent: 'fix-all' });
    expect(parseCommand('@winnowl f this bug', 'winnowl')).toMatchObject({ intent: 'fix-finding', argument: 'this bug' });
  });

  it('feedback 命令捕获反馈类(§P5)', () => {
    expect(parseCommand('@winnowl feedback false-positive', 'winnowl')).toMatchObject({ intent: 'feedback', argument: 'false-positive' });
    expect(parseCommand('@winnowl feedback not-important', 'winnowl')).toMatchObject({ intent: 'feedback', argument: 'not-important' });
  });

  it('ignore / pause / resume 是显式命令(§26.4;此前只能落到分类器胡乱映射)', () => {
    expect(parseCommand('@winnowl ignore', 'winnowl')).toMatchObject({ intent: 'ignore-finding', source: 'command' });
    expect(parseCommand('@winnowl unignore', 'winnowl')).toMatchObject({ intent: 'unignore-finding', source: 'command' });
    expect(parseCommand('@winnowl ignore pr', 'winnowl')).toMatchObject({ intent: 'ignore-pr', source: 'command' });
    expect(parseCommand('@winnowl pause', 'winnowl')).toMatchObject({ intent: 'pause-reviews', source: 'command' });
    expect(parseCommand('@winnowl resume', 'winnowl')).toMatchObject({ intent: 'resume-reviews', source: 'command' });
    expect(parseCommand('@winnowl unpause', 'winnowl')).toMatchObject({ intent: 'resume-reviews' });
    expect(parseCommand('@winnowl resolve conflict in a.ts', 'winnowl')).toMatchObject({ intent: 'resolve-conflict' });
    expect(parseCommand('@winnowl review', 'winnowl')).toMatchObject({ intent: 'review' });
  });

  it('默认要求 @mention;命令锚定在开头', () => {
    expect(parseCommand('review the auth module', 'winnowl')).toBeNull();
    expect(parseCommand('review the auth module', 'winnowl', { requireMention: false })).toMatchObject({ intent: 'review' });
  });

  it('非命令 → null(交给分类)', () => {
    expect(parseCommand('@winnowl 这个竞态真的可达吗?', 'winnowl')).toBeNull();
  });
});

describe('requiresRebuildOnHeadChange(§26.6)', () => {
  it('review/fix 需重建;纯解释可继续', () => {
    expect(requiresRebuildOnHeadChange('review')).toBe(true);
    expect(requiresRebuildOnHeadChange('fix-finding')).toBe(true);
    expect(requiresRebuildOnHeadChange('explain-finding')).toBe(false);
    expect(requiresRebuildOnHeadChange('help')).toBe(false);
  });
});

describe('isReadOnlyIntent(§26.3 bot 作者 + 分类来源两道守卫共用)', () => {
  it('只读意图放行,写意图一律挡(白名单:新增意图默认被挡)', () => {
    // Write intents: neither the classifier nor a bot author may trigger them.
    expect(isReadOnlyIntent('ignore-finding')).toBe(false);
    expect(isReadOnlyIntent('unignore-finding')).toBe(false);
    expect(isReadOnlyIntent('ignore-pr')).toBe(false);
    expect(isReadOnlyIntent('pause-reviews')).toBe(false);
    expect(isReadOnlyIntent('resume-reviews')).toBe(false);
    expect(isReadOnlyIntent('review')).toBe(true);
    expect(isReadOnlyIntent('explain-finding')).toBe(true);
    expect(isReadOnlyIntent('reverify')).toBe(true);
    expect(isReadOnlyIntent('fix-finding')).toBe(false);
    expect(isReadOnlyIntent('fix-all')).toBe(false);
    expect(isReadOnlyIntent('implement-issue')).toBe(false);
    expect(isReadOnlyIntent('create-issue')).toBe(false);
    expect(isReadOnlyIntent('run-command')).toBe(false);
    expect(isReadOnlyIntent('generate-tests')).toBe(false);
    expect(isReadOnlyIntent('propose-learning')).toBe(false);
  });
});

describe('command catalog', () => {
  it('every listed command parses back to its own intent, so help and the agent never offer a dead command', () => {
    for (const c of COMMANDS) {
      const typed = c.usage.replace(/<[^>]+>/g, 'x').replace(/\[[^\]]+\]/g, '').trim();
      expect(parseCommand(`@winnowl ${typed}`, 'winnowl')?.intent, c.usage).toBe(c.intent);
    }
    expect(parseCommand('@winnowl resolve conflict', 'winnowl')?.intent).toBe('resolve-conflict');
    expect(parseCommand('@winnowl resolve fixed in abc123', 'winnowl')).toEqual({ intent: 'resolve-finding', source: 'command', argument: 'fixed in abc123' });
  });
});
