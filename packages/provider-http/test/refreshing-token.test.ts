import { describe, expect, it } from 'vitest';
import { createRefreshingToken } from '../src/index.js';

describe('createRefreshingToken', () => {
  it('缓存:未过期不重复刷新;格式带 scheme', async () => {
    let n = 0;
    const clock = 1000;
    const auth = createRefreshingToken({
      refresh: async () => { n += 1; return { token: `tok-${n}`, expiresAtMs: clock + 3600_000 }; },
      now: () => clock,
    });
    expect(await auth()).toBe('Bearer tok-1');
    expect(await auth()).toBe('Bearer tok-1'); // cached
    expect(n).toBe(1);
  });

  it('过期(含 skew)→ 刷新', async () => {
    let n = 0;
    let clock = 0;
    const auth = createRefreshingToken({
      refresh: async () => { n += 1; return { token: `tok-${n}`, expiresAtMs: clock + 100_000 }; },
      skewMs: 60_000,
      now: () => clock,
    });
    expect(await auth()).toBe('Bearer tok-1');
    clock = 50_000; // now+skew=110_000 >= 100_000 -> expired
    expect(await auth()).toBe('Bearer tok-2');
    expect(n).toBe(2);
  });

  it('scheme=token(Forgejo/PAT)', async () => {
    const auth = createRefreshingToken({ scheme: 'token', refresh: async () => ({ token: 'pat', expiresAtMs: Number.MAX_SAFE_INTEGER }) });
    expect(await auth()).toBe('token pat');
  });

  it('并发调用共享同一在途刷新(不重复打端点)', async () => {
    let n = 0;
    const auth = createRefreshingToken({
      refresh: async () => { n += 1; await new Promise((r) => setTimeout(r, 10)); return { token: `t-${n}`, expiresAtMs: Number.MAX_SAFE_INTEGER }; },
    });
    const [a, b, c] = await Promise.all([auth(), auth(), auth()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(n).toBe(1); // single refresh
  });
});
