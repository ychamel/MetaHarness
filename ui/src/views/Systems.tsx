import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyNodeChanges, Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.ts';
import type { CodeEdge, CodeGraph, DesignScopeView, DesignSnapshot, Goal } from '../types.ts';
import {
  between, classLinks, codeChange, depthRows, edgeKey, edgeSentence, engineWhen, fnLabel, indexGraph, searchCode, stacksTo, stateOf, stepsDown, stepsUp, visibleLinks,
  type CodeChange, type CodeIndex, type Link, type LinkKind, type Meeting, type Step, type Touch,
} from '../codeData.ts';
import { areaLabel } from '../designData.ts';
import { Splitter } from '../components/Splitter.tsx';

/** Where the Systems lens is: its tool, the areas opened into classes, what's isolated, selected, traced, and the two systems compared. */
export interface SystemsNav {
  tool?: 'map' | 'trace' | 'between';
  open?: string[];
  isolate?: string[];
  sel?: string;
  trace?: string;
  up?: boolean;
  a?: string;
  b?: string;
  /** A connection on the map opened on its own (nodes as on the map: a class or area:<path>), and the pair of classes picked in it. */
  link?: { from: string; to: string; kind: LinkKind };
  pick?: string;
  /** A connection picked in Between: `<a|b>|<kind>|<middle class>` or `<ab|ba>|<kind>`. */
  bpick?: string;
}

interface Props {
  goal: Goal;
  view: DesignScopeView;
  snap: DesignSnapshot;
  nav: SystemsNav;
  onNav: (n: SystemsNav) => void;
  /** The lens switch, drawn first in the toolbar. */
  lens: ReactNode;
}

const graphs = new Map<string, Promise<CodeGraph>>();

/** The code graph at a commit or tree, fetched once. */
function useGraph(goal: string, rev: string | undefined): { g?: CodeGraph; error?: string } {
  const [s, setS] = useState<{ g?: CodeGraph; error?: string; rev?: string }>({});
  useEffect(() => {
    if (!rev) return;
    let alive = true;
    const k = `${goal}\n${rev}`;
    let p = graphs.get(k);
    if (!p) {
      p = api.designCode(goal, rev).then(r => r.graph);
      p.catch(() => graphs.delete(k));
      graphs.set(k, p);
    }
    p.then(
      g => alive && setS({ g, rev }),
      e => alive && setS({ error: (e as Error).message, rev }),
    );
    return () => {
      alive = false;
    };
  }, [goal, rev]);
  return s.rev === rev ? s : {};
}

const sources = new Map<string, Promise<string>>();

function useSource(goal: string, rev: string | undefined, path: string | undefined): string | undefined | null {
  const [t, setT] = useState<{ k: string; text: string | null }>();
  const k = `${goal}\n${rev}\n${path}`;
  useEffect(() => {
    if (!rev || !path) return;
    let alive = true;
    let p = sources.get(k);
    if (!p) {
      p = api.designSource(goal, rev, path).then(r => r.text);
      p.catch(() => sources.delete(k));
      sources.set(k, p);
    }
    p.then(
      text => alive && setT({ k, text }),
      () => alive && setT({ k, text: null }),
    );
    return () => {
      alive = false;
    };
  }, [goal, rev, path, k]);
  return t?.k === k ? t.text : undefined;
}

type Kinds = Record<'call' | 'signal' | 'new' | 'state', boolean>;
const KIND_KEY = 'mh.systems.kinds';
const DEFAULT_KINDS: Kinds = { call: true, signal: true, new: true, state: false };
const KINDS: [keyof Kinds, string, string][] = [
  ['call', 'Calls', 'A function calling one in another class'],
  ['signal', 'Signals', 'A signal emitted in one class and handled in another (the bus between them left out)'],
  ['new', 'Creates', 'One class making objects of another'],
  ['state', 'State', "Reading or writing another class's variables and constants"],
];

function useKinds(): [Kinds, (k: keyof Kinds, v: boolean) => void] {
  const [k, setK] = useState<Kinds>(() => {
    try {
      return { ...DEFAULT_KINDS, ...JSON.parse(localStorage.getItem(KIND_KEY) ?? '{}') };
    } catch {
      return DEFAULT_KINDS;
    }
  });
  const set = (key: keyof Kinds, v: boolean) =>
    setK(o => {
      const n = { ...o, [key]: v };
      try {
        localStorage.setItem(KIND_KEY, JSON.stringify(n));
      } catch {
        // Kept for this visit only.
      }
      return n;
    });
  return [k, set];
}

const linkKinds = (k: Kinds) => new Set<LinkKind>([...(k.call ? ['call' as const] : []), ...(k.signal ? ['signal' as const] : []), ...(k.new ? ['new' as const] : []), ...(k.state ? ['read' as const, 'write' as const] : [])]);

const KIND_STYLE: Record<LinkKind | 'engine', { stroke: string; dash?: string; word: string }> = {
  call: { stroke: 'var(--text-2)', word: 'calls' },
  signal: { stroke: 'var(--paused)', dash: '6 4', word: 'signals' },
  new: { stroke: 'var(--done)', word: 'creates' },
  read: { stroke: 'var(--waiting)', dash: '2 4', word: 'reads' },
  write: { stroke: 'var(--limited)', dash: '6 3', word: 'writes' },
  engine: { stroke: 'var(--accent)', word: 'runs' },
};

/** An id for an area's node, apart from class ids. */
const areaNode = (a: string) => `area:${a}`;
const isArea = (id: string) => id.startsWith('area:');

/**
 * The Systems lens of the Design view (design §14): how the code runs. The map starts at the
 * engine (the main scene, the autoloads, the callbacks it calls) and shows how areas, or the
 * classes of an opened area, call, signal, create and touch each other's state. Trace follows a
 * function step by step in the order its lines run, down into what it does or up to how the
 * engine reaches it. Between puts two systems side by side with what joins them.
 */
