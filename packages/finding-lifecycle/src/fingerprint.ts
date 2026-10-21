import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';

export interface FingerprintInput {
  repositoryId: string;
  category: string;
  claim: string;
  /** Stable symbol identity (qualifiedName + signatureHash). */
  symbolIdentity?: string;
  codeWindow: string;
  /** Causal edge, e.g. introduced + triggering symbol. */
  causalEdge?: string;
  /**
   * Anchor file. Without it, identical code flagged in several files collapses into one row and the
   * extra occurrences are dropped by the unique key. Renames are handled by cross-round matching.
   */
  path?: string;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Semantic fingerprint; excludes line numbers and head SHA so it matches across revisions. */
export function semanticFingerprint(input: FingerprintInput): string {
  const parts = [
    input.repositoryId,
    input.category,
    normalize(input.claim),
    input.symbolIdentity ?? '',
    normalize(input.codeWindow),
    input.causalEdge ?? '',
    input.path ?? '',
  ];
  return bytesToHex(blake3(parts.join('\0')));
}

/**
 * Weak fingerprint for `@bot ignore`: code window + category, without the claim text, because the
 * LLM rewords the claim every round. Coarser by design: same-category issues at that spot are silenced too.
 */
export function weakFingerprint(input: {
  repositoryId: string;
  category: string;
  codeWindow: string;
  /** Ignoring applies to this spot in this file, not identical code elsewhere. */
  path?: string;
}): string {
  return bytesToHex(
    blake3([input.repositoryId, input.category, normalize(input.codeWindow), input.path ?? ''].join('\0')),
  );
}
