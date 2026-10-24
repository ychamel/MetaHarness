import type { CodeClass, CodeEdge, CodeField, CodeFn, CodeGraph, CodeSignal, DesignChange } from './types.ts';

/**
 * The Systems lens's sums over the code graph (src/codegraph.ts): an index of it, the links
 * between classes it adds up to, how a function is reached from the engine, where two systems
 * meet, and what a scope changed in it. Everything here is pure, so the view only draws.
 */

export interface CodeIndex {
  g: CodeGraph;
  cls: Map<string, CodeClass>;
  fn: Map<string, CodeFn>;
  sig: Map<string, CodeSignal>;
  field: Map<string, CodeField>;
  /** Edges by where they start, and by where they end. */
  out: Map<string, CodeEdge[]>;
  into: Map<string, CodeEdge[]>;
  fnsOf: Map<string, CodeFn[]>;
  classesOf: Map<string, CodeClass[]>;
  entries: Set<string>;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
};

export function indexGraph(g: CodeGraph): CodeIndex {
  const ix: CodeIndex = {
    g, cls: new Map(g.classes.map(c => [c.id, c])), fn: new Map(g.fns.map(f => [f.id, f])), sig: new Map(g.signals.map(s => [s.id, s])), field: new Map(g.fields.map(f => [f.id, f])),
    out: new Map(), into: new Map(), fnsOf: new Map(), classesOf: new Map(), entries: new Set(g.entries),
  };
  for (const e of g.edges) (push(ix.out, e.f, e), push(ix.into, e.t, e));
  for (const f of g.fns) push(ix.fnsOf, f.cls, f);
  for (const c of g.classes) push(ix.classesOf, c.area, c);
  for (const l of ix.out.values()) l.sort((a, b) => a.l - b.l);
  return ix;
}

/** The class a function, signal, field or class belongs to. */
export function ownerOf(ix: CodeIndex, id: string): string | undefined {
  return ix.fn.get(id)?.cls ?? ix.sig.get(id)?.cls ?? ix.field.get(id)?.cls ?? (ix.cls.has(id) ? id : undefined);
}

export const fnLabel = (ix: CodeIndex, id: string) => {
  const f = ix.fn.get(id);
  return f ? `${ix.cls.get(f.cls)?.name ?? f.cls}.${f.name}` : id;
};

/** What an engine callback means, for a person. */
export function engineWhen(name: string): string {
  return (
    {
      _ready: 'when it enters the scene',
      _process: 'every frame',
      _physics_process: 'every physics tick',
      _input: 'on any input',
      _unhandled_input: 'on input nothing else took',
      _unhandled_key_input: 'on a key nothing else took',
      _shortcut_input: 'on a shortcut',
      _gui_input: 'on input over it',
      _draw: 'when it redraws',
      _notification: 'on engine notifications',
      _enter_tree: 'when added to the tree',
      _exit_tree: 'when removed from the tree',
      _init: 'when made',
      _integrate_forces: 'during physics',
    } as Record<string, string>
  )[name] ?? 'called by the engine';
}

/* ---------------- links between classes ---------------- */

export type LinkKind = 'call' | 'signal' | 'new' | 'read' | 'write';
export const LINK_KINDS: LinkKind[] = ['call', 'signal', 'new', 'read', 'write'];

export interface Link {
  from: string;
  to: string;
  kind: LinkKind;
  /** The edges behind it (for signals, the emit and the listen). */
  edges: CodeEdge[];
  /** What it's about: method, signal or field names. */
  names: Set<string>;
}

/** Every link between two different classes: calls, signals emitted to a listener, objects made, state read or written. */
export function classLinks(ix: CodeIndex): Link[] {
  const out = new Map<string, Link>();
  const add = (from: string | undefined, to: string | undefined, kind: LinkKind, name: string, ...edges: CodeEdge[]) => {
    if (!from || !to || from === to) return;
    const k = `${kind}\n${from}\n${to}`;
    let l = out.get(k);
    if (!l) out.set(k, (l = { from, to, kind, edges: [], names: new Set() }));
    l.edges.push(...edges);
    l.names.add(name);
  };
  for (const e of ix.g.edges) {
    const from = ix.fn.get(e.f)?.cls;
    if (e.k === 'call') add(from, ix.fn.get(e.t)?.cls, 'call', ix.fn.get(e.t)?.name ?? e.t, e);
    else if (e.k === 'new') add(from, e.t, 'new', 'new', e);
    else if (e.k === 'read' || e.k === 'write') add(from, ix.field.get(e.t)?.cls, e.k, ix.field.get(e.t)?.name ?? e.t, e);
    else if (e.k === 'emit') {
      // A signal links who emits it to who handles it, the bus in between left out.
      for (const h of ix.out.get(e.t) ?? []) if (h.k === 'listen') add(from, ix.fn.get(h.t)?.cls, 'signal', ix.sig.get(e.t)?.name ?? e.t, e, h);
    }
  }
  return [...out.values()];
}

export interface VisLink {
  from: string;
  to: string;
  kind: LinkKind;
  n: number;
  names: string[];
  links: Link[];
}

