import type { Uuid } from './ids.js';

export interface CodeReference {
  repositoryId: Uuid;
  revisionSha: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: SymbolIdentity;
  permalink?: string;
}

export interface SymbolIdentity {
  language?: string;
  kind?: string;
  qualifiedName: string;
  signatureHash?: string;
}

/** Semantic anchor; the framework resolves it to a provider line/position before publishing. */
export interface SemanticAnchor {
  path: string;
  revision: 'base' | 'head';
  symbol?: SymbolIdentity;
  focusText: string;
  prefixLines: string[];
  suffixLines: string[];
  astNodeKind?: string;
  normalizedTokens?: string[];
  hintedLine?: number;
}
