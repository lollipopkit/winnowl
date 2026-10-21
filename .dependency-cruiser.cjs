/**
 * Workspace packages resolve through node_modules symlinks, so cross-package rules match
 * on the `@reviewbot/<x>` module name.
 */
'use strict';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '禁止循环依赖。',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'domain 不得依赖任何其他包或运行时库。',
      from: { path: '^packages/domain/src' },
      to: {
        pathNot: [
          '^packages/domain/src',
          '^node_modules/(typescript|@types)/',
        ],
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'provider-not-review-engine',
      severity: 'error',
      comment: 'Provider 包不得依赖 Review Engine。',
      from: { path: '^packages/provider-' },
      to: { path: '@reviewbot/review-engine' },
    },
    {
      name: 'agent-pi-not-publisher',
      severity: 'error',
      comment: 'agent-pi 不得依赖 publisher。',
      from: { path: '^packages/agent-pi' },
      to: { path: '@reviewbot/publisher' },
    },
    {
      name: 'publisher-not-agent-pi',
      severity: 'error',
      comment: 'publisher 不得依赖 Pi。',
      from: { path: '^packages/publisher' },
      to: { path: '@reviewbot/agent-pi' },
    },
    {
      name: 'sandbox-not-provider',
      severity: 'error',
      comment: 'Sandbox 不得依赖 Provider 凭据/实现。',
      from: { path: '^packages/sandbox' },
      to: { path: '@reviewbot/provider-' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: '孤立模块通常是遗留或误建文件。',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)index\\.ts$',
          '(^|/)tsconfig.*\\.json$',
          '(^|/)(eslint|prettier|vitest)\\.config\\.',
          // web-console .ts files are only imported from .svelte, which is excluded.
          '^apps/web-console/',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Boundaries apply to production source only; .svelte files are not parseable as TS/JS.
    exclude: { path: '(^|/)(test|scripts)/|\\.svelte$|(^|/)(\\.svelte-kit|dist)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'node'],
      extensions: ['.ts', '.js'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
    },
  },
};