/** Links summed between what's shown: a class, or its area when the area is folded. */
export function visibleLinks(links: Link[], nodeOf: (cls: string) => string | undefined, kinds: Set<LinkKind>): VisLink[] {
  const out = new Map<string, VisLink>();
  for (const l of links) {
    if (!kinds.has(l.kind)) continue;
    const a = nodeOf(l.from);
    const b = nodeOf(l.to);
    if (!a || !b || a === b) continue;
    const k = `${l.kind}\n${a}\n${b}`;
    let v = out.get(k);
    if (!v) out.set(k, (v = { from: a, to: b, kind: l.kind, n: 0, names: [], links: [] }));
    v.n += l.edges.reduce((s, e) => s + (e.n ?? 1), 0);
    v.links.push(l);
    for (const n of l.names) if (!v.names.includes(n)) v.names.push(n);
  }
  return [...out.values()];
}

/** Rows for the map: how far each node is from the engine along calls, signals and objects made; the rest last. Rows wrap. */
export function depthRows(nodes: string[], links: { from: string; to: string; kind: LinkKind }[], starts: string[], wrap = 7): string[][] {
  const depth = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const l of links) if (l.kind === 'call' || l.kind === 'signal' || l.kind === 'new') push(next, l.from, l.to);
  const q = starts.filter(s => nodes.includes(s));
  for (const s of q) depth.set(s, 0);
  for (let i = 0; i < q.length; i++) for (const t of next.get(q[i]) ?? []) if (!depth.has(t)) (depth.set(t, depth.get(q[i])! + 1), q.push(t));
  const max = Math.max(0, ...depth.values());
  const byRow = new Map<number, string[]>();
  for (const n of nodes) push(byRow, depth.get(n) ?? max + 1, n);
  const rows: string[][] = [];
  for (const r of [...byRow.keys()].sort((a, b) => a - b)) {
    const row = byRow.get(r)!.sort();
    for (let i = 0; i < row.length; i += wrap) rows.push(row.slice(i, i + wrap));
  }
  return rows;
}

/* ---------------- a function: its steps, and how it's reached ---------------- */

export interface Step {
  /** What the step is: a function called, an object made, a signal emitted, or (going up) a caller. */
  kind: 'call' | 'new' | 'emit' | 'listen' | 'caller' | 'engine';
  id: string;
  edge?: CodeEdge;
}

/** What a function does, in the order its lines do it: calls, objects made, signals emitted. */
export function stepsDown(ix: CodeIndex, id: string): Step[] {
  if (ix.sig.has(id)) return (ix.out.get(id) ?? []).filter(e => e.k === 'listen').map(e => ({ kind: 'listen', id: e.t, edge: e }));
  if (ix.cls.has(id)) {
    // An object made: what runs as it's made, then what the engine calls on it.
    const fns = ix.fnsOf.get(id) ?? [];
    return [...fns.filter(f => f.name === '(fields)' || f.name === '_init'), ...fns.filter(f => f.engine && f.name !== '_init')].map(f => ({ kind: 'call' as const, id: f.id }));
  }
  return (ix.out.get(id) ?? []).filter(e => e.k === 'call' || e.k === 'new' || e.k === 'emit').map(e => ({ kind: e.k as Step['kind'], id: e.t, edge: e }));
}

/** Who calls a function: callers, emitters of the signals it handles, makers of its object; the engine for a callback. */
export function stepsUp(ix: CodeIndex, id: string): Step[] {
  const out: Step[] = [];
  const f = ix.fn.get(id);
  if (f?.engine && f.name !== '_init') out.push({ kind: 'engine', id: 'engine' });
  for (const e of ix.into.get(id) ?? []) {
    if (e.k === 'call') out.push({ kind: 'caller', id: e.f, edge: e });
    else if (e.k === 'listen') for (const em of ix.into.get(e.f) ?? []) if (em.k === 'emit') out.push({ kind: 'emit', id: em.f, edge: em });
  }
  if (f && (f.name === '_init' || f.name === '(fields)' || f.engine)) for (const e of ix.into.get(f.cls) ?? []) if (e.k === 'new') out.push({ kind: 'new', id: e.f, edge: e });
  const seen = new Set<string>();
  return out.filter(s => !seen.has(s.kind + s.id) && seen.add(s.kind + s.id));
}

/** The shortest ways the engine reaches a function: up to `max` stacks, each from an entry point down to it. */
export function stacksTo(ix: CodeIndex, id: string, max = 5): { frames: string[]; via: Step['kind'][] }[] {
  const parent = new Map<string, { id: string; kind: Step['kind'] }>();
  const q = [id];
  const seen = new Set([id]);
  const found: string[] = [];
  for (let i = 0; i < q.length && found.length < max && i < 20000; i++) {
    const cur = q[i];
    if (cur !== id && ix.entries.has(cur)) {
      found.push(cur);
      continue;
    }
    for (const s of stepsUp(ix, cur)) {
      if (s.kind === 'engine') {
        if (cur === id) found.push(cur);
        continue;
      }
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      parent.set(s.id, { id: cur, kind: s.kind });
      q.push(s.id);
    }
  }
  return found.map(top => {
    const frames = [top];
    const via: Step['kind'][] = [];
    for (let at = top; at !== id; ) {
      const p = parent.get(at)!;
      via.push(p.kind);
      frames.push(p.id);
      at = p.id;
    }
    return { frames, via };
  });
}

/** What a function touches of other classes: fields read and written. */
export function stateOf(ix: CodeIndex, id: string): { reads: CodeEdge[]; writes: CodeEdge[] } {
  const out = ix.out.get(id) ?? [];
  return { reads: out.filter(e => e.k === 'read'), writes: out.filter(e => e.k === 'write') };
}

/* ---------------- where two systems meet ---------------- */

