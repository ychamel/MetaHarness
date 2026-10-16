/** Name matching that forgives the small mistakes agents make ("reviwer", "impl-1" for "implementer-1"). */

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length];
}

export interface Resolution {
  match?: string;
  /** True when the match wasn't exact, so the caller can say what it assumed. */
  guessed: boolean;
  suggestions: string[];
}

export function resolveName(input: string, options: string[]): Resolution {
  const q = input.trim().toLowerCase();
  const exact = options.find(o => o.toLowerCase() === q);
  if (exact) return { match: exact, guessed: false, suggestions: [] };

  const prefixed = options.filter(o => o.toLowerCase().startsWith(q));
  if (q && prefixed.length === 1) return { match: prefixed[0], guessed: true, suggestions: [] };

  const scored = options
    .map(o => ({ o, d: editDistance(q, o.toLowerCase()) }))
    .sort((x, y) => x.d - y.d);
  const best = scored[0];
  if (best && best.d <= 2 && (scored.length === 1 || scored[1].d > best.d)) {
    return { match: best.o, guessed: true, suggestions: [] };
  }
  return { guessed: false, suggestions: scored.slice(0, 5).map(s => s.o) };
}
