import { uuidv7 } from '@reviewbot/ids';
import type { CodePlane } from '@reviewbot/review-runtime';
import { MANIFEST_FILENAMES, matchRelationships, parseManifest, proposeRelationship, type RepositoryPackageRow } from '@reviewbot/multi-repo';
import type { JobHandler } from './supervisor.js';

/**
 * relationship_discover job (no LLM, no model quota): shallow-clones each repo, parses root and
 * first-level manifests into repository_packages, then proposes relationships without overriding
 * existing active/rejected ones. Best effort: a failing repo is logged and skipped.
 */

export interface RelationshipDiscoverPayload {
  tenantId: string;
  trigger: 'manual' | 'scheduled';
}

export interface RelationshipDiscoverDeps {
  /** Opens a shallow workspace of one repository (the caller scopes the token). */
  openRepository: (repo: { installationId: string; nativeId: string; cloneUrl: string }) => Promise<CodePlane>;
  /** Max repos scanned (env RELATIONSHIP_DISCOVER_MAX_REPOS, default 50); the rest is truncated with a log. */
  maxRepos?: number;
}

const MAX_MANIFESTS_PER_REPO = 20;
const MAX_MANIFEST_BYTES = 512 * 1024;

export async function scanRepoPackages(repositoryId: string, workspace: CodePlane): Promise<RepositoryPackageRow[]> {
  const paths = await workspace.client.findFiles([...MANIFEST_FILENAMES], 1, MAX_MANIFESTS_PER_REPO);
  const contents = await workspace.client.readFiles(paths);
  const seen = new Set<string>();
  const rows: RepositoryPackageRow[] = [];
  for (const rel of paths) {
    const content = contents[rel];
    if (content == null || content.length > MAX_MANIFEST_BYTES) continue;
    const parsed = parseManifest(rel, content);
    for (const [role, refs] of [['provides', parsed.provides], ['depends', parsed.depends]] as const) {
      for (const r of refs) {
        const key = `${role} ${r.ecosystem} ${r.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ repositoryId, role, ecosystem: r.ecosystem, name: r.name });
      }
    }
  }
  return rows;
}

export function createRelationshipDiscoverHandler(deps: RelationshipDiscoverDeps): JobHandler {
  return async ({ job, db, log }) => {
    const payload = job.payload as unknown as RelationshipDiscoverPayload;
    const maxRepos = deps.maxRepos ?? 50;
    const repos = await db
      .selectFrom('repositories')
      .select(['id', 'installation_id', 'native_id', 'clone_url', 'namespace', 'name'])
      .where('tenant_id', '=', payload.tenantId)
      .orderBy('created_at', 'asc')
      .execute();
    if (repos.length > maxRepos) {
      log('relationship-discover: repo list truncated', { total: repos.length, maxRepos });
    }

    let scanned = 0;
    for (const repo of repos.slice(0, maxRepos)) {
      let workspace: CodePlane | null = null;
      try {
        workspace = await deps.openRepository({ installationId: repo.installation_id, nativeId: repo.native_id, cloneUrl: repo.clone_url });
        const rows = await scanRepoPackages(repo.id, workspace);
        // Full rewrite per repo so removed dependencies disappear too.
        await db.deleteFrom('repository_packages').where('repository_id', '=', repo.id).execute();
        if (rows.length > 0) {
          await db
            .insertInto('repository_packages')
            .values(rows.map((r) => ({ id: uuidv7(), tenant_id: payload.tenantId, repository_id: r.repositoryId, role: r.role, ecosystem: String(r.ecosystem), name: r.name, updated_at: new Date() })))
            .execute();
        }
        scanned += 1;
      } catch (err) {
        log('relationship-discover: repo scan failed (continuing)', { repository: `${repo.namespace}/${repo.name}`, error: err instanceof Error ? err.message : String(err) });
      } finally {
        await workspace?.dispose().catch(() => undefined);
      }
    }

    // Matches across the whole tenant, including repos not rescanned this round (cached rows).
    const allRows = await db
      .selectFrom('repository_packages')
      .select(['repository_id', 'role', 'ecosystem', 'name'])
      .where('tenant_id', '=', payload.tenantId)
      .execute();
    const proposals = matchRelationships(
      allRows.map((r) => ({ repositoryId: r.repository_id, role: r.role as RepositoryPackageRow['role'], ecosystem: r.ecosystem, name: r.name })),
    );
    let proposed = 0;
    for (const p of proposals) {
      const id = await proposeRelationship(db, payload.tenantId, {
        sourceRepositoryId: p.sourceRepositoryId,
        targetRepositoryId: p.targetRepositoryId,
        kind: p.kind,
        proposedBy: 'auto:discover',
        rationale: p.rationale,
      });
      if (id !== null) {
        proposed += 1;
        await db
          .insertInto('audit_events')
          .values({
            id: uuidv7(),
            tenant_id: payload.tenantId,
            actor: 'relationship-discover',
            action: 'cross-repo.relationship-proposed',
            target: id,
            detail: { sourceRepositoryId: p.sourceRepositoryId, targetRepositoryId: p.targetRepositoryId, kind: p.kind, rationale: p.rationale },
            created_at: new Date(),
          })
          .execute();
      }
    }
    log('relationship-discover done', { scanned, matched: proposals.length, newlyProposed: proposed });
  };
}