export interface Touch {
  /** The function on the system's side. */
  fn: string;
  /** What it touches: a function, a field or the class it makes. */
  target: string;
  kind: 'calls' | 'changes' | 'reads' | 'makes';
  edge: CodeEdge;
}

export interface Meeting {
  mid: string;
  a: Touch[];
  b: Touch[];
  /** a⇒b: A changes it, B reads it (or A calls it and it calls B); b⇒a the other way; shared: both only read it. */
  how: 'a⇒b' | 'b⇒a' | 'both' | 'shared';
}

export interface Between {
  /** Direct links, each way. */
  ab: Link[];
  ba: Link[];
  meetings: Meeting[];
}

/** How a function touches another class's code or state. */
function touches(ix: CodeIndex, side: Set<string>, mid: (cls: string) => boolean): Map<string, Touch[]> {
  const out = new Map<string, Touch[]>();
  for (const c of side) {
    for (const f of ix.fnsOf.get(c) ?? []) {
      for (const e of ix.out.get(f.id) ?? []) {
        let to: string | undefined;
        let kind: Touch['kind'];
        if (e.k === 'call') (to = ix.fn.get(e.t)?.cls), (kind = ix.fn.get(e.t)?.mut ? 'changes' : 'calls');
        else if (e.k === 'read') (to = ix.field.get(e.t)?.cls), (kind = 'reads');
        else if (e.k === 'write') (to = ix.field.get(e.t)?.cls), (kind = 'changes');
        else if (e.k === 'new') (to = e.t), (kind = 'makes');
        else continue;
        if (to && !side.has(to) && mid(to)) push(out, to, { fn: f.id, target: e.t, kind, edge: e });
      }
    }
  }
  return out;
}

/** Calls from one system's functions into another's, to tell "it calls into B" from "it only reads". */
function drives(ix: CodeIndex, from: string, side: Set<string>): boolean {
  for (const f of ix.fnsOf.get(from) ?? []) for (const e of ix.out.get(f.id) ?? []) {
    if (e.k === 'call' && side.has(ix.fn.get(e.t)?.cls ?? '')) return true;
    if (e.k === 'emit') for (const h of ix.out.get(e.t) ?? []) if (h.k === 'listen' && side.has(ix.fn.get(h.t)?.cls ?? '')) return true;
  }
  return false;
}

/** Where systems A and B meet: links straight between them, and the classes both touch, with which way influence runs. */
export function between(ix: CodeIndex, links: Link[], a: Set<string>, b: Set<string>): Between {
  const ab = links.filter(l => a.has(l.from) && b.has(l.to));
  const ba = links.filter(l => b.has(l.from) && a.has(l.to));
  const free = (c: string) => !a.has(c) && !b.has(c);
  const ta = touches(ix, a, free);
  const tb = touches(ix, b, free);
  const meetings: Meeting[] = [];
  const changes = (t: Touch[]) => t.some(x => x.kind === 'changes' || x.kind === 'makes');
  for (const mid of new Set([...ta.keys(), ...tb.keys()])) {
    const at = ta.get(mid) ?? [];
    const bt = tb.get(mid) ?? [];
    const toB = drives(ix, mid, b);
    const toA = drives(ix, mid, a);
    if (!(at.length && (bt.length || toB)) && !(bt.length && toA)) continue;
    // A reaches B through it when A changes what B uses of it, or A calls it and it calls into B.
    const aToB = (changes(at) && bt.length > 0) || (at.length > 0 && toB);
    const bToA = (changes(bt) && at.length > 0) || (bt.length > 0 && toA);
    meetings.push({ mid, a: at, b: bt, how: aToB && bToA ? 'both' : aToB ? 'a⇒b' : bToA ? 'b⇒a' : 'shared' });
  }
  const rank = { 'both': 0, 'a⇒b': 0, 'b⇒a': 0, shared: 1 };
  meetings.sort((x, y) => rank[x.how] - rank[y.how] || y.a.length + y.b.length - (x.a.length + x.b.length));
  return { ab, ba, meetings };
}

/* ---------------- what a scope changed ---------------- */

export interface CodeChange {
  added: CodeEdge[];
  removed: CodeEdge[];
  newFns: Set<string>;
  goneFns: CodeFn[];
  newClasses: Set<string>;
  goneClasses: CodeClass[];
  newSignals: Set<string>;
  /** Functions whose text changed (from the scope's definitions). */
  edited: Set<string>;
  /** Classes with anything above. */
  touched: Set<string>;
}

/** The functions a change's definitions name (added or changed), in a graph. */
export function fnsChanged(ix: CodeIndex, change: DesignChange): Set<string> {
  const names = new Map<string, string[]>();
  for (const s of [...change.symbols.changed, ...change.symbols.added]) if (s.kind === 'function' || s.kind === 'method') push(names, s.file, s.name);
  return new Set(ix.g.fns.filter(f => names.get(f.file)?.includes(f.name)).map(f => f.id));
}

export const edgeKey = (e: CodeEdge) => `${e.k}\n${e.f}\n${e.t}`;

