export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/i).filter(Boolean);
}

/** Multiset Dice coefficient (0..1). */
export function tokenDice(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const countA = new Map<string, number>();
  for (const t of a) countA.set(t, (countA.get(t) ?? 0) + 1);
  const countB = new Map<string, number>();
  for (const t of b) countB.set(t, (countB.get(t) ?? 0) + 1);
  let inter = 0;
  for (const [t, c] of countA) inter += Math.min(c, countB.get(t) ?? 0);
  return (2 * inter) / (a.length + b.length);
}

/** Character-bigram Dice coefficient (0..1). */
export function bigramDice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  let total = 0;
  for (const [g, c] of A) {
    total += c;
    inter += Math.min(c, B.get(g) ?? 0);
  }
  for (const [, c] of B) total += c;
  return total === 0 ? 0 : (2 * inter) / total;
}
