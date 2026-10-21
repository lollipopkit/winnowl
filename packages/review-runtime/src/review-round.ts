interface ReviewableFile {
  path: string;
  status: string;
  pureMove?: boolean;
}

/** Deletions and pure moves have nothing to review; counting them would leave a permanent coverage gap. */
export function hasReviewableContent(file: ReviewableFile): boolean {
  return file.status !== 'deleted' && file.pureMove !== true;
}

/**
 * At most `limit` files per round (0 = no limit); the coverage ledger makes the rest the next round's delta.
 * Sorting by path keeps a directory in one batch and makes reruns pick the same batch.
 * Files without reviewable content take no slot.
 */
export function pickReviewRound<F extends ReviewableFile>(
  files: readonly F[],
  limit: number,
): { round: F[]; deferred: string[] } {
  const live = files.filter(hasReviewableContent);
  if (!(limit > 0) || live.length <= limit) return { round: [...files], deferred: [] };
  const chosen = new Set([...live].sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit).map((f) => f.path));
  return {
    round: files.filter((f) => !hasReviewableContent(f) || chosen.has(f.path)),
    deferred: live.filter((f) => !chosen.has(f.path)).map((f) => f.path).sort(),
  };
}