export function codeChange(before: CodeIndex | undefined, after: CodeIndex, change?: DesignChange): CodeChange {
  const b = new Map((before?.g.edges ?? []).map(e => [edgeKey(e), e]));
  const a = new Map(after.g.edges.map(e => [edgeKey(e), e]));
  const c: CodeChange = {
    added: [...a].filter(([k]) => before && !b.has(k)).map(([, e]) => e),
    removed: [...b].filter(([k]) => !a.has(k)).map(([, e]) => e),
    newFns: new Set(before ? after.g.fns.filter(f => !before.fn.has(f.id)).map(f => f.id) : []),
    goneFns: before ? before.g.fns.filter(f => !after.fn.has(f.id)) : [],
    newClasses: new Set(before ? after.g.classes.filter(x => !before.cls.has(x.id)).map(x => x.id) : []),
    goneClasses: before ? before.g.classes.filter(x => !after.cls.has(x.id)) : [],
    newSignals: new Set(before ? after.g.signals.filter(s => !before.sig.has(s.id)).map(s => s.id) : []),
    edited: new Set(),
    touched: new Set(),
  };
  if (change) for (const f of fnsChanged(after, change)) c.edited.add(f);
  for (const id of [...c.newFns, ...c.edited]) c.touched.add(after.fn.get(id)!.cls);
  for (const id of c.newClasses) c.touched.add(id);
  for (const e of c.added) {
    const o = ownerOf(after, e.f);
    if (o) c.touched.add(o);
  }
  for (const e of c.removed) {
    const o = before && ownerOf(before, e.f);
    if (o && after.cls.has(o)) c.touched.add(o);
  }
  return c;
}

/** A line about one changed edge, for a person. */
export function edgeSentence(ix: CodeIndex, e: CodeEdge, other?: CodeIndex): string {
  const g = (id: string) => (ix.fn.has(id) || !other ? ix : other);
  const fl = (id: string) => fnLabel(g(id), id);
  const name = (id: string) => g(id).sig.get(id)?.name ?? g(id).field.get(id)?.name ?? id;
  const cls = (id: string) => (g(id).field.get(id) ?? g(id).sig.get(id))?.cls ?? '';
  switch (e.k) {
    case 'call':
      return `${fl(e.f)} calls ${fl(e.t)}`;
    case 'new':
      return `${fl(e.f)} makes a ${e.t}`;
    case 'emit':
      return `${fl(e.f)} emits ${cls(e.t)}.${name(e.t)}`;
    case 'listen':
      return `${fl(e.t)} handles ${cls(e.f)}.${name(e.f)}${e.via ? ` (connected in ${fl(e.via)})` : ''}`;
    case 'read':
      return `${fl(e.f)} reads ${cls(e.t)}.${name(e.t)}`;
    case 'write':
      return `${fl(e.f)} writes ${cls(e.t)}.${name(e.t)}`;
  }
}

/** Classes and functions by name, for the search box. */
export function searchCode(ix: CodeIndex, q: string, max = 30): { id: string; label: string; kind: 'class' | 'function' | 'signal'; sub: string }[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const hits: { id: string; label: string; kind: 'class' | 'function' | 'signal'; sub: string; score: number }[] = [];
  const score = (label: string) => {
    const l = label.toLowerCase();
    const i = l.indexOf(s);
    return i < 0 ? -1 : (i === 0 || l[i - 1] === '.' ? 0 : 1) + l.length / 100;
  };
  for (const c of ix.g.classes) {
    const sc = score(c.name);
    if (sc >= 0) hits.push({ id: c.id, label: c.name, kind: 'class', sub: c.file, score: sc - 1 });
  }
  for (const f of ix.g.fns) {
    const label = fnLabel(ix, f.id);
    const sc = Math.min(...[score(f.name), score(label)].filter(x => x >= 0).concat([99]));
    if (sc < 99) hits.push({ id: f.id, label, kind: 'function', sub: `${f.file}:${f.line}`, score: sc });
  }
  for (const g of ix.g.signals) {
    const sc = score(g.name);
    if (sc >= 0) hits.push({ id: g.id, label: `${ix.cls.get(g.cls)?.name ?? g.cls}.${g.name}`, kind: 'signal', sub: 'signal', score: sc + 0.5 });
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, max);
}

/* ---------------- groups: the level between an area and its classes ---------------- */

/** An area with more classes than this splits into groups. */
export const GROUP_OVER = 9;
const GROUP_MAX = 9;

export interface Group {
  /** `group:<area>|<key>`. */
  id: string;
  area: string;
  name: string;
  /** What it does: the map's Systems line, else its main class's doc comment. */
  text: string;
  classes: string[];
  /** The class most of the others link to. */
  hub?: string;
  /** Named in the map's Systems section. */
  declared?: true;
}

const firstLine = (s: string | undefined) => (s ?? '').split('\n')[0].trim();

/**
 * Groups of classes inside each large area: the map's Systems section first, the rest clustered
 * by how much they link to each other (greedy modularity, capped at GROUP_MAX classes a group).
 * Classes left on their own join the group they link to most, or a group of loose ones.
 */
