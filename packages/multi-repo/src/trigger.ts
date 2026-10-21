import type { CrossRepoContractKind, CrossRepoTrigger } from './types.js';

interface TriggerMatcher {
  kind: CrossRepoContractKind;
  test: (path: string) => boolean;
}

const lower = (p: string): string => p.toLowerCase();
const base = (p: string): string => lower(p).split('/').pop() ?? '';

const MATCHERS: TriggerMatcher[] = [
  { kind: 'openapi', test: (p) => /(^|\/)(openapi|swagger)\.(ya?ml|json)$/.test(lower(p)) || /\.openapi\.(ya?ml|json)$/.test(lower(p)) },
  { kind: 'protobuf', test: (p) => lower(p).endsWith('.proto') },
  { kind: 'graphql', test: (p) => /\.(graphql|gql)$/.test(lower(p)) },
  { kind: 'event-schema', test: (p) => /\.(avsc)$/.test(lower(p)) || /\.event\.(json|ya?ml)$/.test(lower(p)) || base(p) === 'asyncapi.yaml' },
  { kind: 'database-contract', test: (p) => /(^|\/)migrations?\//.test(lower(p)) || /(^|\/)schema\.sql$/.test(lower(p)) || base(p) === 'schema.prisma' },
  { kind: 'shared-config', test: (p) => /(^|\/)(shared|contracts?)\/.*\.(ya?ml|json|toml)$/.test(lower(p)) },
  { kind: 'sdk-public-interface', test: (p) => /(^|\/)(sdk|public-api|api)\/.*\.(ts|go|py|rs|java|kt)$/.test(lower(p)) },
  { kind: 'versioned-library-api', test: (p) => base(p) === 'package.json' || base(p) === 'go.mod' || base(p) === 'cargo.toml' || base(p) === 'pyproject.toml' },
];

/** A file may match several kinds; empty means no contract surface changed. */
export function detectCrossRepoTriggers(changedFiles: string[]): CrossRepoTrigger[] {
  const byKind = new Map<CrossRepoContractKind, string[]>();
  for (const file of changedFiles) {
    for (const matcher of MATCHERS) {
      if (matcher.test(file)) {
        const list = byKind.get(matcher.kind) ?? [];
        list.push(file);
        byKind.set(matcher.kind, list);
      }
    }
  }
  return [...byKind.entries()].map(([kind, files]) => ({ kind, files }));
}
