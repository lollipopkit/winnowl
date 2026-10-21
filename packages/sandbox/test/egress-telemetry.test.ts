import { describe, expect, it } from 'vitest';
import { buildEgressProxyConfig } from '../src/index.js';

// A missing telemetry host in the allowlist silently empties traces of sandboxed reviews.
describe('egress allowlist 含遥测端点(§可观测性)', () => {
  it('公网遥测主机进 allowlist,与 LLM 网关并列', () => {
    const { allowedHosts, squidConf } = buildEgressProxyConfig({
      mode: 'allowlist',
      hosts: ['llm.example.com', 'langfuse.example.com'],
    });
    expect(allowedHosts).toContain('langfuse.example.com');
    expect(squidConf).toContain('langfuse.example.com');
  });

  it('未列出的主机不在 allowlist(默认拒绝仍然成立)', () => {
    const { allowedHosts } = buildEgressProxyConfig({ mode: 'allowlist', hosts: ['llm.example.com'] });
    expect(allowedHosts).not.toContain('langfuse.example.com');
    expect(allowedHosts).not.toContain('example.com');
  });
});
