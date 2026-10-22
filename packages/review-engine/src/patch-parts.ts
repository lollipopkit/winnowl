/** Size of a dig prompt's prefetched changes, and the share one file may take of it. */
export const PREFETCH_MAX_TOTAL_CHARS = 24_000;
export const PREFETCH_MAX_FILE_CHARS = 8_000;
/** A deleted file is previewed, not shown whole: what matters is what it defined, not every line. */
const DELETED_PREVIEW_LINES = 40;

/** How much of a file's patch the prefetch shows; `truncated` tells the model to read_diff the rest. */
export function patchPreview(patch: string, maxChars: number): { body: string; truncated: boolean } {
  const lines = patch.split('\n');
  const deleted = lines[1] === '+++ /dev/null';
  const head = deleted && lines.length > DELETED_PREVIEW_LINES ? lines.slice(0, DELETED_PREVIEW_LINES).join('\n') : patch;
  const body = head.slice(0, maxChars);
  return { body, truncated: body.length < patch.length };
}

/**
 * Packs files in order into groups whose previewed patches fit one prefetch, so each dig sees every
 * change it is responsible for without spending tool calls on it. Files without a patch weigh nothing.
 */
export function packByPatch(
  files: readonly string[],
  patches: Readonly<Record<string, string>>,
  max = PREFETCH_MAX_TOTAL_CHARS,
): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const path of files) {
    const patch = patches[path.replace(/\\/g, '/').replace(/^\.\//, '')];
    const weight = patch === undefined ? 0 : patchPreview(patch, PREFETCH_MAX_FILE_CHARS).body.length;
    if (current.length > 0 && size + weight > max) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(path);
    size += weight;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
