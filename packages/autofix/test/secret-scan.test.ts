import { describe, expect, it } from 'vitest';
import { scanForSecrets, scanPatchAdditions } from '../src/index.js';

describe('secret-scan(§sandbox 安全套件)', () => {
  it('识别常见密钥类型', () => {
    expect(scanForSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')[0]?.kind).toBe('private-key');
    expect(scanForSecrets('key = AKIAIOSFODNN7EXAMPLE')[0]?.kind).toBe('aws-access-key');
    expect(scanForSecrets('token=ghp_' + 'a'.repeat(36))[0]?.kind).toBe('github-token');
    expect(scanForSecrets('xoxb-123456789012-abcdefghijkl')[0]?.kind).toBe('slack-token');
    expect(scanForSecrets('AIza' + 'a'.repeat(35))[0]?.kind).toBe('google-api-key');
    expect(scanForSecrets('sk_live_' + 'a'.repeat(28))[0]?.kind).toBe('stripe-secret-key');
  });

  it('干净代码无命中(低误报)', () => {
    expect(scanForSecrets('const timeout = 30;\nreturn a + b;')).toEqual([]);
    expect(scanForSecrets('// a normal comment with words')).toEqual([]);
  });

  it('命中行脱敏(不回显完整密钥)', () => {
    const hit = scanForSecrets('aws_key = AKIAIOSFODNN7EXAMPLE')[0]!;
    expect(hit.redactedLine).toContain('redacted');
    expect(hit.redactedLine).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('scanPatchAdditions 只扫新增行(+),不扫上下文/删除/文件头', () => {
    const patch = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x', // file header, not an addition
      '@@ -1 +1,2 @@',
      ' const a = 1;',
      '-const old = 2;',
      '+const key = "AKIAIOSFODNN7EXAMPLE";', // added secret → hit
    ].join('\n');
    const hits = scanPatchAdditions(patch);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('aws-access-key');
  });

  it('已存在密钥(仅在上下文/删除行)不算本次引入', () => {
    const patch = ['@@', ' existing = AKIAIOSFODNN7EXAMPLE', '-removed = ghp_' + 'a'.repeat(36), '+const clean = 1;'].join('\n');
    expect(scanPatchAdditions(patch)).toEqual([]);
  });
});