export function groupClasses(ix: CodeIndex, links: Link[]): Map<string, Group[]> {
  const out = new Map<string, Group[]>();
  const w = new Map<string, Map<string, number>>();
  const addW = (a: string, b: string, n: number) => {
    if (!w.has(a)) w.set(a, new Map());
    w.get(a)!.set(b, (w.get(a)!.get(b) ?? 0) + n);
  };
  for (const l of links) (addW(l.from, l.to, l.edges.length), addW(l.to, l.from, l.edges.length));
  const wt = (a: string, b: string) => w.get(a)?.get(b) ?? 0;
  for (const [area, cs] of ix.classesOf) {
    if (cs.length <= GROUP_OVER) continue;
    const groups: Group[] = [];
    const left = new Set(cs.map(c => c.id));
    for (const s of ix.g.systems ?? []) {
      const mine = s.classes.filter(c => left.has(c));
      if (!mine.length) continue;
      for (const c of mine) left.delete(c);
      groups.push({ id: `group:${area}|${s.name}`, area, name: s.name, text: s.text, classes: mine, declared: true });
    }
    // Greedy modularity over what's left: merge the pair of clusters that gains most, while it gains.
    const pool = [...left].sort();
    const deg = new Map(pool.map(c => [c, pool.reduce((s, d) => s + (d === c ? 0 : wt(c, d)), 0)]));
    const m2 = [...deg.values()].reduce((s, d) => s + d, 0) || 1;
    let clusters = pool.map(c => ({ cs: [c], deg: deg.get(c)! }));
    for (;;) {
      let best: [number, number, number] | undefined;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          if (clusters[i].cs.length + clusters[j].cs.length > GROUP_MAX) continue;
          let e = 0;
          for (const a of clusters[i].cs) for (const b of clusters[j].cs) e += wt(a, b);
          if (!e) continue;
          const gain = e / m2 - (clusters[i].deg * clusters[j].deg) / (m2 * m2) * 2;
          if (gain > 0 && (!best || gain > best[2])) best = [i, j, gain];
        }
      }
      if (!best) break;
      const [i, j] = best;
      clusters[i] = { cs: [...clusters[i].cs, ...clusters[j].cs], deg: clusters[i].deg + clusters[j].deg };
      clusters.splice(j, 1);
    }
    // A class on its own joins the group it links to most; with no links it's loose.
    const loose: string[] = [];
    const big = () => [...clusters.filter(c => c.cs.length > 1).map(c => c.cs), ...groups.map(g => g.classes)];
    for (const one of clusters.filter(c => c.cs.length === 1).map(c => c.cs[0])) {
      let into: string[] | undefined;
      let most = 0;
      for (const g of big()) {
        if (g.length >= GROUP_MAX + 2) continue;
        const n = g.reduce((s, c) => s + wt(one, c), 0);
        if (n > most) (most = n), (into = g);
      }
      if (into) into.push(one);
      else loose.push(one);
    }
    clusters = clusters.filter(c => c.cs.length > 1);
    for (const c of clusters) {
      const inner = (x: string) => c.cs.reduce((s, y) => s + wt(x, y), 0);
      const hub = [...c.cs].sort((a, b) => inner(b) - inner(a) || (deg.get(b) ?? 0) - (deg.get(a) ?? 0) || a.localeCompare(b))[0];
      const name = ix.cls.get(hub)?.name ?? hub;
      groups.push({ id: `group:${area}|${hub}`, area, name: c.cs.length > 1 ? `${name} +${c.cs.length - 1}` : name, text: firstLine(ix.cls.get(hub)?.doc), classes: c.cs, hub });
    }
    if (loose.length) groups.push({ id: `group:${area}|(loose)`, area, name: loose.length === 1 ? ix.cls.get(loose[0])?.name ?? loose[0] : 'On their own', text: loose.length === 1 ? firstLine(ix.cls.get(loose[0])?.doc) : 'Classes that link to nothing else here', classes: loose });
    for (const g of groups) g.classes.sort((a, b) => (ix.cls.get(a)?.name ?? a).localeCompare(ix.cls.get(b)?.name ?? b));
    out.set(area, groups.sort((a, b) => b.classes.length - a.classes.length || a.name.localeCompare(b.name)));
  }
  return out;
}

/**
 * Autoloads that much of the game uses: global state, a bus, a table of constants, audio. Drawn
 * as rails beside the map, with a tap on each card that uses one, instead of a line from every
 * card. Classes of the game's own (a Genome everything reads) stay cards: they're its systems.
 */
export function railClasses(ix: CodeIndex, links: Link[]): Set<string> {
  const ins = new Map<string, Set<string>>();
  for (const l of links) {
    if (!ins.has(l.to)) ins.set(l.to, new Set());
    ins.get(l.to)!.add(l.from);
  }
  const min = Math.max(6, Math.ceil(ix.g.classes.length * 0.1));
  return new Set(ix.g.classes.filter(c => c.kind === 'autoload' && (ins.get(c.id)?.size ?? 0) >= min).map(c => c.id));
}

/** Lines into a focus card summed to the card itself, except those of `keep` (a function looked at), when there are too many to follow. */
export function collapseWires(ws: Wire[], focusCards: Set<string>, shown: (unit: string, pin: string) => boolean, keep?: string): Wire[] {
  const out = new Map<string, Wire>();
  for (const w of ws) {
    const mine = keep && ((focusCards.has(w.from) && w.fromPin === keep) || (focusCards.has(w.to) && w.toPin === keep));
    const fromPin = focusCards.has(w.from) && !mine && !shown(w.from, w.fromPin) ? '*' : w.fromPin;
    const toPin = focusCards.has(w.to) && !mine && !shown(w.to, w.toPin) ? '*' : w.toPin;
    const key = `${w.kind}|${w.from}|${fromPin}|${w.to}|${toPin}`;
    const x = out.get(key);
    if (!x) out.set(key, { ...w, key, fromPin, toPin, edges: [...w.edges], names: [...w.names], links: [...w.links] });
    else {
      x.edges.push(...w.edges);
      for (const n of w.names) if (!x.names.includes(n)) x.names.push(n);
      for (const l of w.links) if (!x.links.includes(l)) x.links.push(l);
    }
  }
  return [...out.values()];
}

