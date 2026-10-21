import { describe, expect, it } from 'vitest';
import { REVIEW_LANGUAGES } from '@reviewbot/i18n';
import { languageInstruction } from '../src/index.js';

describe('languageInstruction(§37 i18n 共享工具)', () => {
  it('en / undefined → 空(默认英文)', () => {
    expect(languageInstruction(undefined)).toBe('');
    expect(languageInstruction('en')).toBe('');
  });

  it('受支持的非英文语言 → 指令含目标语言 + 保留代码标识符约束', () => {
    const s = languageInstruction('zh', 'finding claims, comments');
    expect(s).toContain('in Simplified Chinese');
    expect(s).toContain('finding claims, comments');
    expect(s).toContain('Keep code identifiers');
  });

  it('kinds 缺省用通用描述', () => {
    expect(languageInstruction('zh')).toContain('all user-facing output');
  });

  it('大小写不敏感:ZH → 归一化为 zh', () => {
    expect(languageInstruction('ZH')).toContain('in Simplified Chinese');
  });

  // Prompts must name the language, not the locale code: models misread `zh-Hant` and `pt`.
  it('指令里给的是语言名,不是 locale 码', () => {
    expect(languageInstruction('zh-Hant')).toContain('Traditional Chinese');
    expect(languageInstruction('zh-Hant')).not.toContain('in zh-Hant');
    expect(languageInstruction('pt')).toContain('Brazilian Portuguese');
  });

  it('十种语言都有翻译资产,非英文均下指令', () => {
    for (const lang of REVIEW_LANGUAGES) {
      if (lang === 'en') expect(languageInstruction(lang), lang).toBe('');
      else expect(languageInstruction(lang), lang).not.toBe('');
    }
  });

  // Region tags are hand-written in `.winnowl.yaml`; unrecognized ones would silently fall back to English.
  it('带地区的标签退到对应语言:zh-CN → 简体,zh-TW → 繁体,pt-BR → 葡语', () => {
    expect(languageInstruction('zh-CN')).toContain('Simplified Chinese');
    expect(languageInstruction('zh-TW')).toContain('Traditional Chinese');
    expect(languageInstruction('pt-BR')).toContain('Brazilian Portuguese');
    expect(languageInstruction('en-GB')).toBe('');
    expect(languageInstruction('zhfoo')).toBe('');
    expect(languageInstruction('zh-XX')).toContain('Simplified Chinese');
  });

  it('无翻译资产的语言 → 空,与模板同回退英文(不混合语言)', () => {
    expect(languageInstruction('nl')).toBe('');
    expect(languageInstruction('tlh')).toBe('');
  });
});
