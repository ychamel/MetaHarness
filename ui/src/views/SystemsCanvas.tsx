import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { applyNodeChanges, Background, Controls, Handle, MarkerType, NodeResizeControl, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import {
  childrenOf, collapseWires, edgeKey, engineWhen, fnLabel, isAreaId, isGroupId, parentOf,
  type Canvas, type CodeChange, type CodeIndex, type LinkKind, type Tree, type Unit, type Wire,
} from '../codeData.ts';
import { areaLabel } from '../designData.ts';
import type { SystemsNav } from './Systems.tsx';

/**
 * The Systems canvas (design §14): one screen for the whole game and any part of it. What's in
 * focus is drawn in full (a class with its functions as pins, a group or area as a frame with what
 * it holds), what's one step from it as cards whose pins are the things they link to, and the rest
 * as chips along the bottom; autoloads everything uses are rails on the right. Laid out left to
 * right by ELK, the way control flows, and animated as the focus changes.
 */

export const KIND_STYLE: Record<LinkKind | 'engine', { stroke: string; dash?: string; word: string }> = {
  call: { stroke: 'var(--text-2)', word: 'calls' },
  signal: { stroke: 'var(--paused)', dash: '6 4', word: 'signals' },
  new: { stroke: 'var(--done)', word: 'creates' },
  read: { stroke: 'var(--waiting)', dash: '2 4', word: 'reads' },
  write: { stroke: 'var(--limited)', dash: '6 3', word: 'writes' },
  engine: { stroke: 'var(--accent)', word: 'runs' },
};

/** What a person can do to a card. */
export type Act = 'select' | 'focus' | 'add' | 'expand' | 'shrink' | 'hide' | 'unfocus' | 'open' | 'close';

export interface CanvasProps {
  goal: string;
  ix: CodeIndex;
  t: Tree;
  canvas: Canvas;
  nav: SystemsNav;
  chg?: CodeChange;
  titles: Map<string, string>;
  summaries: Map<string, string>;
  /** The focus as the person set it, and the classes the scope changed (shown as one chip). */
  focus: string[];
  changeFocus: string[];
  changesOn: boolean;
  scopeTitle?: string;
  /** Functions from an engine callback down to what's looked at. */
  route: string[];
  /** A class lit from the inspector (a step of the trace hovered). */
  hl?: string;
  /** Classes lit for a moment (a commit or a file hovered): the rest dims. */
  lit?: Set<string>;
  canBack: boolean;
  onBack: () => void;
  onNav: (n: Partial<SystemsNav>) => void;
  onAct: (act: Act, unit: string) => void;
  onChanges: (on: boolean) => void;
}

const W_FOCUS = 270;
const W_NEAR = 220;
const ROW = 22;
const ROWS_MAX = 10;
const BLOB_ROWS = 6;
const DENSE = 40;

type Row = { pin: string; label: string; in: number; out: number; mark?: 'new' | 'edited'; engine?: string; on?: boolean; from?: string[]; to?: string[] };

type CardData = {
  unit: string;
  role: 'focus' | 'near' | 'engine';
  kind: 'class' | 'group' | 'area' | 'engine';
  title: string;
  sub: string;
  text: string;
  badges: string[];
  when: string[];
  rows: Row[];
  more: number;
  beyond: number;
  outside: number;
  taps: { name: string; n: number }[];
  changed: number;
  isNew: boolean;
  on: boolean;
  hl: boolean;
  /** Lit for a moment, or dimmed while others are. */
  peek: 'on' | 'off' | undefined;
  route: boolean;
  inFrame: boolean;
  /** Why it's on the canvas, in a line. */
  why: string;
  /** Sized by the person. */
  sized: boolean;
  /** A group or area holding more than one card: it can be opened in place. */
  opens: boolean;
  h: number;
  w: number;
  onAct: (a: Act) => void;
  onMenu: (e: ReactMouseEvent) => void;
  onResize: (w: number, h: number) => void;
  onRow: (pin: string, e: ReactMouseEvent) => void;
  onRowHover: (pin?: string) => void;
  onMore?: () => void;
};

type FrameData = { unit: string; title: string; sub: string; text: string; changed: number; on: boolean; open: boolean; onAct: (a: Act) => void; onMenu: (e: ReactMouseEvent) => void };

type Info = { kind: CardData['kind']; title: string; sub: string; text: string; badges: string[]; when: string[] };

const headHeight = (i: { text: string; badges: string[]; when: string[] }) => 50 + (i.text ? 30 : 0) + (i.badges.length || i.when.length ? 22 : 0);
/** How many rows fit a card sized by the person (its footer kept). */
const rowsFitting = (h: number, i: Info) => Math.max(1, Math.floor((h - headHeight(i) - 30) / ROW));

type Size = { w: number; h: number };

/** Cards the person resized, per goal, in the browser: a card keeps its size wherever it's drawn. */
function useSizes(goal: string): [Record<string, Size>, (id: string, s: Size | undefined) => void] {
  const key = `mh.systems.sizes.${goal}`;
  const [sizes, setSizes] = useState<Record<string, Size>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}');
    } catch {
      return {};
    }
  });
  const set = (id: string, sz: Size | undefined) =>
    setSizes(o => {
      const n = { ...o };
      if (sz) n[id] = { w: Math.round(sz.w), h: Math.round(sz.h) };
      else delete n[id];
      try {
        localStorage.setItem(key, JSON.stringify(n));
      } catch {
        // Kept for this visit only.
      }
      return n;
    });
  return [sizes, set];
}

/** A card's height, so the layout and the drawing agree. */
function cardHeight(d: { text: string; badges: string[]; when: string[]; rows: Row[]; more: number; beyond: number; outside: number; taps: unknown[] }): number {
  const head = headHeight(d);
  const foot = d.more || d.beyond || d.outside || d.taps.length ? 24 : 0;
  return head + d.rows.length * ROW + foot + 6;
}

const headerY = 18;
const rowY = (d: { text: string; badges: string[]; when: string[] }, i: number) => headHeight(d) + i * ROW + ROW / 2;

const firstLine = (s: string | undefined) => (s ?? '').split('\n')[0].trim();
const sentence = (s: string) => {
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(s);
  return (m ? m[1] : s).slice(0, 160);
};

export function SystemsCanvas(p: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...p} />
    </ReactFlowProvider>
  );
}