/* ---------------- the canvas: a focus, its neighbours, and chips for the rest ---------------- */

export interface Tree {
  groups: Map<string, Group[]>;
  group: Map<string, Group>;
  /** Each class's group, in areas that have groups. */
  groupOf: Map<string, string>;
}

export function makeTree(groups: Map<string, Group[]>): Tree {
  const group = new Map<string, Group>();
  const groupOf = new Map<string, string>();
  for (const gs of groups.values()) for (const g of gs) {
    group.set(g.id, g);
    for (const c of g.classes) groupOf.set(c, g.id);
  }
  return { groups, group, groupOf };
}

export const isAreaId = (id: string) => id.startsWith('area:');
export const isGroupId = (id: string) => id.startsWith('group:');
/** The card a frame's unpinned cards are folded onto. */
export const isRestId = (id: string) => id.startsWith('rest:');

/** A class's place: its area, its group if the area has groups, itself. */
export function pathOf(ix: CodeIndex, t: Tree, cls: string): string[] {
  const c = ix.cls.get(cls);
  if (!c) return [cls];
  const g = t.groupOf.get(cls);
  return g ? [`area:${c.area}`, g, cls] : [`area:${c.area}`, cls];
}

/** What a unit holds: an area its groups (or classes), a group its classes. */
export function childrenOf(ix: CodeIndex, t: Tree, id: string): string[] {
  if (isAreaId(id)) {
    const a = id.slice(5);
    return t.groups.has(a) ? t.groups.get(a)!.map(g => g.id) : (ix.classesOf.get(a) ?? []).map(c => c.id);
  }
  if (isGroupId(id)) return t.group.get(id)?.classes ?? [];
  return [];
}

export function classesIn(ix: CodeIndex, t: Tree, id: string): string[] {
  if (isAreaId(id)) return (ix.classesOf.get(id.slice(5)) ?? []).map(c => c.id);
  if (isGroupId(id)) return t.group.get(id)?.classes ?? [];
  return ix.cls.has(id) ? [id] : [];
}

export const parentOf = (ix: CodeIndex, t: Tree, id: string): string | undefined => {
  if (isAreaId(id)) return undefined;
  if (isGroupId(id)) return `area:${t.group.get(id)?.area ?? ''}`;
  const p = pathOf(ix, t, id);
  return p.length > 1 ? p[p.length - 2] : undefined;
};

export interface CanvasInput {
  /** What's looked at: classes, groups or areas. Empty: the whole game, area by area. */
  focus: string[];
  /** Units split into what they hold. */
  expand: string[];
  /** Units kept whole, even where one of their classes would show on its own. */
  fold: string[];
  /** Areas drawn even though nothing links them to the focus, and ones put away as chips. */
  show: string[];
  hide: string[];
  /** Groups and areas opened in place: drawn as a frame around what they hold, nothing else changed. */
  open?: string[];
  /** Cards pinned inside a frame, and frames whose unpinned cards are folded onto one (`rest:<frame>`). */
  pins?: string[];
  tuck?: string[];
  kinds: Set<LinkKind>;
  /** Classes to draw on their own (where two systems in focus meet). */
  single?: Set<string>;
}

export interface Unit {
  id: string;
  /**
   * focus: a class looked at, drawn with its functions; frame: a group or area looked at, its
   * insides drawn in it; near: one step from the focus (or anything, with no focus); open: a near
   * group or area opened in place, holding its cards.
   */
  role: 'focus' | 'frame' | 'near' | 'open';
  /** The frame it's drawn in. */
  parent?: string;
  /** The classes it stands for here. */
  classes: string[];
  /** Links from its classes to classes that aren't drawn. */
  beyond: number;
  /** In a frame: links from its classes to what's outside the frame (drawn from the frame's edge). */
  outside: number;
  /** Its taps on the rails: rail class → links each way. */
  taps: Map<string, { in: number; out: number }>;
}

/** A line on the canvas: from a pin of one unit to a pin of another. A focus card's pins are its functions ('*' the class itself); another unit's pin is the unit at the other end. */
export interface Wire {
  key: string;
  from: string;
  fromPin: string;
  to: string;
  toPin: string;
  kind: LinkKind;
  edges: CodeEdge[];
  names: string[];
  links: Link[];
}

export interface Canvas {
  units: Unit[];
  wires: Wire[];
  /** Areas with classes not drawn: how many, and how many links reach them from what is. */
  chips: { area: string; hidden: number; links: number }[];
  rails: { id: string; taps: number }[];
  /** Where each class is: its unit, `chip:<area>`, or `rail:<class>`. */
  where: Map<string, string>;
}

/** Each function's place in a wire: who does it on the from side, who it reaches on the to side. */
function wireEnds(ix: CodeIndex, l: Link): { a: string; b: string; edges: CodeEdge[]; name: string }[] {
  if (l.kind === 'signal') {
    const out: { a: string; b: string; edges: CodeEdge[]; name: string }[] = [];
    for (let i = 0; i + 1 < l.edges.length; i += 2) out.push({ a: l.edges[i].f, b: l.edges[i + 1].t, edges: [l.edges[i], l.edges[i + 1]], name: ix.sig.get(l.edges[i].t)?.name ?? l.edges[i].t });
    return out;
  }
  return l.edges.map(e => ({ a: e.f, b: l.kind === 'call' ? e.t : '*', edges: [e], name: l.kind === 'call' ? ix.fn.get(e.t)?.name ?? e.t : l.kind === 'new' ? 'new' : ix.field.get(e.t)?.name ?? e.t }));
}

