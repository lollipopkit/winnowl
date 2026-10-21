import { createHash } from 'node:crypto';
import type { CanonicalDiff, DiffFile } from '@reviewbot/canonical-diff';
import { runGit } from '@reviewbot/git-repository';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/** Opaque identity of the review-relevant material for one changed file. */
export interface ReviewFileState {
  /** Ledger key: the head path, or the base path for a deletion. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: DiffFile['status'];
  materialDigest: string;
}

/**
 * Digest of the review standard; a change invalidates all prior coverage. Only inputs that define
 * the standard belong here, not per-round reference material (memories, LLM-selected knowledge,
 * image descriptions), or the digest would differ every round and incremental review would never hit.
 */
export function buildReviewContractDigest(input: {
  configDigest: string;
  promptDigests: readonly { role: string; digest: string }[];
  /** The tier is not in `configDigest`; identity only, no endpoint or key (the digest is stored). */
  modelIdentity: { id: string; tier?: string };
  /** Per-stage models; swapping one must invalidate coverage too. */
  stageModels?: readonly { stage: string; models: readonly string[] }[];
  /** The full applicable rule set, not the LLM-selected subset. */
  reviewStandard?: string;
}): string {
  const contract = {
    version: 5,
    implementation: 'incremental-review-v5',
    configDigest: input.configDigest,
    prompts: [...input.promptDigests].sort((left, right) => left.role.localeCompare(right.role)),
    model: { id: input.modelIdentity.id, tier: input.modelIdentity.tier ?? '' },
    stageModels: [...(input.stageModels ?? [])]
      .map((stage) => ({ stage: stage.stage, models: [...stage.models].sort() }))
      .sort((left, right) => left.stage.localeCompare(right.stage)),
    reviewStandard: input.reviewStandard ?? '',
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(contract)), 'utf8')
    .digest('hex');
}

/** Avoids E2BIG on huge PRs; a failed batch only turns its own files into delta. */
const LS_TREE_BATCH = 500;

async function objectStates(
  gitDir: string,
  ref: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let offset = 0; offset < paths.length; offset += LS_TREE_BATCH) {
    const batch = paths.slice(offset, offset + LS_TREE_BATCH);
    let stdout: string;
    try {
      ({ stdout } = await runGit(gitDir, [
        'ls-tree',
        '-rz',
        '--full-tree',
        ref,
        '--',
        ...batch.map((path) => `:(literal)${path}`),
      ]));
    } catch {
      continue;
    }
    for (const entry of stdout.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const metadata = entry.slice(0, tab).split(' ');
      if (metadata.length === 3) result.set(entry.slice(tab + 1), metadata.join(':'));
    }
  }
  return result;
}

function expectedSides(file: DiffFile): { base: boolean; head: boolean } {
  return {
    base: file.status !== 'added',
    head: file.status !== 'deleted',
  };
}

/**
 * Per-file identity from blob ids plus the normalized patch. Commit shas are excluded so unrelated
 * commits, merges or rebases do not invalidate a file whose own change is unchanged.
 */
export async function buildReviewFileStates(input: {
  gitDir: string;
  baselineSha: string;
  headSha: string;
  diff: CanonicalDiff;
}): Promise<ReviewFileState[]> {
  const states: ReviewFileState[] = [];
  const basePaths = input.diff.files.flatMap((file) => (file.oldPath ? [file.oldPath] : []));
  const headPaths = input.diff.files.flatMap((file) => (file.newPath ? [file.newPath] : []));
  const [baseObjects, headObjects] = await Promise.all([
    objectStates(input.gitDir, input.baselineSha, basePaths),
    objectStates(input.gitDir, input.headSha, headPaths),
  ]);
  for (const file of input.diff.files) {
    const path = file.newPath ?? file.oldPath;
    if (!path) continue;

    const baseObject = file.oldPath ? (baseObjects.get(file.oldPath) ?? null) : null;
    const headObject = file.newPath ? (headObjects.get(file.newPath) ?? null) : null;
    const expected = expectedSides(file);
    // Equality is unprovable; omitting the state makes the file delta.
    if ((expected.base && !baseObject) || (expected.head && !headObject)) continue;

    const material = {
      version: 2,
      status: file.status,
      oldPath: file.oldPath ?? null,
      newPath: file.newPath ?? null,
      isBinary: file.isBinary,
      baseObject,
      headObject,
      hunks: file.hunks.map((hunk) => ({
        lines: hunk.lines.map((line) => ({ kind: line.kind, content: line.raw })),
      })),
    };
    states.push({
      path,
      oldPath: file.oldPath ?? null,
      newPath: file.newPath ?? null,
      status: file.status,
      materialDigest: createHash('sha256')
        .update(JSON.stringify(canonicalize(material)), 'utf8')
        .digest('hex'),
    });
  }
  return states;
}
