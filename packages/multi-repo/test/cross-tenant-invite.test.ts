import { describe, expect, it } from 'vitest';
import { createCrossTenantInvite, verifyCrossTenantInvite } from '../src/index.js';

const SECRET = 'test-cross-tenant-secret';
const base = { targetTenantId: 't-downstream', targetRepositoryId: 'repo-1', kind: 'library-dependent' };

describe('跨租户邀请令牌(§32,0042;自描述+签名,兑换不查库)', () => {
  it('签发 → 校验往返出原载荷', () => {
    const token = createCrossTenantInvite(SECRET, { ...base, now: 1_000 });
    const payload = verifyCrossTenantInvite(SECRET, token, 2_000);
    expect(payload).toMatchObject(base);
    expect(payload!.expiresAt).toBe(1_000 + 7 * 24 * 60 * 60 * 1000);
  });

  it('换密钥 → 拒绝(租户无法伪造他人身份)', () => {
    const token = createCrossTenantInvite(SECRET, base);
    expect(verifyCrossTenantInvite('another-secret', token)).toBeNull();
  });

  it('篡改载荷(想把 target 改成别的租户)→ 签名失配拒绝', () => {
    const token = createCrossTenantInvite(SECRET, base);
    const [body, sig] = token.split('.');
    const tampered = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<string, unknown>;
    tampered.targetTenantId = 'victim-tenant';
    const forged = `${Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url')}.${sig}`;
    expect(verifyCrossTenantInvite(SECRET, forged)).toBeNull();
  });

  it('过期 → 拒绝', () => {
    const token = createCrossTenantInvite(SECRET, { ...base, now: 0, ttlMs: 1_000 });
    expect(verifyCrossTenantInvite(SECRET, token, 999)).not.toBeNull();
    expect(verifyCrossTenantInvite(SECRET, token, 1_001)).toBeNull();
  });

  it('格式垃圾/空密钥 → 拒绝,不抛', () => {
    expect(verifyCrossTenantInvite(SECRET, 'not-a-token')).toBeNull();
    expect(verifyCrossTenantInvite(SECRET, '')).toBeNull();
    expect(verifyCrossTenantInvite(SECRET, 'aaa.bbb')).toBeNull();
    expect(verifyCrossTenantInvite('', createCrossTenantInvite(SECRET, base))).toBeNull();
    expect(() => createCrossTenantInvite('', base)).toThrow(/签名密钥/);
  });
});
