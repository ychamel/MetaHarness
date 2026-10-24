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
  if (change) {
    const names = new Map<string, string[]>();
    for (const s of [...change.symbols.changed, ...change.symbols.added]) if (s.kind === 'function' || s.kind === 'method') push(names, s.file, s.name);
    for (const f of after.g.fns) if (names.get(f.file)?.includes(f.name)) c.edited.add(f.id);
  }
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
