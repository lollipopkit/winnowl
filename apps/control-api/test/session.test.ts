import { describe, expect, it } from 'vitest';
import { clearCookie, parseCookies, serializeCookie } from '../src/auth/cookies.js';
import { cookieSecure, sessionKey, sessionTtlSec, signSession, verifySession } from '../src/auth/session.js';
import { allowedOrigins } from '../src/auth/csrf.js';
import { safeNext } from '../src/routes/auth.js';

const KEY = new Uint8Array(32).fill(9);
const OTHER = new Uint8Array(32).fill(8);
const CLAIMS = { userId: 'u-1', provider: 'github', issuer: 'https://github.com', subject: '10864310', login: 'lollipopkit' };

describe('cookie 读写', () => {
  it('解析 Cookie 头(忽略空段;重复名取第一个 —— 与浏览器发送顺序一致)', () => {
    expect(parseCookies('a=1; b=2;; a=3')).toEqual({ a: '1', b: '2' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('序列化带全部安全属性;清除 = Max-Age 0', () => {
    const c = serializeCookie('s', 'v', { httpOnly: true, secure: true, sameSite: 'Lax', maxAgeSec: 60 });
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Max-Age=60');
    expect(c).toContain('Expires=');
    expect(clearCookie('s', { httpOnly: true })).toContain('Max-Age=0');
  });

  it('值被转义(不可信内容不能越出 cookie 语法)', () => {
    expect(serializeCookie('s', 'a; Domain=evil.test').split(';')[0]).toBe('s=a%3B%20Domain%3Devil.test');
  });
});

describe('session 签发 / 验证', () => {
  it('签发 → 验回同一组 claims', async () => {
    const claims = await verifySession(await signSession(CLAIMS, { key: KEY }), KEY);
    expect(claims).toEqual(CLAIMS);
  });

  it('换 key / 篡改 / 过期 → null(不区分原因,一律当未登录)', async () => {
    const token = await signSession(CLAIMS, { key: KEY });
    expect(await verifySession(token, OTHER)).toBeNull();
    expect(await verifySession(`${token}x`, KEY)).toBeNull();
    const expired = await signSession(CLAIMS, { key: KEY, ttlSec: -10 });
    expect(await verifySession(expired, KEY)).toBeNull();
  });

  it('缺字段的 token 不被接受(载荷不完整就没法解析授权)', async () => {
    const { SignJWT } = await import('jose');
    const partial = await new SignJWT({ uid: 'u-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('1')
      .setIssuer('winnowl-control-api')
      .setAudience('winnowl-console')
      .setExpirationTime('1h')
      .sign(KEY);
    expect(await verifySession(partial, KEY)).toBeNull();
  });

  it('签名密钥:显式配置优先,其次从 KEK 派生,都没有 → 抛错(绝不用默认弱 key)', () => {
    const explicit = Buffer.alloc(32, 1).toString('base64');
    expect(Buffer.from(sessionKey({ SESSION_SIGNING_KEY: explicit })).toString('base64')).toBe(explicit);
    // Derived key differs from the KEK and is deterministic.
    const kek = Buffer.alloc(32, 2).toString('base64');
    const derived = Buffer.from(sessionKey({ KMS_KEK_BASE64: kek }));
    expect(derived.toString('base64')).not.toBe(kek);
    expect(Buffer.from(sessionKey({ KMS_KEK_BASE64: kek })).toString('base64')).toBe(derived.toString('base64'));
    expect(() => sessionKey({})).toThrow(/SESSION_SIGNING_KEY|KMS_KEK_BASE64/);
    expect(() => sessionKey({ SESSION_SIGNING_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32/);
  });

  it('TTL 与 Secure 的默认值稳妥(默认 7 天;Secure 默认开,只有显式 opt-out 才关)', () => {
    expect(sessionTtlSec({})).toBe(7 * 24 * 3600);
    expect(sessionTtlSec({ SESSION_TTL_SEC: '60' })).toBe(60);
    expect(sessionTtlSec({ SESSION_TTL_SEC: 'x' })).toBe(7 * 24 * 3600);
    expect(cookieSecure({})).toBe(true);
    expect(cookieSecure({ SESSION_COOKIE_INSECURE: '1' })).toBe(false);
  });
});

describe('登录跳转的落点(开放重定向防护)', () => {
  it('只接受站内绝对路径', () => {
    expect(safeNext('/repos?page=2')).toBe('/repos?page=2');
    expect(safeNext('https://evil.test')).toBe('/');
    expect(safeNext('//evil.test')).toBe('/'); // protocol-relative
    expect(safeNext('/\\evil.test')).toBe('/'); // browsers treat backslash as slash
    expect(safeNext(undefined)).toBe('/');
  });
});

describe('CSRF 来源白名单', () => {
  it('取 console 地址的 origin;配错的条目忽略而不是放宽', () => {
    const set = allowedOrigins({ CONSOLE_BASE_URL: 'https://console.test/path', CSRF_ALLOWED_ORIGINS: 'https://a.test, not-a-url' });
    expect([...set].sort()).toEqual(['https://a.test', 'https://console.test']);
    expect(allowedOrigins({}).size).toBe(0);
  });
});
