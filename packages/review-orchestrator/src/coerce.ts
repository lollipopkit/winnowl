import type { FindingCategory, Severity } from '@reviewbot/findings';

const CATEGORIES: readonly FindingCategory[] = [
  'correctness',
  'security',
  'authorization',
  'concurrency',
  'data-integrity',
  'resource-lifetime',
  'error-handling',
  'compatibility',
  'migration',
  'performance',
  'reliability',
  'test-gap',
  'build-deployment',
  'maintainability',
  'style',
];

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function coerceCategory(value: string): FindingCategory {
  return CATEGORIES.includes(value as FindingCategory) ? (value as FindingCategory) : 'correctness';
}

export function coerceSeverity(value: string): Severity {
  return SEVERITIES.includes(value as Severity) ? (value as Severity) : 'medium';
}
