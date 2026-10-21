import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch, isAuthed, recoverLostSession, startLogin } from '../src/lib/auth';

// The session lives in an httpOnly cookie; the frontend only reads a hint cookie.

function setHintCookie(value: string | null): void {
  if (value === null) {
    document.cookie = 'winnowl_authed=; Max-Age=0; path=/';
    return;
  }
  document.cookie = `winnowl_authed=${value}; path=/`;
}

const resp = (status: number, body: unknown = {}): Response =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

beforeEach(() => {
  setHintCookie(null);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('isAuthed(只看后端签发的提示 cookie)', () => {
  it('无提示 cookie → false', () => {
    expect(isAuthed()).toBe(false);
  });

  it('有提示 cookie → true(真正的会话在 httpOnly cookie 里,JS 读不到)', () => {
    setHintCookie('1');
    expect(isAuthed()).toBe(true);
  });
});

describe('startLogin(跳后端 start 端点)', () => {
  const location = { href: '', pathname: '/repos', search: '?page=2', assign: vi.fn() };
  beforeEach(() => {
    location.href = '';
    vi.stubGlobal('location', location);
  });

  it('默认带当前路径作为 next(登录后回到原处)', () => {
    startLogin();
    expect(location.href).toBe('/v1/auth/github/start?next=%2Frepos%3Fpage%3D2');
  });

  it('linkMode → mode=link,落点默认 /account', () => {
    startLogin({ linkMode: true });
    expect(location.href).toBe('/v1/auth/github/start?next=%2Faccount&mode=link');
  });

  it('外链 next 一律丢弃(开放重定向;后端还会再校验一次)', () => {
    startLogin({ next: 'https://evil.test/steal' });
    expect(location.href).toBe('/v1/auth/github/start?');
  });
});

describe('authFetch(cookie 自动附带)', () => {
  it('credentials include(API 可在另一主机)+ 活动租户头;不再附任何 Authorization', async () => {
    localStorage.setItem('winnowl_tenant', 't-1');
    const fetchMock = vi.fn().mockResolvedValue(resp(200));
    vi.stubGlobal('fetch', fetchMock);

    await authFetch('/v1/x');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(fetchMock.mock.calls[0][0]).toBe('/v1/x'); // no VITE_API_BASE → same origin
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['X-Tenant-Id']).toBe('t-1');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('401 → 跳登录并中断请求链(会话不可恢复,前端无 refresh 可做)', async () => {
    const location = { href: '', pathname: '/', search: '', assign: vi.fn() };
    vi.stubGlobal('location', location);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(401)));

    await expect(authFetch('/v1/x')).rejects.toThrow('session_expired');
    expect(location.href).toContain('/v1/auth/github/start');
  });
});

describe('recoverLostSession(提示 cookie 在、API 却是匿名)', () => {
  const location = { href: '', pathname: '/dashboard', search: '', assign: vi.fn() };
  beforeEach(() => {
    location.href = '';
    location.assign.mockReset();
    sessionStorage.clear();
    vi.stubGlobal('location', location);
  });

  it('clears the stale hint and starts one fresh login', () => {
    setHintCookie('1');
    expect(() => recoverLostSession()).toThrow('session_lost');
    expect(isAuthed()).toBe(false);
    expect(location.href).toContain('/v1/auth/github/start?next=%2Fdashboard');
  });

  it('stops instead of looping when the login comes back anonymous again', () => {
    expect(() => recoverLostSession()).toThrow('session_lost');
    location.href = '';
    expect(() => recoverLostSession()).toThrow('session_not_established');
    expect(location.href).toBe('');
    expect(location.assign).toHaveBeenCalledWith('/?auth_error=session_not_established');
  });
});
