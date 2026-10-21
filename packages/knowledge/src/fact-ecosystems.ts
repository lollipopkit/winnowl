/** Package ecosystems an ecosystem fact can belong to (shared by facts and version resolution). */
export const ECOSYSTEM_FACT_ECOSYSTEMS = ['npm', 'pypi', 'cargo', 'go', 'pub', 'maven', 'rubygems', 'nuget', 'composer', 'hex', 'other'] as const;
export type FactEcosystem = (typeof ECOSYSTEM_FACT_ECOSYSTEMS)[number];

export function isFactEcosystem(v: string): v is FactEcosystem {
  return (ECOSYSTEM_FACT_ECOSYSTEMS as readonly string[]).includes(v);
}
