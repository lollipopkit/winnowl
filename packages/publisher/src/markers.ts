/** Hidden comment markers; the reconciler matches published comments by them after a crash. */

export interface PublicationMarker {
  findingId: string;
  revision: string;
  publicationId: string;
}

export function publicationMarker(marker: PublicationMarker): string {
  return `<!-- winnowl:finding=${marker.findingId}:revision=${marker.revision}:publication=${marker.publicationId} -->`;
}

const MARKER_RE = /<!-- winnowl:finding=([^:]+):revision=([^:]+):publication=(\S+) -->/;

export function parsePublicationMarker(body: string): PublicationMarker | null {
  const m = MARKER_RE.exec(body);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  return { findingId: m[1], revision: m[2], publicationId: m[3] };
}

/** Top-level marker keyed by (kind, crId) without headSha, so a new head edits the same comment. */
export function topLevelMarker(kind: string, crId: string): string {
  return `<!-- winnowl:toplevel:kind=${kind}:cr=${crId} -->`;
}

export function hasTopLevelMarker(body: string, kind: string, crId: string): boolean {
  return body.includes(topLevelMarker(kind, crId));
}
