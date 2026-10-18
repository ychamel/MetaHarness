import type { CostSplit, Usage } from './adapters/types.ts';
import type { Prices } from './settings.ts';

/** Token totals by kind. tokensIn is input that didn't come from the prompt cache. */
export interface Tokens {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

export const NO_TOKENS: Tokens = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
const KINDS = ['tokensIn', 'tokensOut', 'cacheRead', 'cacheWrite'] as const;

export function addTokens(a: Tokens | undefined, b: Tokens | undefined): Tokens {
  const out = { ...NO_TOKENS };
  for (const k of KINDS) out[k] = (a?.[k] ?? 0) + (b?.[k] ?? 0);
  return out;
}

export const tokenCount = (t?: Tokens) => (t ? t.tokensIn + t.tokensOut + t.cacheRead + t.cacheWrite : 0);

/** A usage report's tokens, keeping `prev`'s count for any kind it leaves out. */
export function tokensOf(u: Usage, prev: Tokens = NO_TOKENS): Tokens {
  const out = { ...prev };
  for (const k of KINDS) if (typeof u[k] === 'number') out[k] = u[k]!;
  return out;
}

/** What tokens cost at these prices (dollars per million), by kind. */
export function priceSplit(t: Tokens, p: Prices): CostSplit {
  return {
    input: (t.tokensIn * p.input) / 1e6,
    output: (t.tokensOut * p.output) / 1e6,
    cacheRead: (t.cacheRead * (p.cacheRead ?? p.input)) / 1e6,
    cacheWrite: (t.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6,
  };
}

export const splitTotal = (s: CostSplit) => s.input + s.output + s.cacheRead + s.cacheWrite;

export function addSplit(a: CostSplit | undefined, b: CostSplit | undefined): CostSplit | undefined {
  if (!a) return b;
  if (!b) return a;
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}