export default function Systems({ goal, view, snap, nav, onNav, lens }: Props) {
  const tool = nav.tool ?? 'map';
  const [kinds, setKind] = useKinds();
  const [showChange, setShowChange] = useState(true);
  const after = useGraph(goal.id, view.scope?.to);
  const before = useGraph(goal.id, showChange && view.scope ? view.scope.from : undefined);
  const ix = useMemo(() => (after.g ? indexGraph(after.g) : undefined), [after.g]);
  const bix = useMemo(() => (before.g ? indexGraph(before.g) : undefined), [before.g]);
  const links = useMemo(() => (ix ? classLinks(ix) : []), [ix]);
  const chg = useMemo(() => (ix && showChange && bix ? codeChange(bix, ix, view.change) : undefined), [ix, bix, showChange, view.change]);
  const set = (n: Partial<SystemsNav>) => onNav({ ...nav, ...n });

  const toolbar = (
    <div className="toolbar design-toolbar">
      {lens}
      <div className="seg" role="group" aria-label="Tool">
        {(
          [
            ['map', 'Map', 'How the systems connect, from the engine down'],
            ['trace', 'Trace', 'Follow one function: what it does, step by step, or how the engine gets to it'],
            ['between', 'Between', 'Two systems side by side, and what joins them'],
          ] as const
        ).map(([t, label, title]) => (
          <button key={t} className={`btn small${tool === t ? ' on' : ''}`} onClick={() => set({ tool: t })} title={title}>
            {label}
          </button>
        ))}
      </div>
      {ix && <Search ix={ix} onPick={(id, kind) => (kind === 'class' ? set({ tool: 'map', sel: id, open: [...new Set([...(nav.open ?? []), ix.cls.get(id)!.area])] }) : set({ tool: 'trace', trace: id, sel: id }))} />}
      {tool === 'map' && (
        <div className="layer-toggles" role="group" aria-label="Links">
          {KINDS.map(([k, label, title]) => (
            <label key={k} className={`layer-toggle${kinds[k] ? ' on' : ''}`} title={title}>
              <input type="checkbox" checked={kinds[k]} onChange={e => setKind(k, e.target.checked)} />
              <span className="kind-mark" style={{ borderColor: KIND_STYLE[k === 'state' ? 'write' : k].stroke, borderStyle: k === 'call' || k === 'new' ? 'solid' : 'dashed' }} />
              {label}
            </label>
          ))}
        </div>
      )}
      <label className={`layer-toggle${showChange ? ' on' : ''}`} title="Mark what this scope added, changed or removed in how the code runs">
        <input type="checkbox" checked={showChange} onChange={e => setShowChange(e.target.checked)} />
        Changes in this scope
      </label>
      {ix && <Coverage ix={ix} />}
    </div>
  );

  if (after.error) return withToolbar(toolbar, <div className="empty warn-text">{after.error}</div>);
  if (!ix) return withToolbar(toolbar, <div className="empty">Reading how the code runs…</div>);
  if (!ix.g.classes.length) {
    return withToolbar(toolbar, <div className="empty">No code here that MetaHarness can follow yet. The Systems lens reads GDScript for now (a language pack with a code reader); the Areas lens still shows every file.</div>);
  }
  const titles = new Map(snap.map.areas.map(a => [a.path, a.title]));
  const sel = nav.sel;
  return (
    <>
      {toolbar}
      <div className="design-body">
        <div className="view">
          {tool === 'map' && <MapView goal={goal.id} ix={ix} links={links} kinds={linkKinds(kinds)} nav={nav} chg={chg} titles={titles} onNav={set} />}
          {tool === 'trace' && <TraceView ix={ix} bix={bix} chg={chg} root={nav.trace} up={!!nav.up} sel={sel} onNav={set} />}
          {tool === 'between' && <BetweenView goal={goal.id} ix={ix} links={links} a={nav.a} b={nav.b} bpick={nav.bpick} titles={titles} onNav={set} />}
        </div>
        <Splitter pane="design-side" grow="left" min={280} max={820} label="Systems panel" />
        <aside className="design-side">
          <div className="area-panel scroll">
            {sel && ix.fn.has(sel) ? (
              <FnPanel goal={goal} rev={view.scope?.to} ix={ix} chg={chg} id={sel} onNav={set} tool={tool} />
            ) : sel && ix.cls.has(sel) ? (
              <ClassPanel ix={ix} links={links} chg={chg} id={sel} nav={nav} onNav={set} />
            ) : sel && ix.sig.has(sel) ? (
              <SignalPanel ix={ix} id={sel} onNav={set} />
            ) : sel && isArea(sel) ? (
              <AreaInfo ix={ix} snap={snap} area={sel.slice(5)} nav={nav} chg={chg} onNav={set} />
            ) : tool === 'map' && nav.link ? (
              <LinkPanel ix={ix} links={links} link={nav.link} pick={nav.pick} titles={titles} onNav={set} />
            ) : tool === 'between' ? (
              <BetweenPanel ix={ix} links={links} a={nav.a} b={nav.b} bpick={nav.bpick} titles={titles} onNav={set} />
            ) : (
              <StartPanel ix={ix} bix={bix} chg={chg} view={view} onNav={set} />
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function withToolbar(toolbar: ReactNode, body: ReactNode) {
  return (
    <>
      {toolbar}
      {body}
    </>
  );
}

function Coverage({ ix }: { ix: CodeIndex }) {
  const s = ix.g.stats;
  const pct = s.calls ? Math.round(((s.resolved + s.guessed) / s.calls) * 100) : 100;
  return (
    <span className="muted small nowrap" title={`${s.resolved} calls followed by their declared types, ${s.guessed} by name only, ${s.unresolved} not followed (their receiver has no type). ${s.files} files read; tests left out.`}>
      {pct}% of {s.calls} calls followed
    </span>
  );
}

function Search({ ix, onPick }: { ix: CodeIndex; onPick: (id: string, kind: 'class' | 'function' | 'signal') => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => searchCode(ix, q, 14), [ix, q]);
  return (
    <div className="sys-search">
      <input
        type="search" className="small" placeholder="Find a class, function or signal…" value={q} aria-label="Find in the code"
        onChange={e => (setQ(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (e.key === 'Enter' && hits[0]) (onPick(hits[0].id, hits[0].kind), setQ(''), setOpen(false));
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && hits.length > 0 && (
        <div className="sys-hits" role="listbox">
          {hits.map(h => (
            <button key={h.kind + h.id} className="def-row" role="option" aria-selected={false} onMouseDown={() => (onPick(h.id, h.kind), setQ(''), setOpen(false))}>
              <span className="sym-kind">{h.kind}</span>
              <span className="mono ellipsis">{h.label}</span>
              <span className="muted small ellipsis def-file">{h.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- the map ---------------- */

type SysData = {
  id: string;
  title: string;
  sub: string;
  kind: 'engine' | 'area' | 'class';
  badges: string[];
  when: string[];
  count: string;
  changed: number;
  isNew: boolean;
  on: boolean;
  faded: boolean;
  isolated: boolean;
};

const NW = 210;
const NH = 96;

function MapView({ goal, ix, links, kinds, nav, chg, titles, onNav }: { goal: string; ix: CodeIndex; links: Link[]; kinds: Set<LinkKind>; nav: SystemsNav; chg?: CodeChange; titles: Map<string, string>; onNav: (n: Partial<SystemsNav>) => void }) {
  const computed = useMemo(() => {
    const open = new Set(nav.open ?? []);
    const nodeOf = (cls: string) => {
      const c = ix.cls.get(cls);
      return c ? (open.has(c.area) ? cls : areaNode(c.area)) : undefined;
    };
    const all = [...ix.classesOf.keys()].flatMap(a => (open.has(a) ? ix.classesOf.get(a)!.map(c => c.id) : [areaNode(a)]));
    const vis = visibleLinks(links, nodeOf, kinds);
    // The engine runs the main scene, the autoloads, and every callback it calls.
    const runs = new Map<string, string[]>();
    for (const id of ix.entries) {
      const f = ix.fn.get(id)!;
      const n = nodeOf(f.cls);
      if (n) runs.set(n, [...new Set([...(runs.get(n) ?? []), f.name])]);
    }
    const iso = new Set(nav.isolate ?? []);
    const mapped = new Set([...iso].map(i => (isArea(i) || !ix.cls.has(i) ? i : nodeOf(i)!)));
    let shown = all;
    if (mapped.size) {
      const near = new Set(mapped);
      for (const l of vis) {
        if (mapped.has(l.from)) near.add(l.to);
        if (mapped.has(l.to)) near.add(l.from);
      }
      shown = all.filter(n => near.has(n));
    }
    const shownSet = new Set(shown);
    const engineOn = !mapped.size || ix.g.classes.some(c => (c.main || c.kind === 'autoload') && mapped.has(nodeOf(c.id)!));
    // The engine starts the main scene and the autoloads; what they make and call hangs below them.
    const roots = new Set(ix.g.classes.filter(c => c.main || c.kind === 'autoload').map(c => nodeOf(c.id)!));
    const engineLinks = engineOn ? [...roots].filter(n => shownSet.has(n)).map(n => ({ from: 'engine', to: n, kind: 'call' as const })) : [];
    const rows = depthRows([...(engineOn ? ['engine'] : []), ...shown], [...vis, ...engineLinks], engineOn ? ['engine'] : shown.filter(n => mapped.has(n)), Math.max(3, Math.ceil(Math.sqrt(shown.length * 1.5))));
    const pos = new Map<string, { x: number; y: number }>();
    const widest = Math.max(...rows.map(r => r.length));
    rows.forEach((row, ri) => row.forEach((n, i) => pos.set(n, { x: (i + (widest - row.length) / 2) * (NW + 50), y: ri * (NH + 80) })));
    const sel = nav.sel && (ix.cls.has(nav.sel) ? nodeOf(nav.sel) : nav.sel);
    const near = new Set<string>(sel ? [sel] : []);
    if (sel) for (const l of vis) (l.from === sel && near.add(l.to), l.to === sel && near.add(l.from));
    const added = new Set(chg?.added.map(edgeKey));
    const nodes: Node<SysData>[] = [...(engineOn ? ['engine'] : []), ...shown].map(id => {
      const base = { id, on: sel === id, faded: !!sel && !near.has(id), isolated: mapped.has(id) };
      if (id === 'engine') {
        return { id, type: 'sys', position: pos.get(id)!, data: { ...base, title: 'Engine', sub: 'starts the main scene and the autoloads', kind: 'engine', badges: [], when: [], count: '', changed: 0, isNew: false } };
      }
      if (isArea(id)) {
        const a = id.slice(5);
        const cs = ix.classesOf.get(a) ?? [];
        const changed = cs.filter(c => chg?.touched.has(c.id)).length;
        return {
          id, type: 'sys', position: pos.get(id)!,
          data: {
            ...base, title: titles.get(a) ?? areaLabel(a), sub: a || '(top level)', kind: 'area', badges: cs.some(c => c.main) ? ['main scene'] : cs.some(c => c.kind === 'autoload') ? ['autoload'] : [],
            when: [...new Set((runs.get(id) ?? []).map(engineWhen))].slice(0, 3), count: `${cs.length} class${cs.length === 1 ? '' : 'es'} · ${cs.reduce((n, c) => n + (ix.fnsOf.get(c.id)?.length ?? 0), 0)} functions`, changed, isNew: false,
          },
        };
      }
      const c = ix.cls.get(id)!;
      const fns = ix.fnsOf.get(id) ?? [];
      return {
        id, type: 'sys', position: pos.get(id)!,
        data: {
          ...base, title: c.name, sub: c.file, kind: 'class',
          badges: [...(c.main ? ['main scene'] : []), ...(c.kind === 'autoload' ? ['autoload'] : []), ...(c.base && c.base !== 'RefCounted' ? [c.base] : [])],
          when: [...new Set((runs.get(id) ?? []).map(engineWhen))].slice(0, 3), count: `${fns.length} function${fns.length === 1 ? '' : 's'}`,
          changed: fns.filter(f => chg?.edited.has(f.id) || chg?.newFns.has(f.id)).length, isNew: !!chg?.newClasses.has(id),
        },
      };
    });
    const few = vis.filter(l => shownSet.has(l.from) && shownSet.has(l.to)).length < 30;
    const edges: Edge[] = [];
    for (const l of engineLinks) {
      const st = KIND_STYLE.engine;
      edges.push({ id: `engine->${l.to}`, source: 'engine', target: l.to, data: { auto: true }, ...handles(pos.get('engine')!, pos.get(l.to)!), style: { stroke: st.stroke, strokeWidth: 1.5, opacity: sel && !near.has(l.to) ? 0.15 : 0.7 }, markerEnd: { type: MarkerType.ArrowClosed, color: st.stroke } });
    }
    for (const l of vis) {
      if (!shownSet.has(l.from) || !shownSet.has(l.to)) continue;
      const st = KIND_STYLE[l.kind];
      const on = !!sel && (l.from === sel || l.to === sel);
      const isNew = l.links.some(x => x.edges.some(e => added.has(edgeKey(e))));
      const label = on || few || isNew ? `${isNew ? 'new · ' : ''}${l.kind === 'signal' ? '⚡ ' + l.names.slice(0, 2).join(', ') + (l.names.length > 2 ? '…' : '') : `${st.word} ${l.n}`}` : undefined;
      edges.push({
        id: `${l.kind}:${l.from}->${l.to}`, source: l.from, target: l.to, ...handles(pos.get(l.from)!, pos.get(l.to)!), data: { auto: true, link: { from: l.from, to: l.to, kind: l.kind } },
        interactionWidth: 16, label, labelStyle: { fill: isNew ? 'var(--accent)' : st.stroke, fontSize: 11 }, labelBgStyle: { fill: 'var(--panel)' },
        style: { stroke: isNew ? 'var(--accent)' : st.stroke, strokeDasharray: st.dash, strokeWidth: on || isNew ? 2.25 : 1.25, opacity: sel && !on ? 0.12 : 0.85 },
        markerEnd: { type: MarkerType.ArrowClosed, color: isNew ? 'var(--accent)' : st.stroke },
      });
    }
    return { nodes, edges };
  }, [ix, links, kinds, nav.open, nav.isolate, nav.sel, chg, titles]);
  const lay = useLayout(`mh.systems.layout.${goal}.map`, computed.nodes, computed.edges);

  if (nav.link) return <LinkView goal={goal} ix={ix} links={links} link={nav.link} pick={nav.pick} sel={nav.sel} chg={chg} titles={titles} onNav={onNav} />;
  const toggle = (id: string) => {
    if (!isArea(id)) return;
    const a = id.slice(5);
    const open = new Set(nav.open ?? []);
    if (open.has(a)) open.delete(a);
    else open.add(a);
    onNav({ open: [...open], sel: id });
  };
  return (
    <div className="sys-map">
      {!!nav.isolate?.length && (
        <div className="sys-banner">
          Isolated: {nav.isolate.map(i => (isArea(i) ? areaLabel(i.slice(5)) : ix.cls.get(i)?.name ?? i)).join(', ')} and what it's linked to.
          <button className="btn ghost small" onClick={() => onNav({ isolate: [] })}>
            Show everything
          </button>
        </div>
      )}
      {lay.moved && (
        <button className="btn ghost small sys-reset" onClick={lay.reset} title="Put every card back where the layout puts it">
          Reset layout
        </button>
      )}
      <ReactFlow
        nodes={lay.nodes}
        edges={lay.edges}
        nodeTypes={SYS_TYPES}
        onNodesChange={lay.onNodesChange}
        onNodeDragStop={lay.onNodeDragStop}
        onNodeClick={(_, n) => onNav({ sel: n.id === 'engine' ? undefined : n.id })}
        onNodeDoubleClick={(_, n) => (isArea(n.id) ? toggle(n.id) : ix.cls.has(n.id) && onNav({ isolate: [n.id], sel: n.id }))}
        onEdgeClick={(_, e) => e.data?.link && onNav({ link: e.data.link as SystemsNav['link'], pick: undefined, sel: undefined })}
        onPaneClick={() => onNav({ sel: undefined })}
        fitView
        fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
      >
        <Background gap={20} size={1} color="var(--line)" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="sys-hint muted small">Click to inspect · drag to move · double-click an area to open it, a class to isolate it · click a connection to open it</div>
    </div>
  );
}

function SysCard({ data: d }: NodeProps<Node<SysData>>) {
  const cls = ['sys-card', d.kind, d.on && 'on', d.faded && 'faded', d.isolated && 'isolated', d.isNew && 'added'].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Top} id="u" />
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Left} id="fl" />
      <div className="area-head">
        <span className="area-title ellipsis">{d.kind === 'area' ? '▸ ' : ''}{d.title}</span>
        {d.isNew && <span className="pill done">new</span>}
        {d.changed > 0 && <span className="pill decision" title="Functions added or edited in this scope">~{d.changed}</span>}
      </div>
      <div className="mono muted small ellipsis">{d.sub}</div>
      {(d.badges.length > 0 || d.when.length > 0) && (
        <div className="area-chips">
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
      {d.count && <div className="muted small">{d.count}</div>}
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="target" position={Position.Bottom} id="d" />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="target" position={Position.Right} id="fr" />
    </div>
  );
}

const SYS_TYPES = { sys: SysCard };

function handles(a: { x: number; y: number }, b: { x: number; y: number }): { sourceHandle: string; targetHandle: string } {
  if (b.y > a.y) return { sourceHandle: 'b', targetHandle: 't' };
  if (b.y < a.y) return { sourceHandle: 'u', targetHandle: 'd' };
  return b.x > a.x ? { sourceHandle: 'r', targetHandle: 'l' } : { sourceHandle: 'fl', targetHandle: 'fr' };
}

/* ---------------- one connection ---------------- */

/** A connection of the map on its own: the classes on each side and each pair's link, the rest left out. */
function LinkView({ goal, ix, links, link, pick, sel, chg, titles, onNav }: {
  goal: string;
  ix: CodeIndex;
  links: Link[];
  link: NonNullable<SystemsNav['link']>;
  pick?: string;
  sel?: string;
  chg?: CodeChange;
  titles: Map<string, string>;
  onNav: (n: Partial<SystemsNav>) => void;
}) {
  const ls = useMemo(() => linksOf(ix, links, link), [ix, links, link]);
  const computed = useMemo(() => {
    const left = [...new Set(ls.map(l => l.from))].sort((a, b) => (ix.cls.get(a)?.name ?? a).localeCompare(ix.cls.get(b)?.name ?? b));
    const right = [...new Set(ls.map(l => l.to))].sort((a, b) => (ix.cls.get(a)?.name ?? a).localeCompare(ix.cls.get(b)?.name ?? b));
    const added = new Set(chg?.added.map(edgeKey));
    const card = (id: string, side: 'L' | 'R', i: number, n: number, other: number): Node<SysData> => {
      const c = ix.cls.get(id)!;
      const k = ls.filter(l => (side === 'L' ? l.from : l.to) === id).reduce((s, l) => s + l.edges.length, 0);
      return {
        id: `${side}:${id}`, type: 'sys', position: { x: side === 'L' ? 0 : 560, y: (i + Math.max(0, other - n) / 2) * (NH - 6) },
        data: { id, title: c.name, sub: c.file, kind: 'class', badges: [], when: [], count: `${k} ${KIND_STYLE[link.kind].word}`, changed: 0, isNew: !!chg?.newClasses.has(id), on: sel === id, faded: false, isolated: false },
      };
    };
    const nodes = [...left.map((id, i) => card(id, 'L', i, left.length, right.length)), ...right.map((id, i) => card(id, 'R', i, right.length, left.length))];
    const st = KIND_STYLE[link.kind];
    const edges: Edge[] = ls.map(l => {
      const k = `${l.from}\n${l.to}`;
      const on = pick === k;
      const isNew = l.edges.some(e => added.has(edgeKey(e)));
      const names = [...l.names];
      return {
        id: `${l.from}->${l.to}`, source: `L:${l.from}`, target: `R:${l.to}`, sourceHandle: 'r', targetHandle: 'l', data: { auto: true, pick: k }, interactionWidth: 16,
        label: `${isNew ? 'new · ' : ''}${link.kind === 'signal' ? '⚡ ' : ''}${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`,
        labelStyle: { fill: isNew ? 'var(--accent)' : st.stroke, fontSize: 11, fontWeight: on ? 700 : 400 }, labelBgStyle: { fill: 'var(--panel)' },
        style: { stroke: isNew ? 'var(--accent)' : st.stroke, strokeDasharray: st.dash, strokeWidth: on ? 3 : 1.5, opacity: pick && !on ? 0.2 : 0.9 },
        markerEnd: { type: MarkerType.ArrowClosed, color: isNew ? 'var(--accent)' : st.stroke },
      };
    });
    return { nodes, edges };
  }, [ix, ls, link, pick, sel, chg]);
  const lay = useLayout(`mh.systems.layout.${goal}.link`, computed.nodes, computed.edges);
  return (
    <div className="sys-map">
      <div className="sys-banner">
        <button className="btn ghost small" onClick={() => onNav({ link: undefined, pick: undefined, sel: undefined })}>
          ← The map
        </button>
        <span>
          <b>{nodeName(ix, link.from, titles)}</b> {KIND_STYLE[link.kind].word} <b>{nodeName(ix, link.to, titles)}</b>
        </span>
        <span className="muted small">
          {ls.length} pair{ls.length === 1 ? '' : 's'} of classes · {ls.reduce((s, l) => s + l.edges.length, 0)} {link.kind === 'signal' ? 'emits and handlers' : 'places in the code'}
        </span>
        {lay.moved && (
          <button className="btn ghost small" onClick={lay.reset}>
            Reset layout
          </button>
        )}
      </div>
      {!ls.length ? (
        <div className="empty">Nothing joins them this way any more.</div>
      ) : (
        <ReactFlow
          nodes={lay.nodes}
          edges={lay.edges}
          nodeTypes={SYS_TYPES}
          onNodesChange={lay.onNodesChange}
          onNodeDragStop={lay.onNodeDragStop}
          onNodeClick={(_, n) => onNav({ sel: n.data.id })}
          onEdgeClick={(_, e) => onNav({ pick: pick === e.data?.pick ? undefined : (e.data?.pick as string), sel: undefined })}
          onPaneClick={() => onNav({ sel: undefined, pick: undefined })}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
        >
          <Background gap={20} size={1} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
    </div>
  );
}

/** The inspector for a connection: every place in the code behind it, by pair of classes. */
function LinkPanel({ ix, links, link, pick, titles, onNav }: { ix: CodeIndex; links: Link[]; link: NonNullable<SystemsNav['link']>; pick?: string; titles: Map<string, string>; onNav: (n: Partial<SystemsNav>) => void }) {
  const ls = linksOf(ix, links, link)
    .filter(l => !pick || `${l.from}\n${l.to}` === pick)
    .sort((a, b) => b.edges.length - a.edges.length);
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">Connection</div>
          <b>
            {nodeName(ix, link.from, titles)} {KIND_STYLE[link.kind].word} {nodeName(ix, link.to, titles)}
          </b>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ link: undefined, pick: undefined })} aria-label="Back to the map">
          ✕
        </button>
      </div>
      <p className="area-text small">
        {pick ? 'One pair of classes. ' : 'Each pair of classes, and every place in the code behind it. '}Click a line to trace the function it's in; click an arrow on the left to keep to that pair.
      </p>
      {pick && (
        <button className="text-link small" onClick={() => onNav({ pick: undefined })}>
          Show every pair
        </button>
      )}
      {ls.map(l => (
        <div key={l.from + l.to}>
          <div className="section-title">
            <button className="text-link" onClick={() => onNav({ sel: l.from })}>
              {ix.cls.get(l.from)?.name}
            </button>{' '}
            → <button className="text-link" onClick={() => onNav({ sel: l.to })}>
              {ix.cls.get(l.to)?.name}
            </button>{' '}
            <span className="muted">{l.edges.length}</span>
          </div>
          <EdgeList ix={ix} edges={l.edges} onNav={onNav} />
        </div>
      ))}
    </>
  );
}

/* ---------------- dragging ---------------- */

type XY = { x: number; y: number };

function loadLayout(key: string): Record<string, XY> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Where the person dragged each card, kept in the browser per goal and view, over the computed
 * layout. Arrows marked `auto` leave and enter by the sides facing where the cards are now.
 */
function useLayout(key: string, nodes: Node<SysData>[], edges: Edge[]) {
  const moved = useRef<Record<string, XY>>(loadLayout(key));
  const [count, setCount] = useState(() => Object.keys(moved.current).length);
  const place = (ns: Node<SysData>[], old: Node<SysData>[] = []) => {
    // React Flow keeps each card's measured size on its node: a card that loses it is hidden until measured again.
    const prev = new Map(old.map(n => [n.id, n]));
    return ns.map(n => {
      const o = prev.get(n.id);
      return { ...o, ...n, position: moved.current[n.id] ?? n.position, ...(o?.measured ? { measured: o.measured } : {}) };
    });
  };
  const [rf, setRf] = useState<Node<SysData>[]>(() => place(nodes));
  const seen = useRef({ key, nodes });
  useEffect(() => {
    if (seen.current.key === key && seen.current.nodes === nodes) return;
    if (seen.current.key !== key) moved.current = loadLayout(key);
    seen.current = { key, nodes };
    setCount(Object.keys(moved.current).length);
    setRf(old => place(nodes, old));
  }, [key, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const routed = useMemo(() => {
    const at = new Map(rf.map(n => [n.id, n.position]));
    return edges.map(e => (e.data?.auto && at.has(e.source) && at.has(e.target) ? { ...e, ...handles(at.get(e.source)!, at.get(e.target)!) } : e));
  }, [rf, edges]);
  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(moved.current));
    } catch {
      // Kept for this visit only.
    }
  };
  return {
    nodes: rf,
    edges: routed,
    onNodesChange: (chs: NodeChange<Node<SysData>>[]) => {
      for (const c of chs) if (c.type === 'position' && c.position) moved.current[c.id] = c.position;
      setRf(ns => applyNodeChanges(chs, ns));
    },
    onNodeDragStop: () => (save(), setCount(Object.keys(moved.current).length)),
    moved: count > 0,
    reset: () => {
      moved.current = {};
      save();
      setCount(0);
      setRf(old => place(nodes, old));
    },
  };
}

/** Whether a class is in a node of the map: the class itself, or the area it's in. */
const inNode = (ix: CodeIndex, cls: string, node: string) => (isArea(node) ? ix.cls.get(cls)?.area === node.slice(5) : cls === node);

const nodeName = (ix: CodeIndex, id: string, titles: Map<string, string>) => (isArea(id) ? titles.get(id.slice(5)) ?? areaLabel(id.slice(5)) : ix.cls.get(id)?.name ?? id);

/** The links behind a connection on the map. */
function linksOf(ix: CodeIndex, links: Link[], c: { from: string; to: string; kind: LinkKind }): Link[] {
  return links.filter(l => l.kind === c.kind && inNode(ix, l.from, c.from) && inNode(ix, l.to, c.to));
}

/** Where an edge is in the code: the file of the function it starts in (where a handler was connected, for a signal's), and the line. */
function edgeWhere(ix: CodeIndex, e: CodeEdge): string {
  const f = ix.fn.get(e.k === 'listen' ? e.via ?? '' : e.f);
  return f ? `${f.file.split('/').pop()}:${e.l}` : '';
}

/** The function to trace for an edge: its caller, or for a handler, the handler. */
const edgeFn = (e: CodeEdge) => (e.k === 'listen' ? e.t : e.f);

function EdgeList({ ix, edges, onNav }: { ix: CodeIndex; edges: CodeEdge[]; onNav: (n: Partial<SystemsNav>) => void }) {
  return (
    <ul className="edge-list small">
      {edges.slice(0, 200).map(e => (
        <li key={edgeKey(e) + e.via}>
          <button className="text-link sys-sentence" onClick={() => onNav({ tool: 'trace', trace: edgeFn(e), sel: edgeFn(e), up: false })} title="Trace it">
            {edgeSentence(ix, e)}
          </button>
          {e.n && e.n > 1 && <span className="muted"> ×{e.n}</span>}
          <span className="muted mono"> {edgeWhere(ix, e)}</span>
        </li>
      ))}
      {edges.length > 200 && <li className="muted">and {edges.length - 200} more</li>}
    </ul>
  );
}

/* ---------------- trace ---------------- */

const STEP_ICON: Record<Step['kind'], string> = { call: '→', new: '✦', emit: '⚡', listen: '↳', caller: '↑', engine: '⏵' };

function TraceView({ ix, bix, chg, root, up, sel, onNav }: { ix: CodeIndex; bix?: CodeIndex; chg?: CodeChange; root?: string; up: boolean; sel?: string; onNav: (n: Partial<SystemsNav>) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => setOpen(new Set()), [root, up]);
  if (!root || !(ix.fn.has(root) || ix.sig.has(root) || ix.cls.has(root))) {
    return (
      <div className="trace-empty">
        <p>Pick a function to follow: from the search box, a class's functions, or one of the entry points on the right.</p>
        <p className="muted small">Trace reads like a debugger's step-through: each line a function calls, an object it makes, or a signal it emits, in the order its code does it. Signals continue into the functions that handle them.</p>
      </div>
    );
  }
  const added = new Set(chg?.added.map(edgeKey));
  const rows: ReactNode[] = [];
  const walk = (id: string, step: Step | undefined, key: string, depth: number, path: Set<string>) => {
    const kids = up ? stepsUp(ix, id) : stepsDown(ix, id);
    const loop = path.has(id) && depth > 0;
    const isOpen = depth === 0 || open.has(key);
    const gone = !up && depth >= 0 && chg && ix.fn.has(id) ? chg.removed.filter(e => e.f === id && (e.k === 'call' || e.k === 'new' || e.k === 'emit')) : [];
    rows.push(
      <TraceRow
        key={key} ix={ix} id={id} step={step} depth={depth} loop={loop} kids={loop ? 0 : kids.length + gone.length} open={isOpen} sel={sel === id}
        isNew={!!step?.edge && added.has(edgeKey(step.edge))} edited={!!chg?.edited.has(id) || !!chg?.newFns.has(id)}
        onToggle={() => setOpen(o => {
          const n = new Set(o);
          if (n.has(key)) n.delete(key);
          else n.add(key);
          return n;
        })}
        onSelect={() => onNav({ sel: step?.kind === 'engine' ? undefined : id })}
        onRoot={() => onNav({ trace: id, sel: id })}
      />,
    );
    if (loop || !isOpen || depth > 24) return;
    const next = new Set(path).add(id);
    kids.slice(0, 80).forEach((s, i) => {
      if (s.kind === 'engine') rows.push(<div key={`${key}/e`} className="trace-row engine" style={{ paddingLeft: 12 + (depth + 1) * 18 }}><span className="trace-icon">⏵</span> the engine calls it, {engineWhen(ix.fn.get(id)?.name ?? '')}</div>);
      else walk(s.id, s, `${key}/${i}:${s.id}`, depth + 1, next);
    });
    if (kids.length > 80) rows.push(<div key={`${key}/more`} className="trace-row muted small" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>and {kids.length - 80} more</div>);
    for (const e of gone) {
      rows.push(
        <div key={`${key}/gone:${edgeKey(e)}`} className="trace-row gone" style={{ paddingLeft: 12 + (depth + 1) * 18 }} title="Removed in this scope">
          <span className="def-sign del">−</span> <span className="mono">{edgeSentence(bix ?? ix, e, ix).replace(/^.*? (calls|makes a|emits) /, '$1 ')}</span>
        </div>,
      );
    }
  };
  walk(root, undefined, root, 0, new Set());
  return (
    <div className="trace-view">
      <div className="trace-head">
        <div className="seg" role="group" aria-label="Direction">
          <button className={`btn small${!up ? ' on' : ''}`} onClick={() => onNav({ up: false })} title="What it does: the calls, objects and signals in its code, in order">
            ↓ What it does
          </button>
          <button className={`btn small${up ? ' on' : ''}`} onClick={() => onNav({ up: true })} title="How it's reached: who calls it, emits what it handles, or makes its object">
            ↑ How it's reached
          </button>
        </div>
        <button className="btn ghost small" onClick={() => setOpen(new Set(allKeys(ix, root, up, 3)))}>
          Open 3 levels
        </button>
        <button className="btn ghost small" onClick={() => setOpen(new Set())}>
          Fold
        </button>
      </div>
      <div className="trace-rows scroll">{rows}</div>
    </div>
  );
}

/** The keys of every row down to a depth, to open them at once. */
function allKeys(ix: CodeIndex, root: string, up: boolean, depth: number): string[] {
  const out: string[] = [];
  const walk = (id: string, key: string, d: number, path: Set<string>) => {
    if (d >= depth || path.has(id)) return;
    out.push(key);
    const next = new Set(path).add(id);
    (up ? stepsUp(ix, id) : stepsDown(ix, id)).slice(0, 80).forEach((s, i) => s.kind !== 'engine' && walk(s.id, `${key}/${i}:${s.id}`, d + 1, next));
  };
  walk(root, root, 0, new Set());
  return out;
}

function TraceRow({ ix, id, step, depth, loop, kids, open, sel, isNew, edited, onToggle, onSelect, onRoot }: {
  ix: CodeIndex;
  id: string;
  step?: Step;
  depth: number;
  loop: boolean;
  kids: number;
  open: boolean;
  sel: boolean;
  isNew: boolean;
  edited: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onRoot: () => void;
}) {
  const f = ix.fn.get(id);
  const s = ix.sig.get(id);
  const c = ix.cls.get(id);
  const label = f ? fnLabel(ix, id) : s ? `${ix.cls.get(s.cls)?.name ?? s.cls}.${s.name}` : c ? c.name : id;
  const what = !step ? '' : step.kind === 'new' && !ix.cls.has(id) ? 'made by' : step.kind === 'new' ? 'makes' : step.kind === 'emit' && ix.sig.has(id) ? 'emits' : step.kind === 'emit' ? 'emitted by' : step.kind === 'listen' ? 'handled by' : '';
  const st = f ? stateOf(ix, id) : undefined;
  const at = step?.edge ? (step.kind === 'listen' ? step.edge.via && ix.fn.get(step.edge.via) : ix.fn.get(step.edge.f)) : undefined;
  return (
    <div className={`trace-row${sel ? ' on' : ''}${loop ? ' loop' : ''}${isNew ? ' new' : ''}`} style={{ paddingLeft: 12 + depth * 18 }}>
      <button className="trace-toggle" onClick={onToggle} disabled={!kids || depth === 0} aria-label={open ? 'Fold' : 'Open'} aria-expanded={open}>
        {kids && depth > 0 ? (open ? '▾' : '▸') : ''}
      </button>
      <span className="trace-icon" title={step?.kind}>{step ? STEP_ICON[step.kind] : '◉'}</span>
      {what && <span className="muted small">{what}</span>}
      <button className={`text-link mono trace-label${s ? ' sig' : ''}`} onClick={onSelect} onDoubleClick={onRoot} title="Inspect · double-click to trace from here">
        {label}
        {f && '()'}
      </button>
      {isNew && <span className="pill done">new</span>}
      {edited && <span className="pill decision" title="Its code changed in this scope">edited</span>}
      {step?.edge?.g && <span className="pill" title="Followed by its name only: the receiver's type isn't declared">by name</span>}
      {f?.mut && <span className="trace-mut" title="Changes its own object's state">✎</span>}
      {f?.engine && <span className="pill" title={engineWhen(f.name)}>engine</span>}
      {loop && <span className="muted small">↺ already above</span>}
      {st && (st.writes.length > 0 || st.reads.length > 0) && (
        <span className="muted small trace-state" title={[...st.writes.map(e => `writes ${e.t}`), ...st.reads.map(e => `reads ${e.t}`)].slice(0, 30).join('\n')}>
          {st.writes.length > 0 && <span className="w">writes {st.writes.length}</span>} {st.reads.length > 0 && <span>reads {st.reads.length}</span>}
        </span>
      )}
      {!!kids && !open && depth > 0 && <span className="muted small">· {kids} step{kids === 1 ? '' : 's'}</span>}
      {at && step?.edge && <span className="muted small trace-at mono">{at.file.split('/').pop()}:{step.edge.l}</span>}
    </div>
  );
}

/* ---------------- between ---------------- */

/** A system: an area (area:<path>) or one class. */
function systemOf(ix: CodeIndex, id: string | undefined): Set<string> {
  if (!id) return new Set();
  if (isArea(id)) return new Set((ix.classesOf.get(id.slice(5)) ?? []).map(c => c.id));
  return ix.cls.has(id) ? new Set([id]) : new Set();
}

const sysName = (ix: CodeIndex, id: string | undefined, titles: Map<string, string>) => (!id ? '' : isArea(id) ? titles.get(id.slice(5)) ?? areaLabel(id.slice(5)) : ix.cls.get(id)?.name ?? id);

function SystemPick({ ix, value, titles, label, onPick }: { ix: CodeIndex; value?: string; titles: Map<string, string>; label: string; onPick: (v: string) => void }) {
  return (
    <select className="small" value={value ?? ''} onChange={e => onPick(e.target.value)} aria-label={label}>
      <option value="">{label}…</option>
      <optgroup label="Areas">
        {[...ix.classesOf.keys()].sort().map(a => (
          <option key={a} value={areaNode(a)}>
            {titles.get(a) ?? areaLabel(a)} ({a || 'top level'})
          </option>
        ))}
      </optgroup>
      <optgroup label="Classes">
        {[...ix.g.classes].sort((x, y) => x.name.localeCompare(y.name)).map(c => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

const TOUCH_STYLE: Record<Touch['kind'], { stroke: string; dash?: string }> = {
  changes: { stroke: 'var(--limited)' },
  makes: { stroke: 'var(--done)' },
  calls: { stroke: 'var(--text-2)' },
  reads: { stroke: 'var(--waiting)', dash: '2 4' },
};

function BetweenView({ goal, ix, links, a, b, bpick, titles, onNav }: { goal: string; ix: CodeIndex; links: Link[]; a?: string; b?: string; bpick?: string; titles: Map<string, string>; onNav: (n: Partial<SystemsNav>) => void }) {
  const [shared, setShared] = useState(false);
  const A = useMemo(() => systemOf(ix, a), [ix, a]);
  const B = useMemo(() => systemOf(ix, b), [ix, b]);
  const res = useMemo(() => (A.size && B.size ? between(ix, links, A, B) : undefined), [ix, links, A, B]);
  const { nodes, edges } = useMemo(() => {
    if (!res) return { nodes: [], edges: [] };
    const meets = res.meetings.filter(m => shared || m.how !== 'shared').slice(0, 16);
    const an = sysName(ix, a, titles);
    const bn = sysName(ix, b, titles);
    // The two systems side by side at the top, what joins them in a column beneath.
    const side = (key: 'a' | 'b', id: string, set: Set<string>, x: number): Node<SysData> => ({
      id: key, type: 'sys', position: { x, y: -170 },
      data: {
        id, title: key === 'a' ? an : bn, sub: isArea(id) ? id.slice(5) || '(top level)' : ix.cls.get(id)?.file ?? '', kind: isArea(id) ? 'area' : 'class',
        badges: [], when: [], count: isArea(id) ? `${set.size} class${set.size === 1 ? '' : 'es'}` : '', changed: 0, isNew: false, on: false, faded: false, isolated: true,
      },
    });
    const nodes: Node<SysData>[] = [
      side('a', a!, A, 0),
      side('b', b!, B, 840),
      ...meets.map((m, i) => {
        const c = ix.cls.get(m.mid)!;
        return { id: `m:${m.mid}`, type: 'sys', position: { x: 420, y: i * (NH - 6) }, data: { id: m.mid, title: c.name, sub: c.file, kind: 'class' as const, badges: [meetWord(m.how, an, bn)], when: [], count: '', changed: 0, isNew: false, on: false, faded: m.how === 'shared', isolated: false } };
      }),
    ];
    const edges: Edge[] = [];
    const names = (ts: Touch[]) => {
      const n = [...new Set(ts.map(x => ix.fn.get(x.target)?.name ?? ix.field.get(x.target)?.name ?? x.target))];
      return n.slice(0, 2).join(', ') + (n.length > 2 ? '…' : '');
    };
    for (const m of meets) {
      for (const [key, ts] of [['a', m.a], ['b', m.b]] as const) {
        const byKind = new Map<Touch['kind'], Touch[]>();
        for (const t of ts) byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t]);
        for (const [kind, list] of byKind) {
          const st = TOUCH_STYLE[kind];
          // Arrows follow the influence: what changes it points at it, what reads it is pointed at.
          const into = kind !== 'reads';
          const near = key === 'a' ? { out: 'r', in: 'l' } : { out: 'fl', in: 'fr' };
          const midH = key === 'a' ? { out: 'fl', in: 'l' } : { out: 'r', in: 'fr' };
          const pk = `${key}|${kind}|${m.mid}`;
          const on = bpick === pk;
          edges.push({
            id: pk, data: { bpick: pk }, interactionWidth: 16, source: into ? key : `m:${m.mid}`, target: into ? `m:${m.mid}` : key,
            sourceHandle: into ? near.out : midH.out, targetHandle: into ? midH.in : key === 'a' ? 'fr' : 'l',
            label: `${kind} ${names(list)}`, labelStyle: { fill: st.stroke, fontSize: 10.5 }, labelBgStyle: { fill: 'var(--panel)' },
            style: { stroke: st.stroke, strokeDasharray: st.dash, strokeWidth: on ? 3 : 1.5, opacity: bpick && !on ? 0.2 : m.how === 'shared' ? 0.4 : 0.9 }, markerEnd: { type: MarkerType.ArrowClosed, color: st.stroke },
          });
        }
      }
    }
    for (const [dir, list] of [['ab', res.ab], ['ba', res.ba]] as const) {
      const byKind = new Map<LinkKind, Link[]>();
      for (const l of list) byKind.set(l.kind, [...(byKind.get(l.kind) ?? []), l]);
      for (const [kind, ls] of byKind) {
        const st = KIND_STYLE[kind];
        const n = [...new Set(ls.flatMap(l => [...l.names]))];
        const pk = `${dir}|${kind}`;
        edges.push({
          id: pk, data: { bpick: pk }, interactionWidth: 16, source: dir === 'ab' ? 'a' : 'b', target: dir === 'ab' ? 'b' : 'a', type: 'smoothstep',
          sourceHandle: 'u', targetHandle: 't',
          label: `${kind === 'signal' ? '⚡' : st.word} ${n.slice(0, 3).join(', ')}${n.length > 3 ? '…' : ''}`, labelStyle: { fill: st.stroke, fontSize: 10.5 }, labelBgStyle: { fill: 'var(--panel)' },
          style: { stroke: st.stroke, strokeDasharray: st.dash, strokeWidth: bpick === pk ? 3 : 2, opacity: bpick && bpick !== pk ? 0.2 : 1 }, markerEnd: { type: MarkerType.ArrowClosed, color: st.stroke },
        });
      }
    }
    return { nodes, edges };
  }, [res, shared, ix, a, b, A, B, titles, bpick]);
  const lay = useLayout(`mh.systems.layout.${goal}.between`, nodes, edges);
  return (
    <div className="sys-map">
      <div className="sys-banner">
        <SystemPick ix={ix} value={a} titles={titles} label="A system" onPick={v => onNav({ a: v || undefined, sel: undefined, bpick: undefined })} />
        <span className="muted">and</span>
        <SystemPick ix={ix} value={b} titles={titles} label="another" onPick={v => onNav({ b: v || undefined, sel: undefined, bpick: undefined })} />
        <label className="small">
          <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} /> also what both only read
        </label>
        {res && <span className="muted small">{res.meetings.length} meeting point{res.meetings.length === 1 ? '' : 's'}, {res.ab.length + res.ba.length} direct link{res.ab.length + res.ba.length === 1 ? '' : 's'}</span>}
        {lay.moved && (
          <button className="btn ghost small" onClick={lay.reset}>
            Reset layout
          </button>
        )}
      </div>
      {!res ? (
        <div className="empty">
          Pick two systems, an area or a class each: say the ecosystem and the Creature, or the world and the creatures. The middle column is what joins them, with the arrows running the way influence does.
        </div>
      ) : !nodes.length ? (
        <div className="empty">These two don't touch: no calls, signals, objects or state between them, nor anything both use.</div>
      ) : (
        <ReactFlow
          nodes={lay.nodes}
          edges={lay.edges}
          nodeTypes={SYS_TYPES}
          onNodesChange={lay.onNodesChange}
          onNodeDragStop={lay.onNodeDragStop}
          onNodeClick={(_, n) => onNav({ sel: n.data.id })}
          onEdgeClick={(_, e) => onNav({ bpick: bpick === e.data?.bpick ? undefined : (e.data?.bpick as string), sel: undefined })}
          onPaneClick={() => onNav({ sel: undefined, bpick: undefined })}
          fitView
          fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
        >
          <Background gap={20} size={1} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
    </div>
  );
}

const meetWord = (how: Meeting['how'], a: string, b: string) => (how === 'a⇒b' ? `${a} ⇒ ${b}` : how === 'b⇒a' ? `${b} ⇒ ${a}` : how === 'both' ? 'both ways' : 'both read it');

function BetweenPanel({ ix, links, a, b, bpick, titles, onNav }: { ix: CodeIndex; links: Link[]; a?: string; b?: string; bpick?: string; titles: Map<string, string>; onNav: (n: Partial<SystemsNav>) => void }) {
  const A = systemOf(ix, a);
  const B = systemOf(ix, b);
  const res = useMemo(() => (A.size && B.size ? between(ix, links, A, B) : undefined), [ix, links, a, b]); // eslint-disable-line react-hooks/exhaustive-deps
  const an = sysName(ix, a, titles);
  const bn = sysName(ix, b, titles);
  if (!res) return <div className="muted small">Pick two systems above the map.</div>;
  const trace = (fn: string) => onNav({ tool: 'trace', trace: fn, sel: fn });
  const touchLine = (t: Touch) => (
    <li key={t.fn + t.target + t.kind}>
      <button className="text-link mono" onClick={() => trace(t.fn)}>
        {fnLabel(ix, t.fn)}
      </button>{' '}
      <span className="muted">{t.kind}</span> <span className="mono">{ix.fn.has(t.target) ? fnLabel(ix, t.target) + '()' : ix.field.has(t.target) ? `${ix.field.get(t.target)!.cls}.${ix.field.get(t.target)!.name}` : t.target}</span>
    </li>
  );
  return (
    <>
      <div className="kicker">Between</div>
      <b>
        {an} and {bn}
      </b>
      {bpick && <PickedConnection ix={ix} res={res} pick={bpick} an={an} bn={bn} onNav={onNav} />}
      <p className="area-text small">
        Influence runs from what changes something to what reads it. When {an} changes a class that {bn} reads, {an} reaches {bn} through it, even if they never call each other.
      </p>
      {(res.ab.length > 0 || res.ba.length > 0) && <div className="section-title">Straight between them</div>}
      {[...res.ab, ...res.ba].map(l => (
        <div key={l.kind + l.from + l.to} className="small">
          <b>{ix.cls.get(l.from)?.name}</b> {KIND_STYLE[l.kind].word} <b>{ix.cls.get(l.to)?.name}</b>: <span className="mono">{[...l.names].slice(0, 6).join(', ')}</span>
          <ul className="changes small">
            {l.edges.filter(e => e.k !== 'listen').slice(0, 6).map(e => (
              <li key={edgeKey(e)}>
                <button className="text-link sys-sentence" onClick={() => trace(e.f)}>
                  {edgeSentence(ix, e)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="section-title">Where they meet</div>
      {res.meetings.map(m => (
        <details key={m.mid} className="meeting" open={m.how !== 'shared' && res.meetings.indexOf(m) < 4}>
          <summary>
            <b>{ix.cls.get(m.mid)?.name}</b> <span className={`pill${m.how === 'shared' ? '' : ' decision'}`}>{meetWord(m.how, an, bn)}</span>
          </summary>
          {m.a.length > 0 && (
            <>
              <div className="muted small">{an}:</div>
              <ul className="changes small">{dedupe(m.a).slice(0, 8).map(touchLine)}</ul>
            </>
          )}
          {m.b.length > 0 && (
            <>
              <div className="muted small">{bn}:</div>
              <ul className="changes small">{dedupe(m.b).slice(0, 8).map(touchLine)}</ul>
            </>
          )}
        </details>
      ))}
      {!res.meetings.length && <div className="muted small">Nothing in between.</div>}
    </>
  );
}

/** The connection picked on the Between map: every place in the code behind that arrow. */
function PickedConnection({ ix, res, pick, an, bn, onNav }: { ix: CodeIndex; res: ReturnType<typeof between>; pick: string; an: string; bn: string; onNav: (n: Partial<SystemsNav>) => void }) {
  const [side, kind, mid] = pick.split('|');
  let title: string;
  let edges: CodeEdge[];
  if (side === 'ab' || side === 'ba') {
    const ls = (side === 'ab' ? res.ab : res.ba).filter(l => l.kind === kind);
    title = `${side === 'ab' ? an : bn} ${KIND_STYLE[kind as LinkKind]?.word ?? kind} ${side === 'ab' ? bn : an}`;
    edges = ls.flatMap(l => l.edges);
  } else {
    const m = res.meetings.find(x => x.mid === mid);
    const ts = dedupe((side === 'a' ? m?.a : m?.b) ?? []).filter(t => t.kind === kind);
    title = `${side === 'a' ? an : bn} ${kind} ${ix.cls.get(mid)?.name ?? mid}`;
    edges = ts.map(t => t.edge);
  }
  return (
    <div className="picked">
      <div className="row-wrap">
        <span className="kicker">Connection</span>
        <button className="btn ghost small" onClick={() => onNav({ bpick: undefined })} aria-label="Close the connection">
          ✕
        </button>
      </div>
      <b>{title}</b>
      <EdgeList ix={ix} edges={edges} onNav={onNav} />
    </div>
  );
}

const dedupe = (ts: Touch[]) => {
  const seen = new Set<string>();
  return ts.filter(t => !seen.has(t.fn + t.target + t.kind) && seen.add(t.fn + t.target + t.kind));
};

/* ---------------- the inspector ---------------- */

function StartPanel({ ix, bix, chg, view, onNav }: { ix: CodeIndex; bix?: CodeIndex; chg?: CodeChange; view: DesignScopeView; onNav: (n: Partial<SystemsNav>) => void }) {
  const groups = new Map<string, string[]>();
  for (const id of ix.entries) {
    const f = ix.fn.get(id)!;
    const c = ix.cls.get(f.cls)!;
    const g = c.main ? 'The main scene' : c.kind === 'autoload' ? 'Autoloads (always there)' : engineWhen(f.name).replace(/^./, x => x.toUpperCase());
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const order = ['The main scene', 'Autoloads (always there)', 'Every physics tick', 'Every frame', 'On input nothing else took', 'On any input', 'On input over it', 'When it enters the scene', 'When it redraws'];
  const keys = [...groups.keys()].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
  const s = ix.g.stats;
  return (
    <>
      <div className="kicker">Where the game starts</div>
      <p className="area-text small">The engine runs the main scene's script and the autoloads, then calls these callbacks on every node in the tree. Pick one to trace what happens from there.</p>
      {keys.map(k => (
        <details key={k} className="meeting" open={k === 'The main scene' || k === 'Every physics tick' || k === 'Autoloads (always there)'}>
          <summary>
            {k} <span className="muted small">{groups.get(k)!.length}</span>
          </summary>
          <ul className="changes small">
            {groups.get(k)!.slice(0, 40).map(id => (
              <li key={id}>
                <button className="text-link mono" onClick={() => onNav({ tool: 'trace', trace: id, sel: id, up: false })}>
                  {fnLabel(ix, id)}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
      {chg && <CodeChanges ix={ix} bix={bix} chg={chg} title={view.scope?.title} onNav={onNav} />}
      <details className="more">
        <summary className="section-title">What it could follow</summary>
        <div className="small">
          {s.files} files read (tests and add-ons left out). Of {s.calls} calls into the project, {s.resolved} were followed by their declared types and {s.guessed} by name only; {s.unresolved} weren't, as their receiver has no type.
        </div>
        {s.missed.length > 0 && (
          <>
            <div className="muted small">Typing these would let it follow more:</div>
            <ul className="changes small">
              {s.missed.slice(0, 15).map(m => (
                <li key={m.chain} className="mono">
                  {m.chain} ×{m.n}
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </>
  );
}

function CodeChanges({ ix, bix, chg, title, onNav }: { ix: CodeIndex; bix?: CodeIndex; chg: CodeChange; title?: string; onNav: (n: Partial<SystemsNav>) => void }) {
  const cross = (e: CodeEdge, g: CodeIndex) => {
    const a = g.fn.get(e.f)?.cls ?? g.sig.get(e.f)?.cls;
    const b = g.fn.get(e.t)?.cls ?? g.sig.get(e.t)?.cls ?? g.field.get(e.t)?.cls ?? (e.k === 'new' ? e.t : undefined);
    return a !== b;
  };
  const weight = { emit: 0, listen: 0, new: 1, call: 2, write: 3, read: 4 };
  const added = chg.added.filter(e => cross(e, ix)).sort((x, y) => weight[x.k] - weight[y.k]);
  const removed = chg.removed.filter(e => bix && cross(e, bix)).sort((x, y) => weight[x.k] - weight[y.k]);
  const total = chg.added.length + chg.removed.length + chg.newClasses.size + chg.goneClasses.length + chg.edited.size;
  return (
    <>
      <div className="section-title">How this scope changed what runs</div>
      {title && <div className="muted small ellipsis">{title}</div>}
      {!total ? (
        <div className="muted small">Nothing in how the code runs changed here.</div>
      ) : (
        <ul className="changes small">
          {[...chg.newClasses].map(id => (
            <li key={'nc' + id}>
              <span className="def-sign add">+</span> class{' '}
              <button className="text-link mono" onClick={() => onNav({ tool: 'map', sel: id })}>
                {ix.cls.get(id)?.name}
              </button>
            </li>
          ))}
          {chg.goneClasses.map(c => (
            <li key={'gc' + c.id}>
              <span className="def-sign del">−</span> class <span className="mono">{c.name}</span>
            </li>
          ))}
          {[...chg.newSignals].map(id => (
            <li key={'ns' + id}>
              <span className="def-sign add">+</span> signal <span className="mono">{ix.sig.get(id)?.name}</span> on {ix.sig.get(id)?.cls}
            </li>
          ))}
          {added.slice(0, 14).map(e => (
            <li key={'a' + edgeKey(e)}>
              <span className="def-sign add">+</span>{' '}
              <button className="text-link sys-sentence" onClick={() => onNav({ tool: 'trace', trace: e.k === 'listen' ? e.t : e.f, sel: e.k === 'listen' ? e.t : e.f, up: false })}>
                {edgeSentence(ix, e)}
              </button>
            </li>
          ))}
          {removed.slice(0, 8).map(e => (
            <li key={'r' + edgeKey(e)}>
              <span className="def-sign del">−</span> {edgeSentence(bix!, e)}
            </li>
          ))}
          <li className="muted">
            {chg.added.length} links added, {chg.removed.length} removed; {chg.edited.size} functions edited, {chg.newFns.size} new, {chg.goneFns.length} gone
          </li>
        </ul>
      )}
    </>
  );
}

function AreaInfo({ ix, snap, area, nav, chg, onNav }: { ix: CodeIndex; snap: DesignSnapshot; area: string; nav: SystemsNav; chg?: CodeChange; onNav: (n: Partial<SystemsNav>) => void }) {
  const a = snap.map.areas.find(x => x.path === area);
  const cs = [...(ix.classesOf.get(area) ?? [])].sort((x, y) => (ix.fnsOf.get(y.id)?.length ?? 0) - (ix.fnsOf.get(x.id)?.length ?? 0));
  const open = (nav.open ?? []).includes(area);
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">Area</div>
          <b>{a?.title ?? areaLabel(area)}</b> <span className="mono muted small">{area || '(top level)'}</span>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ sel: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      {a?.summary && <p className="area-text">{a.summary}</p>}
      <div className="row-wrap">
        <button className="btn small" onClick={() => onNav({ open: open ? (nav.open ?? []).filter(x => x !== area) : [...(nav.open ?? []), area] })}>
          {open ? 'Fold into one' : 'Open into classes'}
        </button>
        <button className="btn ghost small" onClick={() => onNav({ isolate: [areaNode(area)] })} title="Show only it and what it's linked to">
          Isolate
        </button>
        <button className="btn ghost small" onClick={() => onNav({ tool: 'between', a: areaNode(area), sel: undefined })}>
          Compare with…
        </button>
      </div>
      <div className="section-title">Classes</div>
      <ul className="defs">
        {cs.map(c => (
          <li key={c.id}>
            <button className="def-row" onClick={() => onNav({ sel: c.id })}>
              <span className="mono ellipsis">{c.name}</span>
              {chg?.touched.has(c.id) && <span className="pill decision">changed</span>}
              <span className="muted small def-file">{ix.fnsOf.get(c.id)?.length ?? 0} fn</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function ClassPanel({ ix, links, chg, id, nav, onNav }: { ix: CodeIndex; links: Link[]; chg?: CodeChange; id: string; nav: SystemsNav; onNav: (n: Partial<SystemsNav>) => void }) {
  const c = ix.cls.get(id)!;
  const fns = [...(ix.fnsOf.get(id) ?? [])].sort((a, b) => Number(!!b.engine) - Number(!!a.engine) || a.line - b.line);
  const outs = links.filter(l => l.from === id);
  const ins = links.filter(l => l.to === id);
  const group = (ls: Link[]) => {
    const by = new Map<LinkKind, Link[]>();
    for (const l of ls) by.set(l.kind, [...(by.get(l.kind) ?? []), l]);
    return by;
  };
  const OUT_WORDS: Record<LinkKind, string> = { call: 'Calls', signal: 'Its signals reach', new: 'Makes', read: 'Reads the state of', write: 'Writes the state of' };
  const IN_WORDS: Record<LinkKind, string> = { call: 'Called by', signal: 'Hears signals from', new: 'Made by', read: 'Its state is read by', write: 'Its state is written by' };
  const list = (by: Map<LinkKind, Link[]>, words: Record<LinkKind, string>, side: 'to' | 'from') =>
    (['call', 'signal', 'new', 'write', 'read'] as LinkKind[]).filter(k => by.has(k)).map(k => (
      <div key={side + k} className="small sys-links">
        <span className="muted">{words[k]}</span>{' '}
        {by.get(k)!.sort((x, y) => y.edges.length - x.edges.length).map((l, i) => (
          <span key={l[side]}>
            {i > 0 && ', '}
            <button className="text-link" onClick={() => onNav({ sel: l[side] })} title={[...l.names].slice(0, 12).join(', ')}>
              {ix.cls.get(l[side])?.name}
            </button>
            <span className="muted"> {l.edges.length}</span>
          </span>
        ))}
      </div>
    ));
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">{c.kind === 'autoload' ? 'Autoload' : c.main ? 'Main scene script' : c.kind === 'inner' ? 'Inner class' : 'Class'}</div>
          <b>{c.name}</b> <span className="mono muted small">{c.file}</span>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ sel: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="muted small">
        {c.ext ? `extends ${ix.cls.get(c.ext)?.name ?? c.ext}` : c.base ? `extends ${c.base}` : ''} · in {areaLabel(c.area)}
      </div>
      <div className="row-wrap">
        <button className="btn ghost small" onClick={() => onNav({ tool: 'map', isolate: [id], open: [...new Set([...(nav.open ?? []), c.area])] })} title="Show only it and what it's linked to">
          Isolate
        </button>
        <button className="btn ghost small" onClick={() => onNav({ tool: 'between', a: id, sel: undefined })}>
          Compare with…
        </button>
        <button className="btn ghost small" onClick={() => onNav({ tool: 'trace', trace: id, up: true, sel: id })} title="Who makes its objects">
          ↑ Who makes it
        </button>
      </div>
      <div className="section-title">Links</div>
      {list(group(outs), OUT_WORDS, 'to')}
      {list(group(ins), IN_WORDS, 'from')}
      {!outs.length && !ins.length && <div className="muted small">It doesn't link to other classes.</div>}
      <div className="section-title">Functions</div>
      <ul className="defs">
        {fns.map(f => (
          <li key={f.id}>
            <button className="def-row" onClick={() => onNav({ tool: 'trace', trace: f.id, sel: f.id, up: false })} title="Trace it">
              <span className="mono ellipsis">{f.name}</span>
              {f.engine && <span className="pill" title={engineWhen(f.name)}>⏵ {engineWhen(f.name)}</span>}
              {f.mut && <span className="muted small">changes state</span>}
              {(chg?.edited.has(f.id) || chg?.newFns.has(f.id)) && <span className="pill decision">{chg?.newFns.has(f.id) ? 'new' : 'edited'}</span>}
              <span className="muted small def-file">:{f.line}</span>
            </button>
          </li>
        ))}
      </ul>
      {ix.g.signals.some(s => s.cls === id) && (
        <>
          <div className="section-title">Signals</div>
          <ul className="defs">
            {ix.g.signals.filter(s => s.cls === id).map(s => (
              <li key={s.id}>
                <button className="def-row" onClick={() => onNav({ sel: s.id })}>
                  <span className="mono">⚡ {s.name}</span>
                  <span className="muted small def-file">
                    {(ix.into.get(s.id) ?? []).filter(e => e.k === 'emit').length} emit · {(ix.out.get(s.id) ?? []).filter(e => e.k === 'listen').length} listen
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function SignalPanel({ ix, id, onNav }: { ix: CodeIndex; id: string; onNav: (n: Partial<SystemsNav>) => void }) {
  const s = ix.sig.get(id)!;
  const emits = (ix.into.get(id) ?? []).filter(e => e.k === 'emit');
  const listens = (ix.out.get(id) ?? []).filter(e => e.k === 'listen');
  const trace = (f: string) => onNav({ tool: 'trace', trace: f, sel: f, up: false });
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">Signal</div>
          <b className="mono">
            ⚡ {ix.cls.get(s.cls)?.name}.{s.name}
          </b>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ sel: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      <button className="btn ghost small" onClick={() => onNav({ tool: 'trace', trace: id, sel: id, up: false })}>
        Trace what it sets off
      </button>
      <div className="section-title">Emitted by</div>
      <ul className="changes small">
        {emits.map(e => (
          <li key={e.f}>
            <button className="text-link mono" onClick={() => trace(e.f)}>
              {fnLabel(ix, e.f)}
            </button>
            <span className="muted"> :{e.l}</span>
          </li>
        ))}
        {!emits.length && <li className="muted">Nothing in the project emits it.</li>}
      </ul>
      <div className="section-title">Handled by</div>
      <ul className="changes small">
        {listens.map(e => (
          <li key={e.t + e.via}>
            <button className="text-link mono" onClick={() => trace(e.t)}>
              {e.lam ? `a function in ${fnLabel(ix, e.t)}` : fnLabel(ix, e.t)}
            </button>
            {e.via && e.via !== e.t && <span className="muted"> · connected in {fnLabel(ix, e.via)}</span>}
          </li>
        ))}
        {!listens.length && <li className="muted">Nothing in the project connects to it.</li>}
      </ul>
    </>
  );
}

function FnPanel({ goal, rev, ix, chg, id, tool, onNav }: { goal: Goal; rev?: string; ix: CodeIndex; chg?: CodeChange; id: string; tool: string; onNav: (n: Partial<SystemsNav>) => void }) {
  const f = ix.fn.get(id)!;
  const c = ix.cls.get(f.cls)!;
  const text = useSource(goal.id, rev, f.file);
  const stacks = useMemo(() => stacksTo(ix, id), [ix, id]);
  const st = stateOf(ix, id);
  const byLine = new Map<number, CodeEdge[]>();
  for (const e of ix.out.get(id) ?? []) if (e.k === 'call' || e.k === 'new' || e.k === 'emit') byLine.set(e.l, [...(byLine.get(e.l) ?? []), e]);
  const go = (to: string) => onNav({ tool: 'trace', trace: to, sel: to, up: false });
  const lines = text ? text.split('\n').slice(f.line - 1, Math.min(f.end, f.line + 400)) : [];
  const fieldName = (e: CodeEdge) => {
    const x = ix.field.get(e.t);
    return x ? `${ix.cls.get(x.cls)?.name ?? x.cls}.${x.name}` : e.t;
  };
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">Function</div>
          <b className="mono">{fnLabel(ix, id)}()</b> <span className="mono muted small">{f.file}:{f.line}</span>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ sel: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="row-wrap small">
        {f.engine && <span className="pill">⏵ engine: {engineWhen(f.name)}</span>}
        {f.static && <span className="pill">static</span>}
        {f.mut && <span className="pill" title="It, or a method of its own it calls, assigns its object's variables">changes {c.name}'s state</span>}
        {chg?.newFns.has(id) && <span className="pill done">new in this scope</span>}
        {chg?.edited.has(id) && !chg.newFns.has(id) && <span className="pill decision">edited in this scope</span>}
      </div>
      <div className="row-wrap">
        {tool !== 'trace' && (
          <button className="btn small" onClick={() => go(id)}>
            Trace it
          </button>
        )}
        <button className="btn ghost small" onClick={() => onNav({ tool: 'trace', trace: id, sel: id, up: true })}>
          ↑ How it's reached
        </button>
        <button className="btn ghost small" onClick={() => onNav({ tool: 'map', sel: c.id, open: [c.area], isolate: [c.id] })}>
          Its class on the map
        </button>
      </div>
      <div className="section-title">How the engine gets here</div>
      {stacks.length ? (
        stacks.map((s, i) => (
          <div key={i} className="call-stack small">
            {s.frames.map((fr, j) => (
              <div key={j} className="stack-frame" style={{ paddingLeft: j * 10 }}>
                {j > 0 && <span className="muted">{s.via[j - 1] === 'emit' ? '⚡' : s.via[j - 1] === 'new' ? '✦' : '→'} </span>}
                <button className="text-link mono" onClick={() => onNav({ sel: fr })} onDoubleClick={() => go(fr)}>
                  {fnLabel(ix, fr)}
                </button>
                {j === 0 && ix.fn.get(fr)?.engine && <span className="muted"> ({engineWhen(ix.fn.get(fr)!.name)})</span>}
              </div>
            ))}
          </div>
        ))
      ) : (
        <div className="muted small">No path from an engine callback found: it may be called through something MetaHarness can't follow (an untyped receiver, a string, a scene).</div>
      )}
      {(st.writes.length > 0 || st.reads.length > 0) && (
        <>
          <div className="section-title">State of other classes it touches</div>
          {st.writes.length > 0 && (
            <div className="small">
              <span className="w">writes</span> <span className="mono">{[...new Set(st.writes.map(fieldName))].join(', ')}</span>
            </div>
          )}
          {st.reads.length > 0 && (
            <div className="small">
              <span className="muted">reads</span> <span className="mono">{[...new Set(st.reads.map(fieldName))].slice(0, 40).join(', ')}</span>
            </div>
          )}
        </>
      )}
      <div className="section-title">Its code</div>
      {text === undefined ? (
        <div className="muted small">Reading…</div>
      ) : text === null ? (
        <div className="muted small">Couldn't read {f.file}.</div>
      ) : (
        <pre className="code-view">
          {lines.map((l, i) => {
            const n = f.line + i;
            const es = byLine.get(n);
            return (
              <div key={n} className={`code-line${es ? ' calls' : ''}`}>
                <span className="code-n">{n}</span>
                <span className="code-t">{l || ' '}</span>
                {es && (
                  <span className="code-go">
                    {es.slice(0, 3).map(e => (
                      <button key={e.t} className="text-link" onClick={() => go(e.t)} title={edgeSentence(ix, e)}>
                        {e.k === 'emit' ? '⚡' : e.k === 'new' ? '✦' : '→'} {ix.fn.get(e.t)?.name ?? ix.sig.get(e.t)?.name ?? ix.cls.get(e.t)?.name ?? e.t}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            );
          })}
        </pre>
      )}
    </>
  );
}