function CanvasInner(p: CanvasProps) {
  const { ix, t, canvas, nav, chg, titles, onNav, onAct } = p;
  const [hoverPin, setHoverPin] = useState<{ unit: string; pin: string }>();
  const [hoverEdge, setHoverEdge] = useState<string>();
  const [moreOpen, setMoreOpen] = useState<Set<string>>(new Set());
  const [sizes, setSize] = useSizes(p.goal);
  const [menu, setMenu] = useState<{ unit: string; x: number; y: number }>();
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => !(e.target as HTMLElement)?.closest?.('.sys-menu') && setMenu(undefined);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopImmediatePropagation(), setMenu(undefined));
    // Capture: the canvas stops the events it pans with, so a click on it would never reach the window otherwise.
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('keydown', esc, true);
    return () => (window.removeEventListener('pointerdown', close, true), window.removeEventListener('wheel', close, true), window.removeEventListener('keydown', esc, true));
  }, [menu]);
  const selFn = nav.sel && ix.fn.has(nav.sel) ? nav.sel : undefined;
  const unitName = (id: string) =>
    id === 'engine' ? 'Engine' : isAreaId(id) ? titles.get(id.slice(5)) ?? areaLabel(id.slice(5)) : isGroupId(id) ? t.group.get(id)?.name ?? id : ix.cls.get(id)?.name ?? id;
  /** What a card says about itself: its kind, name, path, a line of what it does, its badges, when the engine calls it. */
  const info = (u: Unit): Info => {
    const id = u.id;
    let title = unitName(id);
    const badges: string[] = [];
    const when = new Set<string>();
    for (const c of u.classes) for (const f of ix.fnsOf.get(c) ?? []) if (f.engine && ix.entries.has(f.id)) when.add(engineWhen(f.name));
    const w = [...when].slice(0, 3);
    if (isAreaId(id)) {
      const a = id.slice(5);
      const all = ix.classesOf.get(a)?.length ?? 0;
      return { kind: 'area', title, sub: `${a || 'top level'} · ${u.classes.length === all ? all : `${u.classes.length} of ${all}`} classes`, text: sentence(p.summaries.get(a) ?? ''), badges, when: w };
    }
    if (isGroupId(id)) {
      const g = t.group.get(id)!;
      if (!g.declared && g.classes.length > 1) title = g.name;
      return { kind: 'group', title, sub: `${u.classes.length === g.classes.length ? g.classes.length : `${u.classes.length} of ${g.classes.length}`} classes`, text: sentence(g.text), badges, when: w };
    }
    const c = ix.cls.get(id)!;
    if (c.main) badges.push('main scene');
    if (c.kind === 'autoload') badges.push('autoload');
    if (c.base && c.base !== 'RefCounted') badges.push(c.base);
    return { kind: 'class', title, sub: c.file, text: sentence(firstLine(c.doc)), badges, when: w };
  };
  const routeUnits = useMemo(() => {
    const out: string[] = [];
    for (const fn of p.route) {
      const c = ix.fn.get(fn)?.cls;
      const w = c ? canvas.where.get(c) : undefined;
      if (w && out[out.length - 1] !== w) out.push(w);
    }
    return out;
  }, [p.route, ix, canvas]);

  const model = useMemo(() => {
    const units = new Map(canvas.units.map(u => [u.id, u]));
    const focusCards = new Set(canvas.units.filter(u => u.role === 'focus').map(u => u.id));
    const overview = !canvas.units.some(u => u.role === 'focus' || u.role === 'frame');
    // A focus card's rows: its functions that lines touch, changed and engine-called ones first.
    const fnRows = new Map<string, Row[]>();
    const more = new Map<string, number>();
    for (const u of focusCards) {
      const by = new Map<string, Row>();
      for (const w of canvas.wires) {
        for (const [end, pin, dir] of [[w.from, w.fromPin, 'out'], [w.to, w.toPin, 'in']] as const) {
          if (end !== u || pin === '*') continue;
          const f = ix.fn.get(pin);
          let r = by.get(pin);
          if (!r) by.set(pin, (r = { pin, label: f ? f.name : pin, in: 0, out: 0, from: [], to: [], ...(f?.engine ? { engine: engineWhen(f.name) } : {}), ...(chg?.newFns.has(pin) ? { mark: 'new' as const } : chg?.edited.has(pin) ? { mark: 'edited' as const } : {}) }));
          r[dir] += w.edges.length;
          const other = unitName(dir === 'out' ? w.to : w.from);
          const list = dir === 'out' ? r.to! : r.from!;
          if (!list.includes(other)) list.push(other);
        }
      }
      let rows = [...by.values()].sort((a, b) => Number(!!b.mark) - Number(!!a.mark) || Number(!!b.engine) - Number(!!a.engine) || b.in + b.out - (a.in + a.out) || a.label.localeCompare(b.label));
      // Several cards looked at: each keeps the functions that changed and the ones joining it to the others.
      if (focusCards.size > 3) {
        const joins = new Set(canvas.wires.filter(w => focusCards.has(w.from) && focusCards.has(w.to)).flatMap(w => [w.from === u ? w.fromPin : '', w.to === u ? w.toPin : '']));
        const kept = rows.filter(r => r.mark || joins.has(r.pin));
        if (kept.length) rows = [...kept, ...rows.filter(r => !kept.includes(r))];
        more.set(`${u}:cut`, kept.length || Math.min(rows.length, 4));
      }
      const fit = sizes[u] ? rowsFitting(sizes[u].h, info(units.get(u)!)) : undefined;
      const cut = moreOpen.has(u) ? rows.length : fit ?? Math.min(ROWS_MAX, more.get(`${u}:cut`) ?? ROWS_MAX);
      const keep = rows.slice(0, cut);
      if (selFn && ix.fn.get(selFn)?.cls && units.get(u)?.classes.includes(ix.fn.get(selFn)!.cls) && !keep.some(r => r.pin === selFn)) {
        const r = rows.find(x => x.pin === selFn);
        if (r) keep.push(r);
      }
      fnRows.set(u, keep.map(r => ({ ...r, on: r.pin === selFn })));
      more.set(u, rows.length - keep.length);
    }
    const rowShown = (u: string, pin: string) => !!fnRows.get(u)?.some(r => r.pin === pin);
    const keepFn = hoverPin && focusCards.has(hoverPin.unit) ? hoverPin.pin : selFn;
    // Too many lines to follow: they go to the card, but for the function hovered or looked at.
    // The layout uses the lines without those, so hovering never moves a card.
    const base = collapseWires(canvas.wires, focusCards, rowShown);
    const dense = base.length > DENSE;
    const shown = dense ? () => false : rowShown;
    const wires = collapseWires(canvas.wires, focusCards, shown, keepFn);
    const layoutWires = dense ? collapseWires(canvas.wires, focusCards, shown) : base;
    // Other cards' rows: the cards at the other end of their lines.
    const nearRows = new Map<string, Row[]>();
    for (const u of canvas.units) {
      if (u.role !== 'near') continue;
      const by = new Map<string, Row>();
      for (const w of wires) {
        if (w.from === u.id) {
          const r = by.get(w.to) ?? { pin: w.to, label: unitName(w.to), in: 0, out: 0 };
          r.out += w.edges.length;
          by.set(w.to, r);
        }
        if (w.to === u.id) {
          const r = by.get(w.from) ?? { pin: w.from, label: unitName(w.from), in: 0, out: 0 };
          r.in += w.edges.length;
          by.set(w.from, r);
        }
      }
      const rows = [...by.values()].sort((a, b) => b.in + b.out - (a.in + a.out) || a.label.localeCompare(b.label));
      const cut = moreOpen.has(u.id) ? rows.length : sizes[u.id] ? rowsFitting(sizes[u.id].h, info(u)) : BLOB_ROWS;
      nearRows.set(u.id, rows.slice(0, cut));
      more.set(u.id, rows.length - Math.min(rows.length, cut));
    }
    // Lines to a row that isn't drawn go to the card itself.
    const pinOf = (unit: string, pin: string) => (pin === '*' ? '*' : focusCards.has(unit) ? (fnRows.get(unit)?.some(r => r.pin === pin) ? pin : '*') : nearRows.get(unit)?.some(r => r.pin === pin) ? pin : '*');
    const merge = (ws: Wire[]) => {
      const merged = new Map<string, Wire>();
      for (const w of ws) {
        const fromPin = pinOf(w.from, w.fromPin);
        const toPin = pinOf(w.to, w.toPin);
        const key = `${w.kind}|${w.from}|${fromPin}|${w.to}|${toPin}`;
        const x = merged.get(key);
        if (!x) merged.set(key, { ...w, key, fromPin, toPin });
        else merged.set(key, { ...x, edges: [...x.edges, ...w.edges], names: [...new Set([...x.names, ...w.names])], links: [...new Set([...x.links, ...w.links])] });
      }
      return [...merged.values()];
    };
    // The engine starts the main scene and the autoloads: on the whole-game view, and at the head of a route.
    const roots = overview ? canvas.units.filter(u => u.classes.some(c => ix.cls.get(c)?.main || ix.cls.get(c)?.kind === 'autoload')).map(u => u.id) : [];
    const engineOn = roots.length > 0 || routeUnits.length > 0;
    const lines = (ws: Wire[]) => ws.map(w => ({ id: w.key, source: w.from, sourceHandle: `o:${w.fromPin}`, target: w.to, targetHandle: `i:${w.toPin}` }));
    const layoutEdges: Edge[] = [...lines(merge(layoutWires)), ...(roots.length && engineOn ? roots.map(r => ({ id: `engine->${r}`, source: 'engine', sourceHandle: 'o:*', target: r, targetHandle: 'i:*' })) : [])];
    if (routeUnits.length) layoutEdges.push({ id: 'engine->route', source: 'engine', sourceHandle: 'o:*', target: routeUnits.find(u => units.has(u)) ?? '', targetHandle: 'i:*' });
    return { units, focusCards, fnRows, nearRows, more, wires: merge(wires), layoutEdges, dense, roots, engineOn, overview };
  }, [canvas, ix, chg, selFn, hoverPin, moreOpen, sizes, routeUnits, titles, t]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Why a card is on the canvas. */
  const why = (u: Unit): string => {
    if (u.role === 'focus' || u.role === 'frame') return p.focus.includes(u.id) ? "You're looking at it." : 'The scope changed it.';
    const holder = u.parent ? canvas.units.find(x => x.id === u.parent) : undefined;
    if (holder?.role === 'frame') return `Part of ${unitName(holder.id)}, which you're looking at.`;
    if (u.role === 'open') return 'Opened in place: its cards are inside it.';
    if (!holder && !model.focusCards.size && !canvas.units.some(x => x.role === 'frame')) return 'Part of the whole game.';
    const with_ = new Map<string, number>();
    for (const w of canvas.wires) {
      if (w.from === u.id && w.to !== u.id) with_.set(w.to, (with_.get(w.to) ?? 0) + w.edges.length);
      if (w.to === u.id && w.from !== u.id) with_.set(w.from, (with_.get(w.from) ?? 0) + w.edges.length);
    }
    const ws = [...with_].sort((a, b) => b[1] - a[1]);
    if (holder) return `Inside ${unitName(holder.id)}, which you opened.${ws.length ? ` Links with ${ws.slice(0, 3).map(([x, n]) => `${unitName(x)} (${n})`).join(', ')}.` : ''}`;
    if (ws.length) return `One step from ${ws.slice(0, 3).map(([x, n]) => `${unitName(x)} (${n} link${n === 1 ? '' : 's'})`).join(', ')}${ws.length > 3 ? ` and ${ws.length - 3} more` : ''}.`;
    if (nav.show?.some(a => u.classes.some(c => `area:${ix.cls.get(c)?.area}` === a))) return 'You drew it from the chips.';
    return 'Where the two systems you look at meet.';
  };

  // The cards, sized here so the layout and the drawing agree.
  const cards = useMemo(() => {
    const out: { id: string; parent?: string; frame?: FrameData; card?: CardData }[] = [];
    const routeSet = new Set(routeUnits);
    const act = (u: string) => (a: Act) => onAct(a, u);
    const selUnit = nav.sel ? (ix.fn.has(nav.sel) ? canvas.where.get(ix.fn.get(nav.sel)!.cls) : nav.sel) : undefined;
    const hlUnit = p.hl ? canvas.where.get(ix.fn.get(p.hl)?.cls ?? p.hl) : undefined;
    const litUnits = p.lit ? new Set([...p.lit].map(c => canvas.where.get(c))) : undefined;
    for (const u of canvas.units) {
      if (u.role !== 'frame' && u.role !== 'open') continue;
      const g = t.group.get(u.id);
      const a = isAreaId(u.id) ? u.id.slice(5) : g?.area ?? '';
      const all = isAreaId(u.id) ? ix.classesOf.get(a)?.length ?? 0 : g?.classes.length ?? 0;
      const drawn = canvas.units.filter(x => x.parent === u.id).reduce((n, x) => n + x.classes.length, 0);
      out.push({
        id: u.id,
        ...(u.parent ? { parent: u.parent } : {}),
        frame: {
          unit: u.id, title: unitName(u.id), open: u.role === 'open',
          sub: `${isAreaId(u.id) ? a || 'top level' : `group in ${titles.get(a) ?? areaLabel(a)}`} · ${u.role === 'open' && drawn < all ? `${drawn} of ${all} classes drawn, the rest in the chips` : `${all} classes`}`,
          text: sentence(isAreaId(u.id) ? p.summaries.get(a) ?? '' : g?.text ?? ''), changed: canvas.units.filter(x => x.parent === u.id).reduce((s, x) => s + x.classes.filter(c => chg?.touched.has(c)).length, 0),
          on: selUnit === u.id, onAct: act(u.id), onMenu: e => setMenu({ unit: u.id, x: e.clientX, y: e.clientY }),
        },
      });
    }
    const card = (u: Unit): CardData => {
      const focus = u.role === 'focus';
      const id = u.id;
      const { kind, title, sub, text, badges, when } = info(u);
      const rows = (focus ? model.fnRows.get(id) : model.nearRows.get(id)) ?? [];
      const taps = [...u.taps].map(([r, x]) => ({ name: ix.cls.get(r)?.name ?? r, n: x.in + x.out })).sort((a, b) => b.n - a.n);
      const d = { text, badges, when, rows, more: model.more.get(id) ?? 0, beyond: u.beyond, outside: u.outside, taps };
      const size = sizes[id];
      return {
        unit: id, role: focus ? 'focus' : 'near', kind, title, sub, ...d,
        changed: kind === 'class' ? (ix.fnsOf.get(id) ?? []).filter(f => chg?.edited.has(f.id) || chg?.newFns.has(f.id)).length : u.classes.filter(c => chg?.touched.has(c)).length,
        isNew: kind === 'class' && !!chg?.newClasses.has(id), on: selUnit === id, hl: hlUnit === id, peek: litUnits ? (litUnits.has(id) ? 'on' : 'off') : undefined, route: routeSet.has(id), inFrame: !!u.parent, why: why(u), sized: !!size, opens: (kind === 'area' || kind === 'group') && childrenOf(ix, t, id).length > 1,
        h: size?.h ?? cardHeight(d), w: size?.w ?? (focus ? W_FOCUS : W_NEAR), onAct: act(id),
        onMenu: e => setMenu({ unit: id, x: e.clientX, y: e.clientY }),
        onResize: (w, h) => (setMoreOpen(s => (s.has(id) ? new Set([...s].filter(x => x !== id)) : s)), setSize(id, { w, h })),
        onRow: (pin, e) => {
          if (focus) onNav({ sel: pin, trace: pin, up: false, link: undefined });
          else if (e.shiftKey || !model.focusCards.size) onAct('select', id);
          else onAct('add', id);
        },
        onRowHover: pin => setHoverPin(pin && focus ? { unit: id, pin } : undefined),
        onMore: () => (setSize(id, undefined), setMoreOpen(s => new Set(s).add(id))),
      };
    };
    for (const u of canvas.units) if (u.role !== 'frame' && u.role !== 'open') out.push({ id: u.id, ...(u.parent ? { parent: u.parent } : {}), card: card(u) });
    if (model.engineOn) {
      const d = { text: '', badges: [], when: [], rows: [], more: 0, beyond: 0, outside: 0, taps: [] };
      out.unshift({
        id: 'engine',
        card: {
          unit: 'engine', role: 'engine', kind: 'engine', title: 'Engine', sub: 'runs the main scene, the autoloads and the callbacks', ...d, changed: 0, isNew: false, on: false, hl: false, peek: litUnits ? 'off' : undefined, route: routeSet.size > 0, inFrame: false,
          why: 'The engine runs the main scene and the autoloads, and calls their callbacks.', sized: false, opens: false,
          h: cardHeight(d), w: 200, onAct: () => {}, onMenu: () => {}, onResize: () => {}, onRow: () => {}, onRowHover: () => {},
        },
      });
    }
    return out;
  }, [canvas, model, nav.sel, nav.show, p.hl, p.lit, p.summaries, p.focus, sizes, routeUnits, ix, t, chg, titles]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lines, and the route from the engine drawn over them.
  const edges = useMemo(() => {
    const out: Edge[] = [];
    const added = new Set(chg?.added.map(edgeKey));
    const order = new Map<string, number>();
    if (selFn) (ix.out.get(selFn) ?? []).forEach((e, i) => !order.has(e.t) && order.set(e.t, i));
    const few = model.wires.length <= 16;
    const peeking = !!p.lit;
    for (const w of model.wires) {
      const st = KIND_STYLE[w.kind];
      const isNew = w.edges.some(e => added.has(edgeKey(e)));
      const mine = !!selFn && (w.fromPin === selFn || w.toPin === selFn);
      const hovered = hoverEdge === w.key || (!!hoverPin && (w.fromPin === hoverPin.pin || w.toPin === hoverPin.pin));
      const n = w.edges.length;
      const names = w.kind === 'signal' ? `⚡ ${w.names.slice(0, 2).join(', ')}${w.names.length > 2 ? '…' : ''}` : `${st.word} ${w.names.slice(0, 2).join(', ')}${w.names.length > 2 ? ` +${w.names.length - 2}` : ''}`;
      // The selected function's lines are numbered in the order its code reaches them.
      const step = mine && w.fromPin === selFn ? Math.min(...w.edges.filter(e => e.f === selFn).map(e => (ix.out.get(selFn) ?? []).indexOf(e))) : -1;
      const label = hovered || mine || isNew || few ? `${step >= 0 ? `${step + 1}. ` : ''}${isNew ? 'new · ' : ''}${names}${n > 1 ? ` ×${n}` : ''}` : undefined;
      const lit = mine || hovered;
      const dim = (!!selFn || !!hoverPin) && !lit;
      out.push({
        id: w.key, source: w.from, target: w.to, sourceHandle: `o:${w.fromPin}`, targetHandle: `i:${w.toPin}`, data: { wire: w }, interactionWidth: 14,
        label, labelStyle: { fill: isNew ? 'var(--chg-new)' : st.stroke, fontSize: 11, fontWeight: lit || isNew ? 600 : 400 }, labelBgStyle: { fill: 'var(--panel)' },
        style: { stroke: isNew ? 'var(--chg-new)' : st.stroke, strokeDasharray: st.dash, strokeWidth: (lit ? 1.25 : 0) + (isNew ? 0.75 : 0) + Math.min(3.5, 1.1 + Math.log2(n) * 0.45), opacity: dim || peeking ? 0.12 : 0.85 },
        markerEnd: { type: MarkerType.ArrowClosed, color: isNew ? 'var(--chg-new)' : st.stroke }, zIndex: lit ? 5 : 0,
      });
    }
    if (model.engineOn) {
      for (const r of model.roots) out.push({ id: `engine->${r}`, source: 'engine', target: r, sourceHandle: 'o:*', targetHandle: 'i:*', style: { stroke: 'var(--accent)', strokeWidth: 1.5, opacity: 0.6 }, markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--accent)' } });
      const drawn = ['engine', ...routeUnits.filter(u => model.units.has(u))];
      for (let i = 0; i + 1 < drawn.length; i++) {
        out.push({
          id: `route:${i}`, source: drawn[i], target: drawn[i + 1], sourceHandle: 'o:*', targetHandle: 'i:*', animated: true, zIndex: 6,
          style: { stroke: 'var(--accent)', strokeWidth: 2.25, strokeDasharray: '6 4', opacity: 0.9 }, markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--accent)' },
        });
      }
    }
    return out;
  }, [model, chg, selFn, hoverEdge, hoverPin, routeUnits, ix, p.lit]);

  const lay = useElkLayout(p.goal, cards, model.layoutEdges);
  // A frame's lines leave and enter by the side facing the card at the other end.
  const routed = useMemo(() => {
    const box = new Map(lay.nodes.filter(n => !n.parentId).map(n => [n.id, { x: n.position.x, w: Number(n.style?.width ?? n.measured?.width ?? 0), frame: n.type === 'frame' }]));
    return edges.map(e => {
      const s = box.get(e.source);
      const t = box.get(e.target);
      if (!s || !t || (!s.frame && !t.frame)) return e;
      let out = e;
      if (s.frame && t.x + t.w / 2 < s.x) out = { ...out, sourceHandle: 'ol:*' };
      if (t.frame && s.x + s.w / 2 > t.x + t.w) out = { ...out, targetHandle: 'ir:*' };
      return out;
    });
  }, [edges, lay.nodes]);
  const flow = useReactFlow();
  // The view moves when what's looked at changes; opening, splitting or hiding a card leaves it where it is.
  const lookedKey = canvas.units.filter(u => u.role === 'focus' || u.role === 'frame').map(u => u.id).sort().join('\n');
  const fitted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!lay.fresh || fitted.current === lookedKey) return;
    fitted.current = lookedKey;
    // What's looked at, at a zoom you can read; what's around it a scroll away when it doesn't all fit.
    const looked = canvas.units.filter(u => u.role === 'focus' || u.role === 'frame').map(u => ({ id: u.id }));
    // The new cards reach React Flow and are measured a few frames after they're drawn; fitting before that finds nothing.
    let tries = 0;
    let raf = 0;
    const fit = () => {
      const ns = flow.getNodes();
      const ready = ns.length > 0 && ns.every(n => n.measured?.width) && looked.every(l => ns.some(n => n.id === l.id));
      if (!ready && tries++ < 60) {
        raf = requestAnimationFrame(fit);
        return;
      }
      flow.fitView({ padding: 0.12, maxZoom: 1, minZoom: looked.length ? 0.55 : 0.3, duration: 350, ...(looked.length ? { nodes: looked } : {}) });
    };
    raf = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(raf);
  }, [lay.fresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeChip = p.changeFocus.length > 0;
  const routeOn = nav.route !== false;
  const routeChips = new Set(routeUnits.filter(u => u.startsWith('chip:')).map(u => u.slice(5)));
  return (
    <div className="sys-map">
      <div className="sys-banner sys-focusbar">
        <button className="btn ghost small" onClick={p.onBack} disabled={!p.canBack} title="Back to what you looked at before (Esc)">
          ←
        </button>
        <button className={`btn small${!p.focus.length && !(changeChip && p.changesOn) ? ' on' : ''}`} onClick={() => onAct('unfocus', '*')} title="The whole game, area by area">
          Whole game
        </button>
        {changeChip && (
          <button className={`focus-chip changes${p.changesOn ? ' on' : ''}`} onClick={() => p.onChanges(!p.changesOn)} title={p.changesOn ? 'Stop looking at what the scope changed' : 'Look at what the scope changed'}>
            ✱ {p.scopeTitle ? `What “${p.scopeTitle.slice(0, 40)}” changed` : 'What this scope changed'} <span className="muted">{p.changeFocus.length}</span>
            {p.changesOn && <span className="x">×</span>}
          </button>
        )}
        {p.focus.map(f => (
          <span key={f} className="focus-chip on">
            <button className="text-link" onClick={() => onNav({ sel: f, link: undefined })}>
              {unitName(f)}
            </button>
            <button className="x" onClick={() => onAct('unfocus', f)} aria-label={`Stop looking at ${unitName(f)}`}>
              ×
            </button>
          </span>
        ))}
        {(p.focus.length > 0 || (changeChip && p.changesOn)) && (
          <span className="muted small" title="Around what you look at: the cards one step from it, each saying what it links with. The rest of the game is in the chips below the canvas.">
            around it: {canvas.units.filter(u => (u.role === 'near' || u.role === 'open') && !u.parent).length} linked cards · the rest in the chips below · shift-click a card to add it
          </span>
        )}
        <span className="grow" />
        <label className={`layer-toggle${routeOn ? ' on' : ''}`} title="Draw the shortest way the engine reaches what's looked at">
          <input type="checkbox" checked={routeOn} onChange={e => onNav({ route: e.target.checked })} />⏵ Route from the engine
        </label>
        {lay.moved && (
          <button className="btn ghost small" onClick={lay.reset} title="Put every card back where the layout puts it">
            Reset layout
          </button>
        )}
      </div>
      <Adjustments nav={nav} name={unitName} onNav={onNav} />
      {routeOn && p.route.length > 0 && (
        <div className="sys-route small">
          <span className="muted">⏵ {ix.fn.get(p.route[0])?.engine ? engineWhen(ix.fn.get(p.route[0])!.name) : 'from'}:</span>
          {p.route.map((f, i) => (
            <span key={f + i}>
              {i > 0 && <span className="muted"> → </span>}
              <button className={`text-link mono${f === nav.sel ? ' strong' : ''}`} onClick={() => onNav({ sel: f, trace: f, up: false, link: undefined })}>
                {fnLabel(ix, f)}
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="sys-canvas-row">
      <div className={`sys-canvas${lay.dragging ? '' : ' anim'}`}>
        <ReactFlow
          nodes={lay.nodes}
          edges={routed}
          nodeTypes={NODE_TYPES}
          onNodesChange={lay.onNodesChange}
          onNodeDragStart={lay.onDragStart}
          onNodeDragStop={lay.onDragStop}
          onNodeClick={(e, n) => {
            if (n.id === 'engine') return;
            onAct(e.shiftKey ? 'add' : 'select', n.id);
          }}
          onNodeDoubleClick={(_, n) => n.id !== 'engine' && !model.focusCards.has(n.id) && onAct('focus', n.id)}
          onNodeContextMenu={(e, n) => {
            if (n.id === 'engine') return;
            e.preventDefault();
            setMenu({ unit: n.id, x: e.clientX, y: e.clientY });
          }}
          onEdgeClick={(_, e) => {
            const w = e.data?.wire as Wire | undefined;
            if (w) onNav({ link: { from: w.from, to: w.to, kind: w.kind }, pick: undefined, sel: undefined });
          }}
          onEdgeMouseEnter={(_, e) => setHoverEdge(e.id)}
          onEdgeMouseLeave={() => setHoverEdge(undefined)}
          onPaneClick={() => onNav({ sel: undefined, link: undefined })}
          minZoom={0.08}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        >
          <Background gap={20} size={1} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
        {canvas.rails.length > 0 && (
          <div className="sys-rails" aria-label="Rails: autoloads much of the game uses">
            {canvas.rails.map(r => (
              <button key={r.id} className={`sys-rail${p.hl && ix.fn.get(p.hl)?.cls === r.id ? ' hl' : ''}`} onClick={e => onAct(e.shiftKey ? 'add' : 'select', r.id)} onDoubleClick={() => onAct('focus', r.id)} title={`${ix.cls.get(r.id)?.name}: used by much of the game, so drawn as a rail. Each card says how much it uses it. Click to inspect, double-click to look at it.`}>
                <span className="rail-name">{ix.cls.get(r.id)?.name ?? r.id}</span>
                <span className="muted small">{r.taps}</span>
              </button>
            ))}
          </div>
        )}
      </div>
        {(
          <div className="sys-chips">
            {canvas.chips.length > 0 && <span className="muted small" title="Classes not drawn, by area: how many, and how many links reach them from what is">Not drawn (click to draw):</span>}
            {canvas.chips.map(c => (
              <button
                key={c.area}
                className={`sys-chip${routeChips.has(c.area) ? ' route' : ''}${p.lit && [...p.lit].some(x => canvas.where.get(x) === `chip:${c.area}`) ? ' peek' : ''}${p.hl && canvas.where.get(ix.fn.get(p.hl)?.cls ?? p.hl) === `chip:${c.area}` ? ' hl' : ''}`}
                onClick={() => onAct('expand', `chip:${c.area}`)}
                onDoubleClick={() => onAct('focus', `area:${c.area}`)}
                title={`${c.hidden} class${c.hidden === 1 ? '' : 'es'} not drawn, with ${c.links} links to what is${routeChips.has(c.area) ? '; the route from the engine passes through it' : ''}. Click to draw it, double-click to look at it.`}
              >
                {titles.get(c.area) ?? areaLabel(c.area)} <span className="muted">{c.hidden}</span>
                {c.links > 0 && <span className="muted"> · {c.links}↔</span>}
              </button>
            ))}
            <span className="sys-legend small" aria-label="Colours">
              <span><i className="lg new" />new</span>
              <span><i className="lg chg" />changed</span>
              <span><i className="lg gone" />removed</span>
              <span><i className="lg sel" />selected</span>
              <span><i className="lg lit" />hovered</span>
            </span>
            <span className="sys-hint muted small" title="Click to inspect · double-click to look at it · shift-click to add · right-click or ⋯ for more · drag a card's corner to resize it · Esc goes back">
              {model.dense ? 'Many lines: hover or click a function to see its own · ' : ''}double-click to look at a card · right-click or ⋯ for more · drag a corner to resize
            </span>
          </div>
        )}
      {menu && (
        <CardMenu
          x={menu.x} y={menu.y} title={unitName(menu.unit)}
          why={(() => {
            const u = model.units.get(menu.unit);
            return u ? why(u) : '';
          })()}
          items={menuItems(menu.unit)} onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );

  /** What a card's menu offers. */
  function menuItems(id: string): { label: string; hint?: string; run: () => void }[] {
    const u = model.units.get(id);
    if (!u) return [];
    const out: { label: string; hint?: string; run: () => void }[] = [];
    const looked = u.role === 'focus' || u.role === 'frame';
    if (u.role === 'open') out.push({ label: 'Close it', hint: 'back to one card', run: () => onAct('close', id) });
    if (looked) out.push({ label: 'Stop looking at it', hint: 'it goes back among the rest', run: () => onAct('unfocus', id) });
    else {
      out.push({ label: 'Look at it', hint: 'double-click', run: () => onAct('focus', id) });
      out.push({ label: 'Also look at it', hint: 'shift-click', run: () => onAct('add', id) });
    }
    const kids = childrenOf(ix, t, id).length;
    if (u.role === 'near' && kids > 1 && (isAreaId(id) || isGroupId(id))) out.push({ label: 'Open it here', hint: 'see inside; the view stays', run: () => onAct('open', id) });
    if (u.role === 'near' && kids > 1) out.push({ label: `Split into its ${kids} ${isAreaId(id) && t.groups.has(id.slice(5)) ? 'groups' : 'classes'}`, run: () => onAct('expand', id) });
    const parent = parentOf(ix, t, id);
    if (u.role === 'near' && parent && parent !== u.parent && !model.units.has(parent)) out.push({ label: `Fold into ${unitName(parent)}`, run: () => onAct('shrink', id) });
    if (!looked && !u.parent) out.push({ label: 'Hide it', hint: 'it joins the chips below', run: () => onAct('hide', id) });
    out.push({ label: 'Show in the panel', hint: 'click', run: () => onAct('select', id) });
    if ((model.more.get(id) ?? 0) > 0) out.push({ label: `Show all ${model.more.get(id)} more pins`, run: () => (setSize(id, undefined), setMoreOpen(s => new Set(s).add(id))) });
    if (sizes[id]) out.push({ label: 'Back to its own size', run: () => setSize(id, undefined) });
    return out;
  }
}

/** A card's menu: why it's there, and what can be done with it, in words. */
function CardMenu({ x, y, title, why, items, onClose }: { x: number; y: number; title: string; why: string; items: { label: string; hint?: string; run: () => void }[]; onClose: () => void }) {
  return (
    <div className="sys-menu" role="menu" style={{ left: Math.min(x, window.innerWidth - 280), top: Math.min(y, window.innerHeight - 40 - items.length * 30 - 60) }}>
      <div className="menu-head">
        <b>{title}</b>
        <div className="muted small">{why}</div>
      </div>
      {items.map(i => (
        <button key={i.label} role="menuitem" className="menu-item" onClick={() => (onClose(), i.run())}>
          <span>{i.label}</span>
          {i.hint && <span className="muted small">{i.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** What the person changed about the view, each undoable: cards split, folded, drawn from the chips, hidden. */
function Adjustments({ nav, name, onNav }: { nav: SystemsNav; name: (id: string) => string; onNav: (n: Partial<SystemsNav>) => void }) {
  const items: { key: 'open' | 'expand' | 'fold' | 'show' | 'hide'; id: string; label: string; title: string }[] = [
    ...(nav.open ?? []).map(id => ({ key: 'open' as const, id, label: `opened ${name(id)}`, title: 'You opened this card in place. × closes it.' })),
    ...(nav.expand ?? []).map(id => ({ key: 'expand' as const, id, label: `split ${name(id)}`, title: 'You split this card into what it holds. × puts it back together.' })),
    ...(nav.fold ?? []).map(id => ({ key: 'fold' as const, id, label: `folded into ${name(id)}`, title: 'You folded cards into this one. × lets them show on their own again.' })),
    ...(nav.show ?? []).map(id => ({ key: 'show' as const, id, label: `drew ${name(id)}`, title: 'You drew this from the chips. × puts it back among them.' })),
    ...(nav.hide ?? []).map(id => ({ key: 'hide' as const, id, label: `hid ${name(id)}`, title: 'You hid this card: its classes are in the chips below. × brings it back.' })),
  ];
  if (!items.length) return null;
  return (
    <div className="sys-adjust small">
      <span className="muted">You changed this view:</span>
      {items.map(i => (
        <span key={i.key + i.id} className="adjust-chip" title={i.title}>
          {i.label}
          <button className="x" onClick={() => onNav({ [i.key]: (nav[i.key] ?? []).filter(x => x !== i.id) })} aria-label={`Undo: ${i.label}`}>
            ×
          </button>
        </span>
      ))}
      <button className="text-link small" onClick={() => onNav({ open: [], expand: [], fold: [], show: [], hide: [] })}>
        Undo all
      </button>
    </div>
  );
}

/* ---------------- cards ---------------- */

function stop(e: ReactMouseEvent) {
  e.stopPropagation();
}

function CardButtons({ d }: { d: CardData }) {
  return (
    <span className="card-acts nodrag" onClick={stop} onDoubleClick={stop}>
      {d.role === 'focus' && (
        <button title="Stop looking at it" onClick={() => d.onAct('unfocus')}>
          ×
        </button>
      )}
      {d.opens && d.role === 'near' && (
        <button title="Open it here: see the cards inside it without changing what you look at" aria-label="Open it here" onClick={() => d.onAct('open')}>
          ▾
        </button>
      )}
      <button title="What you can do with it, and why it's here" aria-label="Card menu" onClick={e => d.onMenu(e)}>
        ⋯
      </button>
    </span>
  );
}

function Card({ data: d }: NodeProps<Node<CardData>>) {
  const cls = ['sys-node', d.role, d.kind, d.on && 'on', d.hl && 'hl', d.route && 'route', d.isNew ? 'added' : d.changed > 0 && 'changed', d.peek && `peek-${d.peek}`, d.w >= 320 && 'wide'].filter(Boolean).join(' ');
  return (
    <>
    <div className={cls} title={d.why}>
      <Handle type="target" position={Position.Left} id="i:*" style={{ top: headerY }} />
      <Handle type="source" position={Position.Right} id="o:*" style={{ top: headerY }} />
      <div className="node-head">
        <span className="node-title ellipsis">
          {d.kind === 'group' ? '▣ ' : d.kind === 'area' ? '▤ ' : d.kind === 'engine' ? '⏵ ' : ''}
          {d.title}
        </span>
        {d.isNew && <span className="pill done">new</span>}
        {d.changed > 0 && <span className="pill chg" title={d.kind === 'class' ? 'Functions added or edited in this scope' : 'Classes the scope changed'}>~{d.changed}</span>}
        {d.role !== 'engine' && <CardButtons d={d} />}
      </div>
      <div className="node-sub mono muted ellipsis">{d.sub}</div>
      {d.text && <div className="node-text">{d.text}</div>}
      {(d.badges.length > 0 || d.when.length > 0) && (
        <div className="node-chips">
          {d.badges.map(b => (
            <span key={b} className="area-chip">
              {b}
            </span>
          ))}
          {d.when.map(w => (
            <span key={w} className="area-chip when" title="The engine calls into it">
              ⏵ {w}
            </span>
          ))}
        </div>
      )}
      <div className="node-rows nodrag" onClick={stop}>
        {d.rows.map(r => (
          <div
            key={r.pin}
            className={`node-row${r.on ? ' on' : ''}${r.mark ? ` ${r.mark}` : ''}`}
            onClick={e => d.onRow(r.pin, e)}
            onMouseEnter={() => d.onRowHover(r.pin)}
            onMouseLeave={() => d.onRowHover(undefined)}
            title={d.role === 'focus' ? `${r.label}(): ${r.in ? `reached ${r.in}×` : ''}${r.in && r.out ? ', ' : ''}${r.out ? `reaches out ${r.out}×` : ''}. Click to trace it.` : `Links with ${r.label}: ${r.in} in, ${r.out} out. Click to look at this card too.`}
          >
            <Handle type="target" position={Position.Left} id={`i:${r.pin}`} className={r.in ? 'pin' : 'pin off'} />
            <span className="row-label ellipsis">
              {r.engine && <span className="row-engine" title={r.engine}>⏵</span>}
              {d.role === 'focus' ? <span className="mono">{r.label}()</span> : r.label}
              {d.w >= 320 && (r.from?.length || r.to?.length) ? (
                <span className="row-ends muted">
                  {r.from?.length ? ` ← ${r.from.join(', ')}` : ''}
                  {r.to?.length ? ` → ${r.to.join(', ')}` : ''}
                </span>
              ) : null}
            </span>
            {r.mark && <span className={`row-mark ${r.mark}`} title={r.mark === 'new' ? 'New in this scope' : 'Edited in this scope'} />}
            <span className="row-n muted">
              {r.in > 0 && `←${r.in}`} {r.out > 0 && `${r.out}→`}
            </span>
            <Handle type="source" position={Position.Right} id={`o:${r.pin}`} className={r.out ? 'pin' : 'pin off'} />
          </div>
        ))}
      </div>
      {(d.more > 0 || d.beyond > 0 || d.outside > 0 || d.taps.length > 0) && (
        <div className="node-foot nodrag" onClick={stop}>
          {d.more > 0 && (
            <button className="text-link small" onClick={d.onMore}>
              +{d.more} more
            </button>
          )}
          {d.outside > 0 && <span className="muted small" title="Links to what's outside the frame: drawn from the frame's edge">↔ {d.outside} outside</span>}
          {d.beyond > 0 && <span className="muted small" title="Links from it to classes not drawn (in the chips below)">{d.beyond} further out</span>}
          {d.taps.slice(0, 3).map(x => (
            <span key={x.name} className="tap small" title={`Uses ${x.name} (a rail) ${x.n} times`}>
              ┃{x.name} {x.n}
            </span>
          ))}
        </div>
      )}
    </div>
    {d.role !== 'engine' && (
      <NodeResizeControl position="bottom-right" minWidth={170} minHeight={80} className="card-resize" onResizeEnd={(_, r) => d.onResize(r.width, r.height)}>
        <span className="resize-grip" title="Drag to resize: taller shows more pins, wider shows what each links with" />
      </NodeResizeControl>
    )}
    </>
  );
}

function Frame({ data: d }: NodeProps<Node<FrameData>>) {
  return (
    <div className={`sys-frame${d.on ? ' on' : ''}${d.open ? ' open' : ''}`}>
      <Handle type="target" position={Position.Left} id="i:*" style={{ top: headerY }} />
      <Handle type="source" position={Position.Right} id="o:*" style={{ top: headerY }} />
      <Handle type="source" position={Position.Left} id="ol:*" style={{ top: headerY }} />
      <Handle type="target" position={Position.Right} id="ir:*" style={{ top: headerY }} />
      <div className="node-head">
        <span className="node-title ellipsis">{d.title}</span>
        {d.changed > 0 && <span className="pill chg">~{d.changed}</span>}
        <span className="muted small ellipsis">{d.sub}</span>
        <span className="card-acts nodrag" onClick={stop}>
          {d.open ? (
            <button title="Close it: back to one card" aria-label="Close it" onClick={() => d.onAct('close')}>
              ▴
            </button>
          ) : (
            <button title="Stop looking at it" onClick={() => d.onAct('unfocus')}>
              ×
            </button>
          )}
          <button title="What you can do with it" aria-label="Frame menu" onClick={e => d.onMenu(e)}>
            ⋯
          </button>
        </span>
      </div>
      {d.text && <div className="node-text">{d.text}</div>}
    </div>
  );
}

const NODE_TYPES = { card: Card, frame: Frame };

/* ---------------- layout ---------------- */

type Placed = { x: number; y: number; w?: number; h?: number };
type CardSpec = { id: string; parent?: string; frame?: FrameData; card?: CardData };

let elkP: Promise<{ layout: (g: ElkNode) => Promise<ElkNode> }> | undefined;
/** ELK, loaded the first time the canvas lays something out. */
function elk() {
  elkP ??= import('elkjs/lib/elk.bundled.js').then(m => new m.default());
  return elkP;
}

const layouts = new Map<string, Map<string, Placed>>();

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The graph ELK lays out: cards with a port per pin at its row's height, frames holding theirs. */
function elkGraph(cards: CardSpec[], edges: Edge[]): ElkNode {
  const kids = new Map<string, ElkNode[]>();
  const nodes = new Map<string, ElkNode>();
  for (const c of cards) {
    let n: ElkNode;
    if (c.frame) {
      n = {
        id: c.id, children: [],
        layoutOptions: { 'elk.padding': `[top=${c.frame.text ? 74 : 48},left=18,bottom=18,right=18]`, 'elk.portConstraints': 'FIXED_SIDE' },
        ports: [
          { id: `${c.id}|i:*`, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'WEST' } },
          { id: `${c.id}|o:*`, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'EAST' } },
        ],
      };
    } else {
      const d = c.card!;
      const ports = [
        { id: `${c.id}|i:*`, x: 0, y: headerY, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'WEST' } },
        { id: `${c.id}|o:*`, x: d.w, y: headerY, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'EAST' } },
        ...d.rows.flatMap((r, i) => [
          { id: `${c.id}|i:${r.pin}`, x: 0, y: rowY(d, i), width: 1, height: 1, layoutOptions: { 'elk.port.side': 'WEST' } },
          { id: `${c.id}|o:${r.pin}`, x: d.w, y: rowY(d, i), width: 1, height: 1, layoutOptions: { 'elk.port.side': 'EAST' } },
        ]),
      ];
      n = { id: c.id, width: d.w, height: d.h, ports, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' } };
    }
    nodes.set(c.id, n);
    const list = kids.get(c.parent ?? '') ?? [];
    list.push(n);
    kids.set(c.parent ?? '', list);
  }
  for (const [p, list] of kids) if (p && nodes.has(p)) nodes.get(p)!.children = list;
  const ports = new Set([...nodes.values()].flatMap(n => (n.ports ?? []).map(x => x.id)));
  const elkEdges: ElkExtendedEdge[] = edges
    .map(e => ({ id: e.id, sources: [`${e.source}|${e.sourceHandle}`], targets: [`${e.target}|${e.targetHandle}`] }))
    .filter(e => ports.has(e.sources[0]) && ports.has(e.targets[0]));
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '26',
      'elk.spacing.componentComponent': '50',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: kids.get('') ?? [],
    edges: elkEdges,
  };
}

function flatten(n: ElkNode, out: Map<string, Placed>) {
  for (const c of n.children ?? []) {
    out.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width, h: c.height });
    flatten(c, out);
  }
}

function loadMoved(key: string): Record<string, Record<string, Placed>> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Positions from ELK for this set of cards (kept per set, so going back is instant), with the
 * cards a person dragged left where they were, per goal and set, in the browser.
 */
function useElkLayout(goal: string, cards: CardSpec[], edges: Edge[]) {
  // The layout depends on which cards, their sizes and pins, and which pins are joined.
  const shape = useMemo(
    () => hash(JSON.stringify([cards.map(c => [c.id, c.parent, c.frame ? !!c.frame.text : [c.card!.w, c.card!.h, c.card!.rows.map(r => r.pin)]]), edges.map(e => `${e.source}|${e.sourceHandle}>${e.target}|${e.targetHandle}`).sort()])),
    [cards, edges],
  );
  // What the set is, without which pins are drawn: dragged places are kept per set.
  const set = useMemo(() => hash(cards.map(c => c.id).sort().join('\n')), [cards]);
  const key = `mh.systems.canvas.${goal}`;
  const [pos, setPos] = useState<{ shape: string; at: Map<string, Placed> } | undefined>(() => (layouts.has(shape) ? { shape, at: layouts.get(shape)! } : undefined));
  const [fresh, setFresh] = useState(0);
  const moved = useRef<Record<string, Record<string, Placed>>>(loadMoved(key));
  const [dragging, setDragging] = useState(false);
  const [rf, setRf] = useState<Node[]>([]);
  const lastSet = useRef<string>('');
  useEffect(() => {
    let alive = true;
    const have = layouts.get(shape);
    if (have) {
      setPos({ shape, at: have });
      return;
    }
    elk()
      .then(e => e.layout(elkGraph(cards, edges)))
      .then(res => {
        const at = new Map<string, Placed>();
        flatten(res, at);
        layouts.set(shape, at);
        if (layouts.size > 60) layouts.delete(layouts.keys().next().value!);
        if (alive) setPos({ shape, at });
      })
      .catch(err => console.error('Systems layout', err));
    return () => {
      alive = false;
    };
  }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pos) return;
    const mine = moved.current[set] ?? {};
    const nodes: Node[] = [];
    for (const c of cards) {
      const at = mine[c.id] ?? pos.at.get(c.id);
      if (!at) continue;
      const base = { id: c.id, position: { x: at.x, y: at.y }, ...(c.parent && pos.at.has(c.parent) ? { parentId: c.parent } : {}) };
      if (c.frame) {
        const box = pos.at.get(c.id)!;
        nodes.push({ ...base, type: 'frame', data: c.frame, style: { width: box.w, height: box.h }, zIndex: -1, selectable: false });
      } else nodes.push({ ...base, type: 'card', data: c.card!, style: { width: c.card!.w, height: c.card!.h } });
    }
    // Frames before what they hold, as React Flow wants (frames can sit in frames).
    const parentOf = new Map(nodes.map(n => [n.id, n.parentId]));
    const depth = (id: string) => {
      let d = 0;
      for (let p = parentOf.get(id); p; p = parentOf.get(p)) d++;
      return d;
    };
    nodes.sort((a, b) => depth(a.id) - depth(b.id));
    setRf(old => {
      const prev = new Map(old.map(n => [n.id, n]));
      return nodes.map(n => {
        const o = prev.get(n.id);
        return o?.measured ? { ...n, measured: o.measured } : n;
      });
    });
    if (lastSet.current !== set) {
      lastSet.current = set;
      setFresh(f => f + 1);
    }
  }, [pos, cards, set]);
  const save = () => {
    try {
      const all = moved.current;
      const keys = Object.keys(all);
      if (keys.length > 40) delete all[keys[0]];
      localStorage.setItem(key, JSON.stringify(all));
    } catch {
      // Kept for this visit only.
    }
  };
  return {
    nodes: rf,
    fresh,
    dragging,
    moved: Object.keys(moved.current[set] ?? {}).length > 0,
    onNodesChange: (chs: NodeChange[]) => {
      for (const c of chs) if (c.type === 'position' && c.position) moved.current[set] = { ...(moved.current[set] ?? {}), [c.id]: c.position };
      setRf(ns => applyNodeChanges(chs, ns));
    },
    onDragStart: () => setDragging(true),
    onDragStop: () => (setDragging(false), save()),
    reset: () => {
      delete moved.current[set];
      save();
      setPos(p => (p ? { ...p } : p));
    },
  };
}

/** Whether a unit can be split, for the inspector's buttons. */
export const splits = (ix: CodeIndex, t: Tree, id: string) => childrenOf(ix, t, id).length > 1;
export const folds = (ix: CodeIndex, t: Tree, id: string) => !!parentOf(ix, t, id);
