import type { Db } from '@reviewbot/db';
import type { KnowledgeToolEntry } from '@reviewbot/agent-pi';
import {
  factsWithLongDetail,
  formatEcosystemFacts,
  loadActiveEcosystemFacts,
  selectFactsForManifests,
  type ManifestText,
} from '@reviewbot/knowledge';

/** Approved ecosystem facts relevant to the repo's dependencies; `longEntries` are only readable via knowledge_read. */
export async function ecosystemFactsFor(
  db: Db,
  /** The repository's manifests and lockfiles; only read when there are facts to select from. */
  readManifests: () => Promise<ManifestText[]>,
): Promise<{ text: string; longEntries: KnowledgeToolEntry[] } | undefined> {
  const facts = await loadActiveEcosystemFacts(db);
  if (facts.length === 0) return undefined;
  const selected = selectFactsForManifests(facts, await readManifests());
  const text = formatEcosystemFacts(selected);
  if (text === undefined) return undefined;
  const longEntries = factsWithLongDetail(selected).map((f) => ({
    id: f.id,
    kind: 'fact' as const,
    title: `[${f.ecosystem}] ${f.subject}: ${f.claim}`,
    body: f.detail ?? '',
  }));
  return { text, longEntries };
}
