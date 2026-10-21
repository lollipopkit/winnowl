import { normalizeLine } from '@reviewbot/canonical-diff';
import type { SemanticAnchor } from '@reviewbot/domain';
import { bigramDice, tokenDice, tokenize } from './similarity.js';

export type AnchorMethod =
  | 'exact-window'
  /** A single-line fragment that occurs on exactly one line (see resolveAnchor step 2c). */
  | 'substring'
  | 'symbol-window'
  | 'ast'
  | 'token-window'
  | 'fuzzy'
  | 'unresolved';

export interface AnchorResolution {
  path: string;
  revisionSha: string;
  lineStart: number;
  lineEnd: number;
  side: 'base' | 'head';
  method: AnchorMethod;
  score: number;
  unique: boolean;
  changedLine: boolean;
}

export interface ResolveInput {
  anchor: SemanticAnchor;
  fileLines: string[];
  revisionSha: string;
  /** 1-based. */
  isChangedLine?: (line: number) => boolean;
}

function splitFocus(focusText: string): string[] {
  const raw = focusText.split('\n');
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  return raw;
}

/** Shorter fragments collide too easily within one file. */
const SUBSTRING_MIN = 8;

function windowEquals(fileNorm: string[], start: number, window: string[]): boolean {
  for (let j = 0; j < window.length; j += 1) {
    if (fileNorm[start + j] !== window[j]) return false;
  }
  return true;
}

/**
 * Order: exact window -> symbol/hint disambiguation -> token window -> fuzzy window -> unresolved.
 * The model never supplies line numbers; the publisher enforces the inline threshold.
 */
export function resolveAnchor(input: ResolveInput): AnchorResolution {
  const { anchor } = input;
  const side = anchor.revision;
  const norm = (s: string): string => normalizeLine(s);

  const prefix = anchor.prefixLines.map(norm);
  const focus = splitFocus(anchor.focusText).map(norm);
  const suffix = anchor.suffixLines.map(norm);
  const window = [...prefix, ...focus, ...suffix];
  const L = window.length;
  const fileNorm = input.fileLines.map(norm);

  const base = { path: anchor.path, revisionSha: input.revisionSha, side };
  const changedAt = (line: number): boolean => input.isChangedLine?.(line) ?? false;

  const build = (focusStart0: number, method: AnchorMethod, score: number, unique: boolean): AnchorResolution => {
    const lineStart = focusStart0 + 1;
    const lineEnd = lineStart + Math.max(1, focus.length) - 1;
    return { ...base, lineStart, lineEnd, method, score, unique, changedLine: changedAt(lineStart) };
  };
  const unresolved = (): AnchorResolution => ({
    ...base,
    lineStart: 0,
    lineEnd: 0,
    method: 'unresolved',
    score: 0,
    unique: false,
    changedLine: false,
  });

  if (focus.length === 0 || L === 0 || fileNorm.length < L) return unresolved();

  // 1) exact normalized window
  const exact: number[] = [];
  for (let i = 0; i + L <= fileNorm.length; i += 1) {
    if (windowEquals(fileNorm, i, window)) exact.push(i);
  }
  if (exact.length === 1) return build(exact[0]! + prefix.length, 'exact-window', 1, true);
  if (exact.length > 1) {
    // 2) hint disambiguation (symbol/hintedLine)
    if (anchor.hintedLine !== undefined) {
      const target = anchor.hintedLine;
      let bestK = -1;
      let bestDist = Infinity;
      let tie = false;
      exact.forEach((i, k) => {
        const dist = Math.abs(i + prefix.length + 1 - target);
        if (dist < bestDist) {
          bestDist = dist;
          bestK = k;
          tie = false;
        } else if (dist === bestDist) {
          tie = true;
        }
      });
      if (bestK >= 0 && !tie) return build(exact[bestK]! + prefix.length, 'symbol-window', 0.99, true);
    }
    // 2b) Findings target changed code: among several exact hits, take the single one on a changed line.
    const onChanged = exact.filter((i) => changedAt(i + prefix.length + 1));
    if (onChanged.length === 1) return build(onChanged[0]! + prefix.length, 'exact-window', 0.99, true);
    return build(exact[0]! + prefix.length, 'exact-window', 1, false); // ambiguous
  }

  // 2c) Models often quote only part of a line; accept a fragment that occurs on exactly one line
  //     (or one changed line).
  if (L === 1 && focus[0]!.length >= SUBSTRING_MIN) {
    const hits: number[] = [];
    fileNorm.forEach((line, i) => {
      if (line.includes(focus[0]!)) hits.push(i);
    });
    if (hits.length === 1) return build(hits[0]!, 'substring', 0.98, true);
    const onChanged = hits.filter((i) => changedAt(i + 1));
    if (onChanged.length === 1) return build(onChanged[0]!, 'substring', 0.98, true);
  }

  // 3) token window: same tokens, different punctuation/quotes
  const windowTokens = tokenize(window.join(' '));
  let bestTok = -1;
  let bestTokScore = 0;
  let secondTok = 0;
  for (let i = 0; i + L <= fileNorm.length; i += 1) {
    const s = tokenDice(windowTokens, tokenize(fileNorm.slice(i, i + L).join(' ')));
    if (s > bestTokScore) {
      secondTok = bestTokScore;
      bestTokScore = s;
      bestTok = i;
    } else if (s > secondTok) {
      secondTok = s;
    }
  }
  if (bestTok >= 0 && bestTokScore >= 0.97 && bestTokScore - secondTok > 0.02) {
    return build(bestTok + prefix.length, 'token-window', bestTokScore, true);
  }

  // 4) fuzzy window: mean per-line character-bigram similarity
  let bestFz = -1;
  let bestFzScore = 0;
  let secondFz = 0;
  for (let i = 0; i + L <= fileNorm.length; i += 1) {
    let sum = 0;
    for (let j = 0; j < L; j += 1) sum += bigramDice(window[j]!, fileNorm[i + j]!);
    const s = sum / L;
    if (s > bestFzScore) {
      secondFz = bestFzScore;
      bestFzScore = s;
      bestFz = i;
    } else if (s > secondFz) {
      secondFz = s;
    }
  }
  if (bestFz >= 0 && bestFzScore >= 0.9 && bestFzScore - secondFz > 0.05) {
    return build(bestFz + prefix.length, 'fuzzy', bestFzScore, true);
  }

  return unresolved();
}

/** Otherwise the finding is downgraded to file/summary level, never dropped. */
export function meetsInlineThreshold(resolution: AnchorResolution, minScore = 0.97): boolean {
  return resolution.method !== 'unresolved' && resolution.unique && resolution.score >= minScore;
}
