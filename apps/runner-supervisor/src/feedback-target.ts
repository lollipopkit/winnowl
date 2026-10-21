import type { JobHandler } from './supervisor.js';

type JobHandlerDb = Parameters<JobHandler>[0]['db'];

/** Resolves the replied-to inline comment to its finding via publication_records; null when unlinked (e.g. top-level comment). */
export async function resolveFeedbackTarget(
  db: JobHandlerDb,
  input: {
    tenantId: string;
    repositoryId: string;
    changeRequestId: string | undefined;
    nativeId: string;
  },
): Promise<{ findingId: string; fingerprint: string; claim: string } | null> {
  if (!input.changeRequestId) return null;
  const pub = await db
    .selectFrom('publication_records')
    .select('finding_id')
    .where('tenant_id', '=', input.tenantId)
    .where('repository_id', '=', input.repositoryId)
    .where('change_request_id', '=', input.changeRequestId)
    .where('provider_native_id', '=', input.nativeId)
    .where('finding_id', 'is not', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  const findingId = pub?.finding_id;
  if (!findingId) return null;
  const f = await db
    .selectFrom('findings')
    .select(['id', 'semantic_fingerprint', 'canonical_claim'])
    .where('id', '=', findingId)
    .where('tenant_id', '=', input.tenantId)
    .where('repository_id', '=', input.repositoryId)
    .executeTakeFirst();
  if (!f) return null;
  return { findingId: f.id, fingerprint: f.semantic_fingerprint, claim: f.canonical_claim };
}

