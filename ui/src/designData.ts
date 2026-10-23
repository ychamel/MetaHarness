import type { DesignArea, DesignSnapshot, MhEvent } from './types.ts';

/** The deepest area holding a path ('' holds everything). */
export function areaOf(areas: DesignArea[], path: string): string | undefined {
  let best: DesignArea | undefined;
  for (const a of areas) if ((a.path === '' || path === a.path || path.startsWith(a.path + '/')) && (!best || a.path.length > best.path.length)) best = a;
  return best?.path;
}

export const areaLabel = (p: string) => p || 'top level';

/** Who touched a file or an area: edits by tool, reads, and commits, per agent. */
export interface Touch {
  edits: Map<string, number>;
  reads: Map<string, number>;
  commits: Map<string, number>;
  /** When an edit last happened (ms). */
  lastEdit: number;
  lastEditBy?: string;
}

const blank = (): Touch => ({ edits: new Map(), reads: new Map(), commits: new Map(), lastEdit: 0 });
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export interface Activity {
  files: Map<string, Touch>;
  areas: Map<string, Touch>;
  /** Files agents named that the snapshot doesn't have yet (written, not committed). */
  fresh: Set<string>;
}

/** Tool calls and commits since `since` (ms), by file and by area. */
export function activity(events: MhEvent[], snap: DesignSnapshot | undefined, since: number): Activity {
  const out: Activity = { files: new Map(), areas: new Map(), fresh: new Set() };
  if (!snap) return out;
  const known = new Set(snap.files.map(f => f.path));
  const add = (path: string, agent: string, kind: 'edit' | 'read' | 'commit', at: number) => {
    const area = areaOf(snap.map.areas, path);
    for (const [m, k] of [[out.files, path], ...(area !== undefined ? [[out.areas, area] as const] : [])] as const) {
      const t = m.get(k) ?? blank();
      bump(kind === 'edit' ? t.edits : kind === 'read' ? t.reads : t.commits, agent);
      if (kind === 'edit' && at >= t.lastEdit) [t.lastEdit, t.lastEditBy] = [at, agent];
      m.set(k, t);
    }
    if (kind === 'edit' && !known.has(path)) out.fresh.add(path);
  };
  const merges = mergeShas(events);
  for (const e of events) {
    const at = Date.parse(e.ts);
    if (at < since || !e.agent) continue;
    if (e.type === 'agent.tool_call' && Array.isArray(e.data.paths)) {
      for (const p of e.data.paths as string[]) add(p, e.agent, e.data.edit ? 'edit' : 'read', at);
    } else if (e.type === 'git.commit' && Array.isArray(e.data.paths) && !merges.has(String(e.data.sha))) {
      for (const p of e.data.paths as string[]) add(p, e.agent, 'commit', at);
    }
  }
  return out;
}

/** Merge commits: whoever merges isn't working on the files the merge brings in. */
const mergeShas = (events: MhEvent[]) => new Set(events.filter(e => e.type === 'git.merge' && !e.data.fastForward).map(e => String(e.data.sha)));

/** Findings for improving the workflow and rules next time: collisions, rework, rules that fired. */
export interface Insights {
  /** Files edited by more than one agent. */
  collisions: { path: string; agents: string[] }[];
  conflicts: { files: string[]; branch: string; agent?: string }[];
  /** Files changed in three commits or more. */
  rework: { path: string; commits: number; agents: string[] }[];
  rules: { rule: string; n: number }[];
  /** How many areas each agent edited in. */
  spread: { agent: string; areas: number }[];
  notes: { pinned: number; delivered: number };
}

