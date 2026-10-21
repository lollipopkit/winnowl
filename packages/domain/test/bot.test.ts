import { afterEach, describe, expect, it } from 'vitest';
import { botMention, botName, isBotActor, isOwnBotLogin } from '../src/bot.js';

afterEach(() => {
  delete process.env.BOT_NAME;
});

describe('bot 身份(§26 自触发守卫)', () => {
  it('默认 winnowl;BOT_NAME 可覆盖(自托管改名后守卫跟着改名)', () => {
    expect(botName()).toBe('winnowl');
    expect(botMention()).toBe('@winnowl');
    process.env.BOT_NAME = 'acmebot';
    expect(botName()).toBe('acmebot');
    expect(isOwnBotLogin('acmebot[bot]')).toBe(true);
    expect(isOwnBotLogin('winnowl[bot]')).toBe(false);
  });

  it('认自己:GitHub 的 `<slug>[bot]` 与其他 forge 的裸账号名都算,大小写不敏感', () => {
    expect(isOwnBotLogin('winnowl[bot]')).toBe(true);
    expect(isOwnBotLogin('winnowl')).toBe(true);
    expect(isOwnBotLogin('Winnowl[bot]')).toBe(true);
    expect(isOwnBotLogin(' winnowl[bot] ')).toBe(true);
    expect(isOwnBotLogin('alice')).toBe(false);
    // A login sharing our prefix is not us (would silently drop a human's command).
    expect(isOwnBotLogin('winnowl-fan')).toBe(false);
    expect(isOwnBotLogin('coderabbitai[bot]')).toBe(false);
  });

  it('认第三方 bot:GitHub 给 type=bot,其余 forge 退到 `[bot]` 命名约定', () => {
    expect(isBotActor({ login: 'ci', type: 'bot' })).toBe(true);
    expect(isBotActor({ login: 'coderabbitai[bot]' })).toBe(true);
    expect(isBotActor({ login: 'alice', type: 'user' })).toBe(false);
  });
});
