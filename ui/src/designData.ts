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

/* ---------------- the scope bar: branches as lanes, commits as dots ---------------- */

export interface LaneDot {
  sha: string;
  col: number;
  lane: number;
  agent?: string;
  summary: string;
  added?: number;
  removed?: number;
  merge: boolean;
}

export interface Lanes {
  lanes: { branch: string; agent?: string }[];
  dots: LaneDot[];
  /** Merges, and where each branch started from the goal branch. */
  links: { from: [number, number]; to: [number, number]; ff?: boolean }[];
  cols: number;
}

/**
 * The goal's commits laid out like a small git graph, from the log: one lane for the goal
 * branch, then one per agent branch, a column per commit in the order they were made.
 */
export function lanes(events: MhEvent[], goalBranch: string, branches: { name: string; agent: string }[]): Lanes {
  const out: Lanes = { lanes: [{ branch: goalBranch }], dots: [], links: [], cols: 0 };
  const laneOf = (branch: string, agent?: string) => {
    let i = out.lanes.findIndex(l => l.branch === branch);
    if (i < 0) {
      out.lanes.push({ branch, agent: agent ?? branches.find(b => b.name === branch)?.agent });
      i = out.lanes.length - 1;
    }
    return i;
  };
  for (const b of branches) laneOf(b.name, b.agent);
  const bySha = new Map<string, LaneDot>();
  for (const e of events) {
    const d = e.data;
    if (e.type === 'git.commit' && !bySha.has(String(d.sha))) {
      const dot: LaneDot = { sha: String(d.sha), col: out.cols++, lane: laneOf(String(d.branch)), agent: e.agent, summary: String(d.summary ?? ''), added: d.added as number, removed: d.removed as number, merge: false };
      bySha.set(dot.sha, dot);
      out.dots.push(dot);
    } else if (e.type === 'git.merge') {
      const into = laneOf(String(d.into));
      const fromLane = out.lanes.findIndex(l => l.branch === String(d.from));
      const target = bySha.get(String(d.sha));
      if (target && !d.fastForward) target.merge = true;
      if (fromLane < 0) continue;
      const last = out.dots.filter(x => x.lane === fromLane && x.col <= (target?.col ?? out.cols)).at(-1);
      if (!last) continue;
      // A fast-forward moves the goal branch onto the branch's commit: drawn as a link to a column of its own.
      const col = d.fastForward ? out.cols++ : (target?.col ?? out.cols++);
      out.links.push({ from: [last.col, fromLane], to: [col, into], ...(d.fastForward ? { ff: true } : {}) });
    }
  }
  for (let i = 1; i < out.lanes.length; i++) {
    const first = out.dots.find(x => x.lane === i);
    if (first) out.links.push({ from: [Math.max(0, first.col - 1), 0], to: [first.col, i] });
  }
  return out;
}

/* ---------------- one definition's part of a diff ---------------- */

/** A definition's last line: as outlined, else up to the next definition in the file. */
export function symbolEnd(file: { symbols?: { line: number; end?: number; name: string; kind: string; parent?: string }[] } | undefined, s: { line?: number; end?: number; name: string; kind: string }): number | undefined {
  if (s.end) return s.end;
  if (!s.line) return undefined;
  const own = file?.symbols?.find(x => x.name === s.name && x.kind === s.kind && x.line === s.line);
  if (own?.end) return own.end;
  const next = file?.symbols?.map(x => x.line).filter(l => l > s.line!).sort((a, b) => a - b)[0];
  return next ? next - 1 : s.line + 60;
}

/**
 * The hunks of a file's patch that touch lines `from`..`to`, on the new side (or the old side,
 * for a definition that was removed). A new file's single hunk is cut down to those lines.
 */
export function hunksFor(patch: string, from: number, to: number, side: 'new' | 'old' = 'new'): string {
  const hunks: { head: string; start: number; lines: string[] }[] = [];
  for (const line of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) hunks.push({ head: line, start: Number(side === 'new' ? h[3] : h[1]), lines: [] });
    else hunks.at(-1)?.lines.push(line);
  }
  const out: string[] = [];
  for (const h of hunks) {
    // Walk the hunk, keeping the lines whose number on this side falls in the range.
    let n = h.start;
    let a = Number(/^@@ -(\d+)/.exec(h.head)?.[1] ?? 0);
    let b = Number(/\+(\d+)/.exec(h.head)?.[1] ?? 0);
    const keep: string[] = [];
    let first: [number, number] | undefined;
    for (const l of h.lines) {
      if (l.startsWith('\\')) continue;
      const mine = side === 'new' ? !l.startsWith('-') : !l.startsWith('+');
      const inRange = mine ? n >= from && n <= to : n >= from && n <= to + 1;
      if (inRange) {
        if (!first) first = [a, b];
        keep.push(l);
      }
      if (l.startsWith('+')) b++;
      else if (l.startsWith('-')) a++;
      else {
        a++;
        b++;
      }
      if (mine) n++;
    }
    if (!first || !keep.some(l => l.startsWith('+') || l.startsWith('-'))) continue;
    out.push(`@@ -${first[0]} +${first[1]} @@`, ...keep);
  }
  return out.join('\n');
}

/**
 * What a patch did, on the new side's line numbers: lines added, lines changed (with what each
 * was), and lines removed (kept with the line they sat before).
 */
export interface Marks {
  line: Map<number, { kind: 'add' | 'chg'; was?: string }>;
  gone: Map<number, string[]>;
}

export function marksOf(patch: string): Marks {
  const m: Marks = { line: new Map(), gone: new Map() };
  let b = 0;
  let dels: string[] = [];
  let adds: { n: number; text: string }[] = [];
  // A run of removed lines then added ones: paired up as changes, what's left over as added or removed.
  const flush = () => {
    const k = Math.min(dels.length, adds.length);
    adds.forEach((x, i) => m.line.set(x.n, i < k ? { kind: 'chg', was: dels[i] } : { kind: 'add' }));
    if (dels.length > k) m.gone.set(adds.length ? adds.at(-1)!.n + 1 : b, dels.slice(k));
    dels = [];
    adds = [];
  };
  for (const l of patch.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) {
      flush();
      b = Number(h[1]);
      continue;
    }
    if (!b || l.startsWith('\\')) continue;
    if (l.startsWith('+')) adds.push({ n: b++, text: l.slice(1) });
    else if (l.startsWith('-')) {
      if (adds.length) flush();
      dels.push(l.slice(1));
    } else {
      flush();
      b++;
    }
  }
  flush();
  return m;
}