/**
 * What the canvas draws for a focus: the focus in full (a class with its functions, a group or
 * area as a frame with what it holds), what's one step from it summed at the coarsest level that
 * still tells it apart from the focus (a class beside it, a group of its area, another area), and
 * chips for the rest. With no focus, every area. Rails stand in for the classes everything uses.
 */
export function canvasOf(ix: CodeIndex, t: Tree, links: Link[], rails: Set<string>, inp: CanvasInput): Canvas {
  const focus = inp.focus.filter(f => classesIn(ix, t, f).length);
  const covered = new Map<string, string>();
  for (const f of focus) for (const c of classesIn(ix, t, f)) if (!covered.has(c)) covered.set(c, f);
  const isRail = (c: string) => rails.has(c) && !covered.has(c);
  const live = links.filter(l => inp.kinds.has(l.kind));
  const near = new Set<string>();
  for (const l of live) {
    if (covered.has(l.from) && !covered.has(l.to)) near.add(l.to);
    if (covered.has(l.to) && !covered.has(l.from)) near.add(l.from);
  }
  const expand = new Set(inp.expand);
  const fold = new Set(inp.fold);
  const show = new Set(inp.show);
  const hide = new Set(inp.hide);
  const open = new Set(inp.open ?? []);
  const tuck = new Set(inp.tuck ?? []);
  // A card holding a pin stays out of the rest too.
  const pinned = new Set((inp.pins ?? []).flatMap(p => (isAreaId(p) ? [p] : isGroupId(p) ? [`area:${t.group.get(p)?.area}`, p] : ix.cls.has(p) ? pathOf(ix, t, p) : [])));
  /** In a frame whose unpinned cards are folded away, a card without a pin goes on the frame's rest. */
  const tucked = (id: string, parent?: string) => (parent && tuck.has(parent) && !pinned.has(id) ? `rest:${parent}` : id);
  // Down the class's path as far as it's opened, back up to the highest fold (not above `min`, a frame's insides).
  const refine = (path: string[], i: number, min = 0) => {
    while (i < path.length - 1 && expand.has(path[i])) i++;
    const folded = path.slice(min, i + 1).findIndex(p => fold.has(p));
    return path[folded >= 0 ? min + folded : i];
  };
  const where = new Map<string, string>();
  const units = new Map<string, Unit>();
  const unit = (id: string, role: Unit['role'], parent?: string) => {
    let u = units.get(id);
    if (!u) units.set(id, (u = { id, role, ...(parent ? { parent } : {}), classes: [], beyond: 0, outside: 0, taps: new Map() }));
    return u;
  };
  for (const f of focus) if (!ix.cls.has(f)) unit(f, 'frame');
  /** A card opened in place becomes a frame, and the class goes one level down inside it, as often as opened. */
  const nest = (path: string[], id: string, parent?: string): [string, string | undefined] => {
    id = tucked(id, parent);
    for (let i = path.indexOf(id); open.has(id) && i >= 0 && i < path.length - 1; i = path.indexOf(id)) {
      unit(id, 'open', parent);
      parent = id;
      id = tucked(refine(path, i + 1, i + 1), parent);
    }
    return [id, parent];
  };
  for (const c of ix.g.classes) {
    const path = pathOf(ix, t, c.id);
    const f = covered.get(c.id);
    if (f !== undefined) {
      if (ix.cls.has(f)) unit(f, 'focus').classes.push(c.id), where.set(c.id, f);
      else {
        // Inside a frame: what the frame holds, split further where opened.
        const [id, parent] = nest(path, refine(path, path.indexOf(f) + 1, path.indexOf(f) + 1), f);
        unit(id, 'near', parent).classes.push(c.id);
        where.set(c.id, id);
      }
      continue;
    }
    if (rails.has(c.id)) {
      where.set(c.id, `rail:${c.id}`);
      continue;
    }
    let id: string | undefined;
    if (!focus.length) id = refine(path, 0);
    else if (near.has(c.id) || inp.single?.has(c.id)) {
      // The coarsest level that tells it apart from every focus, opened or folded as asked; with much in focus, its area.
      let depth = 0;
      for (const fo of focus.length > 5 ? [] : focus) {
        const fp = isAreaId(fo) ? [fo] : isGroupId(fo) ? [`area:${t.group.get(fo)!.area}`, fo] : pathOf(ix, t, fo);
        let i = 0;
        while (i < path.length - 1 && i < fp.length && path[i] === fp[i]) i++;
        depth = Math.max(depth, i);
      }
      id = inp.single?.has(c.id) ? c.id : refine(path, depth);
    } else if (show.has(path[0])) id = refine(path, 0);
    // Hidden: the card it would be on, or something holding it, was put away.
    if (id && !inp.single?.has(c.id) && path.slice(0, path.indexOf(id) + 1).some(x => hide.has(x) && !(x === path[0] && show.has(x)))) id = undefined;
    if (!id) {
      where.set(c.id, `chip:${c.area}`);
      continue;
    }
    const [inner, parent] = nest(path, id);
    unit(inner, 'near', parent).classes.push(c.id);
    where.set(c.id, inner);
  }
  // Lines: between pins; a focus card's pins are its functions.
  const wires = new Map<string, Wire>();
  /** The frame of what's looked at that a card is in, through any cards opened in place. */
  const lookedFrame = (u: Unit): string | undefined => {
    for (let p = u.parent; p; p = units.get(p)?.parent) if (units.get(p)?.role === 'frame') return p;
    return undefined;
  };
  const inFocus = (u: Unit) => u.role === 'focus' || u.role === 'frame' || !!lookedFrame(u);
  for (const l of live) {
    const a = where.get(l.from);
    const b = where.get(l.to);
    if (!a || !b || a === b) continue;
    let ua = units.get(a);
    let ub = units.get(b);
    if (ua && ub) {
      // A line leaving a frame leaves from its edge, as a collapsed graph's pins do; the card inside counts it.
      // (Cards opened in place keep their own lines: opening one is to see which of its cards link.)
      const fa = lookedFrame(ua);
      const fb = lookedFrame(ub);
      if (fa !== fb) {
        const n = l.edges.length;
        if (fa) (ua.outside += n), (ua = units.get(fa)!);
        if (fb) (ub.outside += n), (ub = units.get(fb)!);
        if (ua === ub) continue;
      }
      // With a focus, a line touches it (a focus card, or what a frame holds), or stays inside a card opened in place: what neighbours share isn't drawn.
      if (focus.length && !inFocus(ua) && !inFocus(ub) && !(ua.parent && ua.parent === ub.parent)) continue;
      for (const end of wireEnds(ix, l)) {
        const fromPin = ua.role === 'focus' ? end.a : ub.id;
        const toPin = ub.role === 'focus' ? end.b : ua.id;
        const key = `${l.kind}|${ua.id}|${fromPin}|${ub.id}|${toPin}`;
        let w = wires.get(key);
        if (!w) wires.set(key, (w = { key, from: ua.id, fromPin, to: ub.id, toPin, kind: l.kind, edges: [], names: [], links: [] }));
        w.edges.push(...end.edges);
        if (!w.names.includes(end.name)) w.names.push(end.name);
        if (!w.links.includes(l)) w.links.push(l);
      }
      continue;
    }
    const n = l.edges.length;
    const tap = (u: Unit | undefined, rail: string, dir: 'in' | 'out') => {
      if (!u) return;
      const x = u.taps.get(rail) ?? { in: 0, out: 0 };
      x[dir] += n;
      u.taps.set(rail, x);
    };
    if (b.startsWith('rail:')) tap(ua, l.to, 'out');
    else if (a.startsWith('rail:')) tap(ub, l.from, 'in');
    else if (ua && b.startsWith('chip:')) ua.beyond += n;
    else if (ub && a.startsWith('chip:')) ub.beyond += n;
  }
  const chips = new Map<string, { area: string; hidden: number; links: number }>();
  for (const [c, w] of where) {
    if (!w.startsWith('chip:')) continue;
    const area = w.slice(5);
    const x = chips.get(area) ?? { area, hidden: 0, links: 0 };
    x.hidden++;
    chips.set(area, x);
  }
  for (const l of live) {
    const a = where.get(l.from);
    const b = where.get(l.to);
    if (a?.startsWith('chip:') && b && units.has(b)) chips.get(a.slice(5))!.links += l.edges.length;
    else if (b?.startsWith('chip:') && a && units.has(a)) chips.get(b.slice(5))!.links += l.edges.length;
  }
  const railTaps = new Map<string, number>();
  for (const u of units.values()) for (const [r, x] of u.taps) railTaps.set(r, (railTaps.get(r) ?? 0) + x.in + x.out);
  return {
    units: [...units.values()],
    wires: [...wires.values()],
    chips: [...chips.values()].sort((x, y) => y.links - x.links || x.area.localeCompare(y.area)),
    rails: [...rails].filter(r => !covered.has(r)).map(id => ({ id, taps: railTaps.get(id) ?? 0 })).sort((x, y) => y.taps - x.taps),
    where,
  };
}

