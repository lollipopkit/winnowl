import { describe, expect, it } from 'vitest';
import { REVIEW_LANGUAGES } from '@reviewbot/i18n';
import { botMessages } from '../src/locale.js';
import { locales } from '../src/i18n/i18n-util.js';

describe('botMessages — bot 输出 i18n(§37 typesafe-i18n)', () => {
  it('按语言分派固定文案;未知/缺省语言回退英文(base locale)', () => {
    expect(botMessages('en').conversation.autofixDisabled()).toContain('Autofix is disabled');
    expect(botMessages('zh').conversation.autofixDisabled()).toContain('autofix 已被仓库配置禁用');
    expect(botMessages('xx').conversation.autofixDisabled()).toContain('Autofix is disabled'); // fallback
    expect(botMessages(undefined).enrich.triage()).toBe('Issue triage'); // fallback
    expect(botMessages('ZH').enrich.triage()).toBe('Issue 分诊'); // case-insensitive
  });

  // Region tags (zh-CN, pt-BR, as users write them in .winnowl.yaml) must resolve to their dictionary.
  it('带地区的标签退到对应语言;中文按书写系统而非地区分', () => {
    expect(botMessages('zh-CN').enrich.triage()).toBe('Issue 分诊');
    expect(botMessages('zh-Hant').enrich.triage()).toBe('Issue 分診');
    expect(botMessages('zh-TW').enrich.triage()).toBe('Issue 分診'); // TW/HK/MO → Traditional
    expect(botMessages('zh-MY').enrich.triage()).toBe('Issue 分诊'); // other zh-* → Simplified
    expect(botMessages('zh-Hans-CN').enrich.triage()).toBe('Issue 分诊');
    expect(botMessages('pt-BR').enrich.triage()).not.toBe('Issue triage');
    expect(botMessages('en-GB').enrich.triage()).toBe('Issue triage');
  });

  it('十种语言都有字典,非英文均不回退英文', () => {
    expect([...locales].sort()).toEqual([...REVIEW_LANGUAGES].sort());
    for (const lang of REVIEW_LANGUAGES.filter((language) => language !== 'en')) {
      expect(botMessages(lang).enrich.triage(), lang).not.toBe('Issue triage');
    }
  });

  it('参数插值:commandNotApplicable/proposalFooter/cannotGenerate/followUpBody', () => {
    expect(botMessages('zh').conversation.commandNotApplicable({ intent: 'foo', bot: '@winnowl' })).toContain('`foo`');
    const footer = botMessages('en').conversation.proposalFooter({ planId: 'P1', bot: '@winnowl' });
    expect(footer).toContain('`@winnowl approve`');
    expect(footer).toContain('`P1`');
    expect(botMessages('zh').explain.cannotGenerate({ claim: 'bug X' })).toContain('bug X');
    expect(botMessages('en').postMerge.followUpBody({ reason: 'r', cr: '7' })).toContain('#7');
  });

  it('命名空间(conversation/enrich/explain/postMerge)均本地化', () => {
    const zh = botMessages('zh');
    expect(zh.enrich.canStartAgentYes()).toContain('可启动 Coding Agent:是');
    expect(zh.explain.noFinding()).toBe('未找到可解释的活跃 Finding。');
    expect(zh.postMerge.reviewNote()).toContain('未经 sandbox 验证');
  });

  it('delivery:@mention 由 {bot} 参数注入(非硬编码),命令词保持字面', () => {
    const body = botMessages('en').delivery.autofixBody({
      findings: 'a, b',
      residual: '',
      bot: '@winnowl',
    });
    expect(body).toContain('`@winnowl fix`'); // the bot name is configurable; the fix command is not translated
    expect(body).not.toContain('@reviewbot');
    const impl = botMessages('zh').delivery.implementBody({ issue: '42', bot: '@mybot' });
    expect(impl).toContain('#42');
    expect(impl).toContain('`@mybot implement`');
  });

  it('新增发布路径:postMerge reason / autoIssue 页脚(bot 参数化)/ checks 标题', () => {
    // post-merge action reasons are localized from typed reason codes.
    expect(botMessages('zh').postMerge.reasonContractChange()).toBe('契约面变化，刷新生成客户端');
    expect(botMessages('en').postMerge.reasonMigrationChange()).toContain('migration change');
    // auto-issue footer: bot name and label are parameters.
    const footer = botMessages('en').autoIssue.footer({ bot: 'winnowl', label: 'ai-found' });
    expect(footer).toContain('Auto-filed by winnowl (ai-found)');
    expect(footer).not.toContain('reviewbot');
    expect(botMessages('zh').autoIssue.footer({ bot: 'winnowl', label: 'ai-found' })).toContain(
      '自动建档',
    );
    expect(botMessages('en').checks.title({ blocking: 2, inline: 3 })).toBe(
      '2 blocking finding(s), 3 inline',
    );
    expect(botMessages('zh').checks.title({ blocking: 1, inline: 0 })).toContain(
      '1 个阻断性 finding',
    );
  });
});
