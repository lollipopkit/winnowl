import type { Db } from '@reviewbot/db';
import type { ReviewFileState } from './file-state.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const FILE_STATUSES = new Set(['added', 'modified', 'deleted', 'renamed', 'copied', 'binary']);

function isValidReviewFileState(file: ReviewFileState): boolean {
  if (
    !file.path ||
    !SHA256_RE.test(file.materialDigest) ||
    !FILE_STATUSES.has(file.status) ||
    (file.oldPath !== null && !file.oldPath) ||
    (file.newPath !== null && !file.newPath)
  ) {
    return false;
  }
  if (file.path !== (file.newPath ?? file.oldPath)) return false;
  switch (file.status) {
    case 'added':
      return file.oldPath === null && file.newPath !== null;
    case 'deleted':
      return file.oldPath !== null && file.newPath === null;
    case 'modified':
    case 'binary':
      return file.oldPath !== null && file.newPath === file.oldPath;
    case 'renamed':
    case 'copied':
      return file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath;
    default:
      return false;
  }
}

export interface ReviewFilePartition {
  deltaFiles: ReviewFileState[];
  /** Files whose exact material was explored under the same review contract. */
  priorFiles: ReviewFileState[];
  coveredAtSha: ReadonlyMap<string, string>;
  /** Files each prior file's review actually read. */
  dependencies: ReadonlyMap<string, readonly string[]>;
  /** Last coverage under the same contract, for prior and delta files alike (delta = changed since). */
  previous: ReadonlyMap<string, { coveredAtSha: string; note?: string }>;
}

export interface PartitionReviewFilesInput {
  db: Db;
  tenantId: string;
  changeRequestId: string;
  files: readonly ReviewFileState[];
  reviewContractDigest: string | undefined;
}

/** Exact file-state partition used by incremental review. Any ambiguity fails closed to delta. */
export async function partitionReviewFiles(
  input: PartitionReviewFilesInput,
): Promise<ReviewFilePartition> {
  if (input.files.length === 0)
    return { deltaFiles: [], priorFiles: [], coveredAtSha: new Map(), dependencies: new Map(), previous: new Map() };
  const counts = new Map<string, number>();
  for (const file of input.files) counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
  if (
    !input.reviewContractDigest ||
    !SHA256_RE.test(input.reviewContractDigest) ||
    input.files.some((file) => !isValidReviewFileState(file) || counts.get(file.path) !== 1)
  ) {
    return {
      deltaFiles: [...input.files],
      priorFiles: [],
      coveredAtSha: new Map(),
      dependencies: new Map(),
      previous: new Map(),
    };
  }

  const rows = await input.db
    .selectFrom('pr_coverage')
    .select(['path', 'material_digest', 'review_contract_digest', 'covered_at_sha', 'dependencies', 'note'])
    .where('tenant_id', '=', input.tenantId)
    .where('change_request_id', '=', input.changeRequestId)
    .where(
      'path',
      'in',
      input.files.map((file) => file.path),
    )
    .execute();
  const priorByPath = new Map(rows.map((row) => [row.path, row]));
  const deltaFiles: ReviewFileState[] = [];
  const priorFiles: ReviewFileState[] = [];
  const coveredAtSha = new Map<string, string>();
  const dependencies = new Map<string, readonly string[]>();
  const previous = new Map<string, { coveredAtSha: string; note?: string }>();
  for (const file of input.files) {
    const prior = priorByPath.get(file.path);
    if (prior?.review_contract_digest === input.reviewContractDigest) {
      previous.set(file.path, {
        coveredAtSha: prior.covered_at_sha,
        ...(prior.note ? { note: prior.note } : {}),
      });
    }
    if (
      prior?.material_digest === file.materialDigest &&
      prior.review_contract_digest === input.reviewContractDigest
    ) {
      priorFiles.push(file);
      coveredAtSha.set(file.path, prior.covered_at_sha);
      dependencies.set(file.path, prior.dependencies ?? []);
    } else {
      deltaFiles.push(file);
    }
  }
  return { deltaFiles, priorFiles, coveredAtSha, dependencies, previous };
}

/** Prior files whose dependencies changed since coverage; an unknown answer (null) counts as stale. */
export async function filesWithStaleDependencies(
  partition: Pick<ReviewFilePartition, 'priorFiles' | 'coveredAtSha' | 'dependencies'>,
  changedSince: (sha: string) => Promise<ReadonlySet<string> | null>,
): Promise<Set<string>> {
  const stale = new Set<string>();
  const bySha = new Map<string, string[]>();
  for (const file of partition.priorFiles) {
    if ((partition.dependencies.get(file.path) ?? []).length === 0) continue;
    const sha = partition.coveredAtSha.get(file.path);
    if (!sha) {
      stale.add(file.path);
      continue;
    }
    bySha.set(sha, [...(bySha.get(sha) ?? []), file.path]);
  }
  for (const [sha, paths] of bySha) {
    const changed = await changedSince(sha).catch(() => null);
    for (const path of paths) {
      const deps = partition.dependencies.get(path) ?? [];
      if (changed === null || deps.some((dep) => changed.has(dep))) stale.add(path);
    }
  }
  return stale;
}

export interface RecordCoveredFilesInput {
  db: Db;
  tenantId: string;
  changeRequestId: string;
  headSha: string;
  reviewContractDigest: string;
  files: readonly (Pick<ReviewFileState, 'path' | 'materialDigest'> & {
    dependencies?: readonly string[];
    note?: string;
  })[];
}

/** Persists only states whose exact material and review contract can be proven. */
export async function recordCoveredFiles(input: RecordCoveredFilesInput): Promise<void> {
  if (!SHA256_RE.test(input.reviewContractDigest) || input.files.length === 0) return;
  const valid = new Map<string, string>();
  const conflicts = new Set<string>();
  const dependencies = new Map<string, Set<string>>();
  const notes = new Map<string, string>();
  for (const file of input.files) {
    if (file.note && !notes.has(file.path)) notes.set(file.path, file.note);
    if (!file.path || !SHA256_RE.test(file.materialDigest)) continue;
    const existing = valid.get(file.path);
    if (existing !== undefined && existing !== file.materialDigest) conflicts.add(file.path);
    else valid.set(file.path, file.materialDigest);
    const deps = dependencies.get(file.path) ?? new Set<string>();
    for (const dep of file.dependencies ?? []) deps.add(dep);
    dependencies.set(file.path, deps);
  }
  for (const path of conflicts) valid.delete(path);
  if (valid.size === 0) return;

  const now = new Date();
  await input.db
    .insertInto('pr_coverage')
    .values(
      [...valid].map(([path, materialDigest]) => ({
        tenant_id: input.tenantId,
        change_request_id: input.changeRequestId,
        path,
        covered_at_sha: input.headSha,
        covered_at: now,
        material_digest: materialDigest,
        review_contract_digest: input.reviewContractDigest,
        dependencies: JSON.stringify([...(dependencies.get(path) ?? [])].sort()),
        note: notes.get(path) ?? null,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['change_request_id', 'path']).doUpdateSet({
        tenant_id: input.tenantId,
        covered_at_sha: input.headSha,
        covered_at: now,
        material_digest: (eb) => eb.ref('excluded.material_digest'),
        review_contract_digest: (eb) => eb.ref('excluded.review_contract_digest'),
        dependencies: (eb) => eb.ref('excluded.dependencies'),
        note: (eb) => eb.ref('excluded.note'),
      }),
    )
    .execute();
}
