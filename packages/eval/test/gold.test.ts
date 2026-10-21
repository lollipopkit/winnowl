import { describe, expect, it } from 'vitest';
import { parseCodeRabbitFinding, parseCodeRabbitGold, type CodeRabbitComment } from '../src/index.js';

describe('parseCodeRabbitFinding(gold 解析,§45)', () => {
  const c = (path: string, body: string): CodeRabbitComment => ({ path, body });

  it('Potential issue → correctness/high', () => {
    expect(parseCodeRabbitFinding(c('lib/a.dart', '⚠️ Potential issue\n\nThis null check is missing.'))).toEqual({ category: 'correctness', severity: 'high', path: 'lib/a.dart' });
  });
  it('security 关键词 → security/high', () => {
    expect(parseCodeRabbitFinding(c('lib/auth.dart', 'Possible SQL injection via string concat.'))?.category).toBe('security');
  });
  it('Nitpick → style/info', () => {
    expect(parseCodeRabbitFinding(c('lib/x.dart', '🧹 Nitpick: rename variable for clarity.'))).toMatchObject({ category: 'style', severity: 'info' });
  });
  it('Refactor suggestion → maintainability/low', () => {
    expect(parseCodeRabbitFinding(c('lib/x.dart', '🛠️ Refactor suggestion: extract method to reduce complexity.'))?.category).toBe('maintainability');
  });
  it('performance → performance/medium(须与生产 FindingCategory 对齐,非 "efficiency")', () => {
    expect(parseCodeRabbitFinding(c('lib/x.dart', 'This is inefficient; consider caching.'))).toMatchObject({ category: 'performance', severity: 'medium' });
  });
  it('无信号 / 无 path → null(不臆造 gold)', () => {
    expect(parseCodeRabbitFinding(c('lib/x.dart', 'LGTM, nice work!'))).toBeNull();
    expect(parseCodeRabbitFinding(c('', 'Potential issue'))).toBeNull();
  });
  it('批量丢弃无法识别项', () => {
    const gold = parseCodeRabbitGold([c('a.dart', 'Potential issue: bug'), c('b.dart', 'thanks!'), c('c.dart', 'Nitpick: typo')]);
    expect(gold).toHaveLength(2);
    expect(gold.map((g) => g.path)).toEqual(['a.dart', 'c.dart']);
  });
});

describe('parseCodeRabbitFinding — CodeRabbit 自带结构化标注优先(§45,比关键词猜测可靠)', () => {
  const c = (path: string, body: string): CodeRabbitComment => ({ path, body });

  it('真实标注格式(Functional Correctness | Major)→ correctness/high,即使正文没有触发关键词', () => {
    // The body contains no MARKERS keyword, so only the label can classify it.
    const body = '_🎯 Functional Correctness_ | _🟡 Minor_ | _⚡ Quick win_\n\n**Handle `Network is unreachable` too**\n\nOnly matches one wording.';
    expect(parseCodeRabbitFinding(c('lib/x.dart', body))).toEqual({ category: 'correctness', severity: 'medium', path: 'lib/x.dart' });
  });
  it('Security & Privacy | Major → security/high', () => {
    const body = '_🔒 Security & Privacy_ | _🟠 Major_ | _⚡ Quick win_\n\nAdd an explicit least-privilege permissions block.';
    expect(parseCodeRabbitFinding(c('.github/workflows/x.yml', body))).toEqual({ category: 'security', severity: 'high', path: '.github/workflows/x.yml' });
  });
  it('Stability & Availability | Major → reliability/high', () => {
    const body = '_🩺 Stability & Availability_ | _🟠 Major_ | _⚡ Quick win_\n\nInitialize Computer.shared even when serversCount == 0.';
    expect(parseCodeRabbitFinding(c('lib/main.dart', body))?.category).toBe('reliability');
  });
  it('标注存在但 severity 无法识别 → 退化关键词兜底(命中 Potential issue → correctness/high)', () => {
    const body = '_🎯 Functional Correctness_ | _🔵 Unknown_ | _⚡ Quick win_\n\nPotential issue: something is off.';
    expect(parseCodeRabbitFinding(c('lib/x.dart', body))).toEqual({ category: 'correctness', severity: 'high', path: 'lib/x.dart' });
  });
  it('无标注(旧格式评论)仍走关键词兜底,行为不变', () => {
    expect(parseCodeRabbitFinding(c('lib/a.dart', '⚠️ Potential issue\n\nThis null check is missing.'))).toEqual({ category: 'correctness', severity: 'high', path: 'lib/a.dart' });
  });
});

import { codeRabbitCommentsFrom, goldFromReviewComments, groupCodeRabbitCommentsByCommit, type GhReviewComment } from '../src/index.js';

describe('GitHub review comments → CodeRabbit gold(§45)', () => {
  const comments: GhReviewComment[] = [
    { path: 'lib/a.dart', line: 10, body: '⚠️ Potential issue: null deref', user: { login: 'coderabbitai[bot]' } },
    { path: 'lib/b.dart', body: 'LGTM', user: { login: 'coderabbitai[bot]' } }, // no signal: dropped
    { path: 'lib/c.dart', body: '⚠️ Potential issue: race', user: { login: 'human-reviewer' } }, // not the bot: dropped
  ];
  it('仅取 CodeRabbit bot 评论', () => {
    expect(codeRabbitCommentsFrom(comments).map((c) => c.path)).toEqual(['lib/a.dart', 'lib/b.dart']);
  });
  it('过滤 + 解析 → 仅可识别的 gold', () => {
    const gold = goldFromReviewComments(comments);
    expect(gold).toEqual([{ category: 'correctness', severity: 'high', path: 'lib/a.dart' }]);
  });
});

describe('groupCodeRabbitCommentsByCommit(§45 gold 对齐评审时的 commit,非最终 head)', () => {
  it('按 original_commit_id 分组,非 bot 评论不进任何组', () => {
    const comments: GhReviewComment[] = [
      { path: 'a.dart', body: 'Potential issue: x', user: { login: 'coderabbitai[bot]' }, original_commit_id: 'sha1' },
      { path: 'b.dart', body: 'Potential issue: y', user: { login: 'coderabbitai[bot]' }, original_commit_id: 'sha1' },
      { path: 'c.dart', body: 'Potential issue: z', user: { login: 'coderabbitai[bot]' }, original_commit_id: 'sha2' },
      { path: 'd.dart', body: 'Potential issue: w', user: { login: 'human-reviewer' }, original_commit_id: 'sha1' },
    ];
    const groups = groupCodeRabbitCommentsByCommit(comments);
    expect([...groups.keys()].sort()).toEqual(['sha1', 'sha2']);
    expect(groups.get('sha1')?.map((c) => c.path)).toEqual(['a.dart', 'b.dart']);
    expect(groups.get('sha2')?.map((c) => c.path)).toEqual(['c.dart']);
  });
  it('缺 original_commit_id 归入空串 key', () => {
    const comments: GhReviewComment[] = [{ path: 'a.dart', body: 'Potential issue: x', user: { login: 'coderabbitai[bot]' } }];
    const groups = groupCodeRabbitCommentsByCommit(comments);
    expect([...groups.keys()]).toEqual(['']);
  });
});
