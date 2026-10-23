// Bundles each server entry into one file so the runtime image needs no node_modules.
import { build } from 'esbuild';

// Native addons and packages with runtime static assets cannot be bundled.
const EXTERNAL = [
  'ssh2', 'cpu-features', 'pg-native', 'better-sqlite3', 'bufferutil', 'utf-8-validate',
  '@fastify/swagger-ui',
];

// Output depth must match the source so import.meta.url-relative ../../../prompts and migrations resolve.
// .mjs forces ESM, avoiding ERR_AMBIGUOUS_MODULE_SYNTAX with __dirname + top-level await.
const targets = [
  { in: 'apps/control-api/dist/index.js', out: 'dist-bundle/apps/control-api/dist/index.mjs' },
  { in: 'apps/webhook-ingress/dist/index.js', out: 'dist-bundle/apps/webhook-ingress/dist/index.mjs' },
  { in: 'apps/runner-supervisor/dist/index.js', out: 'dist-bundle/apps/runner-supervisor/dist/index.mjs' },
  { in: 'apps/review-executor/dist/index.js', out: 'dist-bundle/apps/review-executor/dist/index.mjs' },
  { in: 'apps/review-executor/dist/actions.js', out: 'dist-bundle/apps/review-executor/dist/actions.mjs' },
  { in: 'apps/sandbox-agent/dist/index.js', out: 'dist-bundle/apps/sandbox-agent/dist/index.mjs' },
  { in: 'apps/llm-relay/dist/index.js', out: 'dist-bundle/apps/llm-relay/dist/index.mjs' },
  { in: 'scripts/gen-squid-conf.ts', out: 'dist-bundle/scripts/gen-squid-conf.mjs' },
  { in: 'packages/db/scripts/migrate.ts', out: 'dist-bundle/packages/db/dist/migrate.mjs' },
];

for (const t of targets) {
  await build({
    entryPoints: [t.in],
    outfile: t.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: EXTERNAL,
    // Provide require for leftover dynamic requires in ESM output.
    banner: { js: "import { createRequire as ___cr } from 'node:module'; const require = ___cr(import.meta.url);" },
    logLevel: 'warning',
    logOverride: { 'require-resolve-not-external': 'silent' },
  });
  console.log('bundled →', t.out);
}