/** What a scope changed, as a focus: its classes, or their groups or areas when there are many. */
export function changeFocusOf(ix: CodeIndex, t: Tree, chg: CodeChange, max = 12): string[] {
  const cls = [...chg.touched].filter(c => ix.cls.has(c)).sort();
  if (cls.length <= max) return cls;
  const groups = [...new Set(cls.map(c => t.groupOf.get(c) ?? c))];
  if (groups.length <= max) return groups;
  return [...new Set(cls.map(c => `area:${ix.cls.get(c)!.area}`))];
}

/** The shortest way from an engine callback to what's looked at: to a function the scope changed if there is one, else one reached from outside. */
export function routeTo(ix: CodeIndex, t: Tree, focus: string[], chg?: CodeChange): string[] {
  const cls = new Set(focus.flatMap(f => classesIn(ix, t, f)).slice(0, 60));
  if (!cls.size) return [];
  const fns = [...cls].flatMap(c => ix.fnsOf.get(c) ?? []);
  const changed = fns.filter(f => chg?.edited.has(f.id) || chg?.newFns.has(f.id));
  const outside = (id: string) => (ix.into.get(id) ?? []).filter(e => (e.k === 'call' && !cls.has(ix.fn.get(e.f)?.cls ?? '')) || e.k === 'listen').length;
  const reached = fns.filter(f => outside(f.id) > 0).sort((a, b) => outside(b.id) - outside(a.id));
  const tries = (changed.length ? changed : reached.length ? reached : fns.filter(f => f.engine)).slice(0, 6);
  let best: string[] = [];
  for (const f of tries) {
    const s = stacksTo(ix, f.id, 1)[0];
    if (s && (!best.length || s.frames.length < best.length)) best = s.frames;
  }
  return best;
}