export function insights(events: MhEvent[], snap: DesignSnapshot | undefined): Insights {
  const editors = new Map<string, Set<string>>();
  const commits = new Map<string, { n: number; agents: Set<string> }>();
  const rules = new Map<string, number>();
  const areasBy = new Map<string, Set<string>>();
  const out: Insights = { collisions: [], conflicts: [], rework: [], rules: [], spread: [], notes: { pinned: 0, delivered: 0 } };
  const merges = mergeShas(events);
  for (const e of events) {
    const d = e.data;
    if (e.type === 'agent.tool_call' && d.edit && e.agent && Array.isArray(d.paths)) {
      for (const p of d.paths as string[]) {
        editors.set(p, (editors.get(p) ?? new Set()).add(e.agent));
        const a = snap ? areaOf(snap.map.areas, p) : undefined;
        if (a !== undefined) areasBy.set(e.agent, (areasBy.get(e.agent) ?? new Set()).add(a));
      }
    } else if (e.type === 'git.commit' && Array.isArray(d.paths) && !merges.has(String(d.sha))) {
      for (const p of d.paths as string[]) {
        const c = commits.get(p) ?? { n: 0, agents: new Set<string>() };
        c.n++;
        if (e.agent) c.agents.add(e.agent);
        commits.set(p, c);
      }
    } else if (e.type === 'git.conflict') out.conflicts.push({ files: (d.files as string[]) ?? [], branch: String(d.branch), agent: e.agent });
    else if (e.type === 'rule.fired') rules.set(String(d.rule), (rules.get(String(d.rule)) ?? 0) + 1);
    else if (e.type === 'note.pinned') out.notes.pinned++;
    else if (e.type === 'note.delivered') out.notes.delivered++;
  }
  out.collisions = [...editors].filter(([, s]) => s.size > 1).map(([path, s]) => ({ path, agents: [...s] }));
  out.rework = [...commits].filter(([, c]) => c.n >= 3).map(([path, c]) => ({ path, commits: c.n, agents: [...c.agents] })).sort((a, b) => b.commits - a.commits);
  out.rules = [...rules].map(([rule, n]) => ({ rule, n })).sort((a, b) => b.n - a.n);
  out.spread = [...areasBy].map(([agent, s]) => ({ agent, areas: s.size })).sort((a, b) => b.areas - a.areas);
  return out;
}

/**
 * Areas in layers: an area sits above the areas it uses, so dependencies read downwards.
 * Cycles are broken where they're met.
 */
export function layers(areas: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  const uses = new Map<string, string[]>();
  for (const e of edges) if (e.from !== e.to) uses.set(e.from, [...(uses.get(e.from) ?? []), e.to]);
  // Depth: the longest chain of areas it uses, below it.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const below = (a: string): number => {
    if (depth.has(a)) return depth.get(a)!;
    if (visiting.has(a)) return 0;
    visiting.add(a);
    const d = Math.max(-1, ...(uses.get(a) ?? []).map(below)) + 1;
    visiting.delete(a);
    depth.set(a, d);
    return d;
  };
  const max = Math.max(0, ...areas.map(below));
  for (const a of areas) out.set(a, max - below(a));
  return out;
}

export interface Tile {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap (Bruls et al.) of weights into a w×h box. */
export function treemap(items: { key: string; weight: number }[], w: number, h: number): Tile[] {
  const sorted = items.filter(i => i.weight > 0).sort((a, b) => b.weight - a.weight);
  const sum = sorted.reduce((s, i) => s + i.weight, 0);
  if (!sum || w <= 0 || h <= 0) return [];
  const scale = (w * h) / sum;
  const out: Tile[] = [];
  let rest = sorted.map(i => ({ key: i.key, area: i.weight * scale }));
  let box = { x: 0, y: 0, w, h };
  const worst = (row: { area: number }[], side: number) => {
    const s = row.reduce((a, r) => a + r.area, 0);
    const max = Math.max(...row.map(r => r.area));
    const min = Math.min(...row.map(r => r.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  while (rest.length) {
    const side = Math.min(box.w, box.h);
    let row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row = [...row, rest[i++]];
    rest = rest.slice(i);
    const s = row.reduce((a, r) => a + r.area, 0);
    if (box.w >= box.h) {
      const cw = s / box.h;
      let y = box.y;
      for (const r of row) {
        const ch = r.area / cw;
        out.push({ key: r.key, x: box.x, y, w: cw, h: ch });
        y += ch;
      }
      box = { x: box.x + cw, y: box.y, w: box.w - cw, h: box.h };
    } else {
      const ch = s / box.w;
      let x = box.x;
      for (const r of row) {
        const cw = r.area / ch;
        out.push({ key: r.key, x, y: box.y, w: cw, h: ch });
        x += cw;
      }
      box = { x: box.x, y: box.y + ch, w: box.w, h: box.h - ch };
    }
  }
  return out;
}

/** Pinned notes still up, from the log, with who has had each. */
export function pinnedNotes(events: MhEvent[]): { id: string; path: string; text: string; delivered: string[]; kept?: string }[] {
  const notes = new Map<string, { id: string; path: string; text: string; delivered: string[]; kept?: string }>();
  for (const e of events) {
    const id = String(e.data.id ?? '');
    if (e.type === 'note.pinned') notes.set(id, { id, path: String(e.data.path), text: String(e.data.text), delivered: [] });
    else if (e.type === 'note.removed') notes.delete(id);
    else if (e.type === 'note.delivered' && e.agent) notes.get(id)?.delivered.push(e.agent);
    else if (e.type === 'note.kept') {
      const n = notes.get(id);
      if (n) n.kept = String(e.data.rule);
    }
  }
  return [...notes.values()];
}
