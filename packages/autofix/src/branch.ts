// The bot only writes its own branch namespace, never the PR's source branch.

/** winnowl/{change-number}/{action-id} */
export function stackedBranchName(changeNumber: string | number, actionId: string): string {
  const safeChange = sanitizeSegment(String(changeNumber));
  const safeAction = sanitizeSegment(actionId);
  return `winnowl/${safeChange}/${safeAction}`;
}

/** Same base head + findings + kind → same key, so retries never open a duplicate stacked CR. */
export function stackedIdempotencyKey(input: {
  baseHeadSha: string;
  findingIds: string[];
  kind: string;
}): string {
  const findings = [...input.findingIds].sort().join(',');
  return `${input.kind}:${input.baseHeadSha}:${findings}`;
}

function sanitizeSegment(value: string): string {
  // Replace unsafe characters to prevent ref injection / path escape.
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.\.+/g, '-');
  return cleaned.length > 0 ? cleaned : 'x';
}
