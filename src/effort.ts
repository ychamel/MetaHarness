/**
 * Effort: how hard a model thinks, set apart from the model so a role's model (and its price)
 * is picked once and its effort on its own. Each harness spells it its own way: a flag (Claude
 * Code), a config key (Codex), a model name suffix (Antigravity), a config option (ACP).
 */

/** Every level a harness is known to take, lowest first. */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** What `claude --effort` takes. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The level a harness takes that's closest to the one asked for (a tie goes to the lower one). */
export function nearestEffort(want: string, supported: string[]): string | undefined {
  if (!supported.length) return undefined;
  if (supported.includes(want)) return want;
  const at = EFFORTS.indexOf(want);
  if (at < 0) return undefined;
  const known = supported.filter(s => EFFORTS.includes(s));
  if (!known.length) return undefined;
  return known.reduce((best, s) => {
    const d = Math.abs(EFFORTS.indexOf(s) - at), bd = Math.abs(EFFORTS.indexOf(best) - at);
    return d < bd || (d === bd && EFFORTS.indexOf(s) < EFFORTS.indexOf(best)) ? s : best;
  });
}

/** A model named with its effort, e.g. Antigravity's gemini-3.8-flash-high. */
export interface EffortVariant {
  model: string;
  effort: string;
}

/**
 * Models listed once per effort (gemini-3.8-flash-low, -medium, -high) folded into one model
 * with its efforts. A name counts as a variant only when its model is listed with two efforts
 * or more, so a model that merely ends in "-high" stays as it is.
 */
export function foldEfforts(models: string[]): { models: string[]; efforts: Record<string, string[]>; variants: Record<string, EffortVariant> } {
  const split = (m: string): EffortVariant | undefined => {
    const i = m.lastIndexOf('-');
    return i > 0 && EFFORTS.includes(m.slice(i + 1)) ? { model: m.slice(0, i), effort: m.slice(i + 1) } : undefined;
  };
  const byModel = new Map<string, string[]>();
  for (const m of models) {
    const v = split(m);
    if (v) byModel.set(v.model, [...(byModel.get(v.model) ?? []), v.effort]);
  }
  const efforts: Record<string, string[]> = {};
  const variants: Record<string, EffortVariant> = {};
  const out: string[] = [];
  for (const m of models) {
    const v = split(m);
    if (v && (byModel.get(v.model)?.length ?? 0) > 1) {
      variants[m] = v;
      if (!efforts[v.model]) {
        efforts[v.model] = [...byModel.get(v.model)!].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
        out.push(v.model);
      }
    } else if (!out.includes(m)) out.push(m);
  }
  return { models: out, efforts, variants };
}

/** "model@effort" into its parts; no @ means no effort of its own. */
export function splitEffort(text: string): { model: string; effort?: string } {
  const at = text.lastIndexOf('@');
  if (at <= 0) return { model: text };
  const effort = text.slice(at + 1).trim().toLowerCase();
  return effort ? { model: text.slice(0, at).trim(), effort } : { model: text.slice(0, at).trim() };
}
