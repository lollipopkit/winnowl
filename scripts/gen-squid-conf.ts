// Generates the egress squid.conf: LLM gateway + plugin + scanner hosts; everything else denied.
// With LLM_RELAY_PUBLIC_URL, models, Exa and telemetry go through the relay instead of direct hosts.
//   docker run --rm -e LLM_BASE_URL=... winnowl:latest node scripts/gen-squid-conf.mjs > deploy/squid.conf
// `--registry` emits registry-proxy's config (package registries only):
//   docker run --rm winnowl:latest node scripts/gen-squid-conf.mjs --registry > deploy/squid-registry.conf
import { buildEgressProxyConfig, REGISTRY_ECOSYSTEMS } from '@reviewbot/sandbox';
import { EXA_BASE_URL, PLUGIN_EGRESS_HOSTS } from '@reviewbot/plugins';
import { SCANNER_EGRESS_HOSTS } from '@reviewbot/security-agent';

if (process.argv.includes('--registry')) {
  const { squidConf, allowedHosts } = buildEgressProxyConfig({
    mode: 'package-registry-only',
    ecosystems: [...REGISTRY_ECOSYSTEMS],
  });
  process.stderr.write(`registry allowlist (${allowedHosts.length} hosts): ${allowedHosts.join(', ')}\n`);
  process.stdout.write(squidConf);
  process.exit(0);
}

// Per-tier base URLs may point at different endpoints.
const bases = [
  process.env.LLM_BASE_URL,
  process.env.LLM_BASE_URL_QUALITY,
  process.env.LLM_BASE_URL_BALANCED,
  process.env.LLM_BASE_URL_CHEAP,
].filter((b): b is string => Boolean(b));

const llmHosts = bases
  .map((b) => {
    try {
      return new URL(b).host;
    } catch {
      return '';
    }
  })
  .filter(Boolean);

if (llmHosts.length === 0) {
  process.stderr.write('警告:未设 LLM_BASE_URL,squid allowlist 将不含 LLM 网关主机 → 沙盒内 LLM 调用会被拒。\n');
}

// Telemetry endpoints so sandboxed review LLM calls are traced. Accepted risk: an injected prompt with
// the OTLP key can only write junk traces; OTLP cannot read data back.
const telemetryHosts = [process.env.LANGFUSE_OTLP_ENDPOINT, process.env.OTEL_EXPORTER_OTLP_ENDPOINT]
  .filter((u): u is string => Boolean(u))
  .map((u) => {
    try {
      return new URL(u).host;
    } catch {
      return '';
    }
  })
  // Internal hosts are unreachable from the isolated network anyway; keep only public ones.
  .filter((h) => Boolean(h) && h.includes('.'));

// Scanners look advisories up online; semgrep's rules are baked into the image.
const relay = process.env.LLM_RELAY_PUBLIC_URL ? new URL(process.env.LLM_RELAY_PUBLIC_URL) : undefined;
if (relay && relay.protocol !== 'http:') throw new Error('LLM_RELAY_PUBLIC_URL must be http://<private address>:<port>');
const exaHost = new URL(EXA_BASE_URL).host;
const hosts = relay
  ? // Keyless plugin hosts and scanners stay direct.
    [...new Set([...PLUGIN_EGRESS_HOSTS.filter((h) => h !== exaHost), ...SCANNER_EGRESS_HOSTS])]
  : [...new Set([...llmHosts, ...telemetryHosts, ...PLUGIN_EGRESS_HOSTS, ...SCANNER_EGRESS_HOSTS])];
const { squidConf, allowedHosts } = buildEgressProxyConfig(
  { mode: 'allowlist', hosts },
  relay ? { privateHttpEndpoints: [{ ip: relay.hostname, port: Number(relay.port || 80) }] } : {},
);
process.stderr.write(
  `egress allowlist(${allowedHosts.length} 主机):${allowedHosts.join(', ')}${relay ? `; relay ${relay.host}` : ''}\n`,
);
process.stdout.write(squidConf);
