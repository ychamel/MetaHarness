import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.ts';
import { agentColors } from '../agentColors.ts';
import { ago } from '../format.ts';
import type { AreaChange, DesignArea, DesignChange, DesignFile, DesignReport, DesignScopeView, DesignSnapshot, DiffFile, Goal, GitView, MhEvent, ScopeSel, SnapshotInfo, SymbolRef } from '../types.ts';
import { activity, areaLabel, areaOf, hunksFor, insights, lanes, layers as layerRows, pinnedNotes, symbolEnd, treemap, type Activity, type Touch } from '../designData.ts';
import { MessageDialog } from '../components/Dialogs.tsx';
import { Hunks } from '../components/Diff.tsx';
import { Splitter } from '../components/Splitter.tsx';
import { useNow } from '../components/common.tsx';
import Systems, { type SystemsNav } from './Systems.tsx';

const CW = 230;
const CH = 180;
const LIVE_MS = 900_000;

/** Where the Design view is: what it looks at, the area open, and the agent it's focused on. Kept by the goal page, so it outlasts a tab switch. */
export interface DesignNav {
  scope?: ScopeSel;
  area?: string;
  focus?: string;
  /** Areas: the files and what changed; Systems: how the code runs. */
  lens?: 'areas' | 'systems';
  systems?: SystemsNav;
}

interface Props {
  goal: Goal;
  events: MhEvent[];
  nav: DesignNav;
  onNav: (n: DesignNav) => void;
  onCommand: (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onSelectAgent: (n: string) => void;
  onOpenCommit: (sha: string) => void;
}

interface Layers {
  change: boolean;
  deps: boolean;
  flows: boolean;
  hot: boolean;
  live: boolean;
  fade: boolean;
}

const LAYERS: [keyof Layers, string, string][] = [
  ['change', 'Change', 'Colour each area by how much this scope changed it, and name what changed'],
  ['deps', 'Dependencies', 'Arrows for which area imports which: new ones highlighted, lost ones dashed, circles flagged'],
  ['flows', 'Flows', "The paths data takes, from the map's Flows section"],
  ['hot', 'Hotspots', 'Files that changed often, by several agents, or that much depends on: the ones to watch'],
  ['live', 'Activity', 'Where each agent is reading and editing (the last 15 minutes while the goal runs)'],
  ['fade', 'Fade unchanged', 'Fade the areas this scope left alone'],
];
const LAYER_KEY = 'mh.design.layers';
const DEFAULT_LAYERS: Layers = { change: true, deps: true, flows: true, hot: false, live: true, fade: false };

function useLayers(): [Layers, (k: keyof Layers, v: boolean) => void] {
  const [l, setL] = useState<Layers>(() => {
    try {
      return { ...DEFAULT_LAYERS, ...JSON.parse(localStorage.getItem(LAYER_KEY) ?? '{}') };
    } catch {
      return DEFAULT_LAYERS;
    }
  });
  const set = (k: keyof Layers, v: boolean) =>
    setL(o => {
      const n = { ...o, [k]: v };
      try {
        localStorage.setItem(LAYER_KEY, JSON.stringify(n));
      } catch {
        // Kept for this visit only.
      }
      return n;
    });
  return [l, set];
}

const sameScope = (a: ScopeSel, b: ScopeSel) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The Design view (design §14), one screen for following the code as the team changes it.
 * Pick a scope in the bar at the top (the whole goal, a landing, an agent's branch, a commit);
 * the map shows the code's areas in layers (what the scope changed, dependencies, flows,
 * hotspots, live activity), and the inspector goes from an area to its files, their
 * definitions, and the diff of one definition.
 */
export default function Design({ goal, events, nav, onNav, onCommand, onSelectAgent, onOpenCommit }: Props) {
  const scope: ScopeSel = nav.scope ?? { kind: 'goal' };
  const [view, setView] = useState<DesignScopeView>();
  const [gitv, setGitv] = useState<GitView>();
  const [error, setError] = useState<string>();
  const [layers, setLayer] = useLayers();
  const [lit, setLit] = useState<string[]>();
  const [flow, setFlow] = useState<string>();
  const [file, setFile] = useState<string>();
  const [messaging, setMessaging] = useState<string>();
  const color = useMemo(() => agentColors(goal), [goal]);
  const now = useNow(5000);
  const running = goal.live && goal.status === 'running';

  // Commits and landings change what a moving scope (the goal, a branch) holds: read it again then.
  const marks = events.filter(e => e.type === 'git.commit' || e.type === 'git.merge' || e.type === 'git.landed' || e.type === 'design.changed').length;
  const moving = scope.kind === 'goal' || scope.kind === 'branch' ? marks : 0;
  const key = JSON.stringify(scope);
  useEffect(() => {
    let alive = true;
    api.designScope(goal.id, scope).then(
      v => alive && (setView(v), setError(undefined)),
      e => alive && setError((e as Error).message),
    );
    return () => {
      alive = false;
    };
    // The key stands for the scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.id, key, moving]);
  useEffect(() => {
    let alive = true;
    api.git(goal.id).then(v => alive && setGitv(v), () => {});
    return () => {
      alive = false;
    };
  }, [goal.id, marks]);

  const snap = view?.snapshot ?? undefined;
  const since = running ? now - LIVE_MS : 0;
  const act = useMemo(() => activity(events, snap, since), [events, snap, since]);
  const notes = useMemo(() => pinnedNotes(events), [events]);
  const found = useMemo(() => insights(events, snap), [events, snap]);
  const setScope = (s: ScopeSel) => (setFile(undefined), onNav({ ...nav, scope: s }));
  const setArea = (a?: string) => (setFile(undefined), onNav({ ...nav, area: a }));
  const setFocus = (f?: string) => onNav({ ...nav, focus: f });

  if (error && !view) return <div className="empty warn-text">{error}</div>;
  if (view && !view.snapshot) return <div className="empty">{view.note}</div>;
  if (!snap || !view) return <div className="empty">Reading the code…</div>;
  const area = nav.area !== undefined && (snap.map.areas.some(a => a.path === nav.area) || view.removedAreas?.some(a => a.path === nav.area)) ? nav.area : undefined;
  const lens = (
    <div className="seg" role="group" aria-label="Lens">
      <button className={`btn small${nav.lens !== 'systems' ? ' on' : ''}`} onClick={() => onNav({ ...nav, lens: 'areas' })} title="The code's areas and files, and what each scope changed in them">
        Areas
      </button>
      <button className={`btn small${nav.lens === 'systems' ? ' on' : ''}`} onClick={() => onNav({ ...nav, lens: 'systems' })} title="How the code runs: what calls, signals, creates and changes what">
        Systems
      </button>
    </div>
  );
  const scopeBar = <ScopeBar goal={goal} events={events} gitv={gitv} view={view} scope={scope} color={color} focus={nav.focus} onScope={setScope} onFocus={setFocus} />;
  if (nav.lens === 'systems') {
    return (
      <>
        {scopeBar}
        <Systems goal={goal} view={view} snap={snap} nav={nav.systems ?? {}} onNav={s => onNav({ ...nav, systems: s })} lens={lens} />
      </>
    );
  }

  return (
    <>
      {scopeBar}
      <div className="toolbar design-toolbar">
        {lens}
        <div className="layer-toggles" role="group" aria-label="Layers">
          {LAYERS.map(([k, label, title]) => (
            <label key={k} className={`layer-toggle${layers[k] ? ' on' : ''}`} title={title}>
              <input type="checkbox" checked={layers[k]} onChange={e => setLayer(k, e.target.checked)} />
              {k === 'live' && !running ? 'Activity (all)' : label}
            </label>
          ))}
        </div>
        <Legend goal={goal} color={color} act={act} report={view.report} focus={nav.focus} onFocus={setFocus} />
      </div>
      {error && <div className="notice-box warn">{error}</div>}
      <div className="design-body">
        <div className="view">
          <AreaMap
            snap={snap} view={view} act={act} notes={notes} color={color} layers={layers} selected={area} lit={lit} flow={flow} focus={nav.focus} now={now}
            onSelect={setArea}
          />
        </div>
        <Splitter pane="design-side" grow="left" min={280} max={820} label="Design panel" />
        <aside className="design-side">
          {area !== undefined ? (
            <AreaPanel
              goal={goal} snap={snap} view={view} area={area} act={act} layers={layers} color={color} file={file} focus={nav.focus}
              notes={notes.filter(n => n.path === area || (n.path && area.startsWith(n.path + '/')) || n.path === '')}
              onFile={setFile} onArea={setArea} onScope={setScope} onCommand={onCommand} onMessage={() => setMessaging(area)} onFocus={setFocus}
            />
          ) : (
            <ScopeSummary
              goal={goal} events={events} snap={snap} view={view} found={found} color={color} focus={nav.focus} flow={flow}
              onFlow={setFlow} onLit={setLit} onScope={setScope} onArea={setArea} onFile={(a, f) => (onNav({ ...nav, area: a }), setFile(f))} onFocus={setFocus}
              onSelectAgent={onSelectAgent} onOpenCommit={onOpenCommit}
            />
          )}
        </aside>
      </div>
      {messaging !== undefined && (
        <MessageDialog goal={goal} initial={`About ${areaLabel(messaging)}: `} onClose={() => setMessaging(undefined)} onSend={async b => !!(await onCommand(b))} />
      )}
    </>
  );
}

/* ---------------- the scope bar ---------------- */

const COL = 16;
const LH = 20;
const LAND = 18;

function landingsOf(list: SnapshotInfo[]): { n: number; sel: ScopeSel; s: SnapshotInfo }[] {
  return list.slice(1).map((s, i) => ({
    n: i + 1,
    s,
    sel: { kind: 'range', from: list[i].sha, to: s.sha, title: `Landing ${i + 1}${s.by?.length ? ` (${s.by.join(', ')})` : ''}${s.summaries?.length ? `: ${s.summaries.at(-1)}` : ''}` },
  }));
}

function ScopeBar({ goal, events, gitv, view, scope, color, focus, onScope, onFocus }: {
  goal: Goal;
  events: MhEvent[];
  gitv?: GitView;
  view: DesignScopeView;
  scope: ScopeSel;
  color: (n?: string) => string;
  focus?: string;
  onScope: (s: ScopeSel) => void;
  onFocus: (f?: string) => void;
}) {
  const branch = gitv?.git?.branch ?? goal.branch ?? 'goal branch';
  const model = useMemo(() => lanes(events, branch, (gitv?.branches ?? []).map(b => ({ name: b.name, agent: b.agent }))), [events, branch, gitv?.branches]);
  const inScope = useMemo(() => new Set(view.report?.commits.map(c => c.sha)), [view.report]);
  const lands = landingsOf(view.list);
  const scroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, [model.cols]);
  const x = (col: number) => 12 + col * COL;
  const y = (lane: number) => LAND + lane * LH + LH / 2;
  const cols = Math.max(model.cols, 1);
  const width = x(cols) + 12;
  const height = LAND + model.lanes.length * LH + 4;
  const anchor = scope.kind === 'commit' ? model.dots.find(d => d.sha === scope.sha) : undefined;
  const pick = (sha: string, shift: boolean) => {
    const d = model.dots.find(x => x.sha === sha)!;
    if (shift && anchor && anchor.sha !== sha) {
      const [a, b] = anchor.col < d.col ? [anchor, d] : [d, anchor];
      onScope({ kind: 'range', from: `${a.sha}^1`, to: b.sha, title: `${a.sha.slice(0, 7)} to ${b.sha.slice(0, 7)}` });
    } else onScope({ kind: 'commit', sha });
  };
  const landCol = (sha: string) => model.dots.find(d => d.sha === sha)?.col;
  const isGoal = scope.kind === 'goal';
  const landing = lands.find(l => sameScope(l.sel, scope));
  return (
    <div className="scope-bar">
      <div className="scope-head">
        <span className="kicker">Looking at</span>
        <button className={`btn small${isGoal ? ' on' : ''}`} onClick={() => onScope({ kind: 'goal', branches: isGoal ? scope.branches : false })} title="Everything the goal changed: its start against now">
          Whole goal
        </button>
        <label className="small" title="Also count the agents' committed work that hasn't been merged yet, as if it were">
          <input type="checkbox" checked={isGoal && !!scope.branches} onChange={e => onScope({ kind: 'goal', branches: e.target.checked })} /> with unmerged branches
        </label>
        <select
          className="small"
          value={landing ? String(landing.n) : ''}
          onChange={e => {
            const l = lands.find(x => String(x.n) === e.target.value);
            if (l) onScope(l.sel);
          }}
          aria-label="A landing"
        >
          <option value="">{lands.length ? `Landings (${lands.length})…` : 'No landings yet'}</option>
          {[...lands].reverse().map(l => (
            <option key={l.n} value={String(l.n)}>
              {l.n} · {l.s.by?.join(', ') || 'you'} · {(l.s.summaries?.at(-1) ?? '').slice(0, 70)} · {ago(l.s.at)}
            </option>
          ))}
        </select>
        <span className="scope-title ellipsis" title={view.scope?.title}>
          {view.scope?.title}
        </span>
        <span className="muted small nowrap">click a commit · shift-click another for a range · a lane for its branch</span>
      </div>
      <div className="lanes">
        <div className="lane-labels" style={{ paddingTop: LAND }}>
          {model.lanes.map((l, i) => {
            const on = i === 0 ? isGoal : scope.kind === 'branch' && scope.agent === l.agent;
            return (
              <button
                key={l.branch}
                className={`lane-label${on ? ' on' : ''}${focus && l.agent && focus !== l.agent ? ' faded' : ''}`}
                style={{ height: LH }}
                onClick={() => (i === 0 ? onScope({ kind: 'goal' }) : l.agent && (onScope({ kind: 'branch', agent: l.agent }), onFocus(l.agent)))}
                title={i === 0 ? `${l.branch}: the goal branch` : `${l.agent}'s branch: what it changed, and focus on ${l.agent}`}
              >
                <span className="swatch" style={{ background: i === 0 ? 'var(--text-2)' : color(l.agent) }} />
                <span className="ellipsis">{i === 0 ? l.branch : l.agent ?? l.branch.split('/').pop()}</span>
              </button>
            );
          })}
        </div>
        <div className="lane-scroll" ref={scroll}>
          <svg width={width} height={height} role="img" aria-label="Commits by branch">
            {model.lanes.map((l, i) => {
              const ds = model.dots.filter(d => d.lane === i);
              const on = i === 0 ? isGoal : scope.kind === 'branch' && scope.agent === l.agent;
              return (
                <g key={l.branch}>
                  {on && <rect x={0} y={LAND + i * LH} width={width} height={LH} fill="var(--accent-soft)" />}
                  {ds.length > 0 && <line x1={x(ds[0].col)} x2={x(ds.at(-1)!.col)} y1={y(i)} y2={y(i)} stroke={i === 0 ? 'var(--line-strong)' : color(l.agent)} strokeOpacity={i === 0 ? 1 : 0.45} strokeWidth={2} />}
                </g>
              );
            })}
            {model.links.map((k, i) => (
              <path
                key={i}
                d={`M${x(k.from[0])},${y(k.from[1])} C${x(k.from[0]) + COL / 2},${y(k.from[1])} ${x(k.to[0]) - COL / 2},${y(k.to[1])} ${x(k.to[0])},${y(k.to[1])}`}
                fill="none"
                stroke="var(--line-strong)"
                strokeWidth={1.5}
                strokeDasharray={k.ff ? '3 3' : undefined}
              />
            ))}
            {lands.map(l => {
              const c = landCol(l.s.sha);
              if (c === undefined) return null;
              const on = sameScope(l.sel, scope);
              return (
                <g key={l.n} className="lane-landing" onClick={() => onScope(l.sel)}>
                  <title>{`${l.sel.kind === 'range' ? l.sel.title : ''}\n${ago(l.s.at)}${l.s.change?.highlights.length ? '\n' + l.s.change.highlights.join('\n') : ''}`}</title>
                  <line x1={x(c)} x2={x(c)} y1={LAND - 4} y2={y(0)} stroke="var(--accent)" strokeOpacity={0.5} />
                  <rect x={x(c) - 5} y={3} width={10} height={10} transform={`rotate(45 ${x(c)} 8)`} fill={on ? 'var(--accent)' : 'var(--panel)'} stroke="var(--accent)" strokeWidth={1.5} />
                </g>
              );
            })}
            {model.dots.map(d => {
              const on = (scope.kind === 'commit' && scope.sha === d.sha) || inScope.has(d.sha);
              const sel = scope.kind === 'commit' && scope.sha === d.sha;
              const dim = focus && d.agent !== focus;
              return (
                <g key={d.sha} className="lane-dot" onClick={e => pick(d.sha, e.shiftKey)} opacity={dim ? 0.3 : 1}>
                  <title>{`${d.summary}\n${d.agent ?? 'unnamed (you?)'} · ${d.sha.slice(0, 7)}${d.added !== undefined ? ` · +${d.added} −${d.removed}` : ''}`}</title>
                  {on && <circle cx={x(d.col)} cy={y(d.lane)} r={sel ? 8 : 7} fill="none" stroke="var(--accent)" strokeWidth={sel ? 2.5 : 1.5} />}
                  <circle cx={x(d.col)} cy={y(d.lane)} r={5} fill={d.merge ? 'var(--panel)' : d.agent ? color(d.agent) : 'var(--text-3)'} stroke={d.agent ? color(d.agent) : 'var(--text-3)'} strokeWidth={2} />
                </g>
              );
            })}
          </svg>
          {!model.dots.length && <div className="empty small">No commits yet. They show here as agents make them.</div>}
        </div>
      </div>
    </div>
  );
}

/** Agents with their colour; click one to focus on what it did. Names always sit next to the colour. */
function Legend({ goal, color, act, report, focus, onFocus }: { goal: Goal; color: (n?: string) => string; act: Activity; report?: DesignReport; focus?: string; onFocus: (n?: string) => void }) {
  const busy = new Set([...act.files.values()].flatMap(t => [...t.edits.keys(), ...t.reads.keys(), ...t.commits.keys()]).concat(report?.totals.agents ?? []));
  const agents = goal.agents.filter(a => !a.quick);
  return (
    <div className="agent-legend" aria-label="Agents: click to focus">
      {agents.map(a => (
        <button
          key={a.name}
          className={`agent-legend-item${busy.has(a.name) ? '' : ' faded'}${focus === a.name ? ' on' : ''}`}
          onClick={() => onFocus(focus === a.name ? undefined : a.name)}
          title={focus === a.name ? 'Show everyone again' : `Focus on what ${a.name} (${a.role}) did`}
          aria-pressed={focus === a.name}
        >
          <span className="swatch" style={{ background: color(a.name) }} />
          {a.name}
          {focus === a.name && ' ✕'}
        </button>
      ))}
    </div>
  );
}

/* ---------------- the map ---------------- */

type AreaData = {
  area: DesignArea;
  files: number;
  symbols: number;
  touch?: Touch;
  ch?: AreaChange;
  heat: number;
  hot: number;
  defs: { sign: string; text: string }[];
  color: (n?: string) => string;
  layers: Layers;
  added: boolean;
  removed: boolean;
  rewritten: boolean;
  notes: number;
  collisions: number;
  working: boolean;
  on: boolean;
  lit: boolean;
  faded: boolean;
};

const BIG = ['class', 'interface', 'type', 'enum', 'module'];

/** The few definitions worth naming on a card: new and removed classes first, then the rest. */
function cardDefs(c: DesignChange | undefined, area: string): { sign: string; text: string }[] {
  if (!c) return [];
  const pick = (list: SymbolRef[], sign: string) => list.filter(s => s.area === area).map(s => ({ sign, text: `${s.kind} ${s.parent ? s.parent + '.' : ''}${s.name}`, big: BIG.includes(s.kind) || !s.parent }));
  const all = [...pick(c.symbols.added, '+'), ...pick(c.symbols.removed, '−'), ...pick(c.symbols.changed, '~')];
  return [...all.filter(d => d.big), ...all.filter(d => !d.big)].slice(0, 3);
}

function AreaMap({ snap, view, act, notes, color, layers, selected, lit, flow, focus, now, onSelect }: {
  snap: DesignSnapshot;
  view: DesignScopeView;
  act: Activity;
  notes: { path: string }[];
  color: (n?: string) => string;
  layers: Layers;
  selected?: string;
  lit?: string[];
  flow?: string;
  focus?: string;
  now: number;
  onSelect: (a?: string) => void;
}) {
  const change = view.change;
  const report = view.report;
  const { nodes, edges } = useMemo(() => {
    const byArea = new Map(report?.areas.map(a => [a.path, a]));
    // A folder the map leaves out shows when it holds code (a file a language pack reads), changed, or work is going on in it.
    const shown = snap.map.areas.filter(a => !a.unmapped || snap.files.some(f => f.area === a.path && f.lang) || byArea.has(a.path) || !!act.areas.get(a.path)?.edits.size);
    const gone = layers.change ? (view.removedAreas ?? []) : [];
    const areas = [...shown, ...gone];
    const paths = areas.map(a => a.path);
    const layer = layerRows(paths, [...snap.edges, ...(change?.edges.removed ?? [])]);
    const rows = new Map<number, string[]>();
    for (const p of [...paths].sort()) rows.set(layer.get(p)!, [...(rows.get(layer.get(p)!) ?? []), p]);
    const widest = Math.max(...[...rows.values()].map(r => r.length));
    const pos = new Map<string, { x: number; y: number }>();
    for (const [l, row] of rows) row.forEach((p, i) => pos.set(p, { x: (i + (widest - row.length) / 2) * (CW + 60), y: l * (CH + 70) }));
    const near = new Set(selected === undefined ? [] : [selected, ...snap.edges.filter(e => e.from === selected).map(e => e.to), ...snap.edges.filter(e => e.to === selected).map(e => e.from)]);
    const editors = new Map<string, number>();
    for (const [path, t] of act.files) if (t.edits.size > 1) editors.set(areaOf(snap.map.areas, path) ?? '', (editors.get(areaOf(snap.map.areas, path) ?? '') ?? 0) + 1);
    const maxChurn = Math.max(1, ...(report?.areas.map(a => a.added + a.removed) ?? []));
    const maxHot = Math.max(1, ...(report?.areas.map(a => a.hotspot) ?? []));
    const litSet = new Set(lit);
    const nodes: Node<AreaData>[] = areas.map(a => {
      const files = snap.files.filter(f => f.area === a.path);
      const t = layers.live ? act.areas.get(a.path) : undefined;
      const ch = byArea.get(a.path);
      const removed = gone.includes(a);
      const added = !!change?.areas.added.includes(a.path);
      const touchedByFocus = !focus || !!ch?.agents.some(x => x.name === focus) || !!act.areas.get(a.path)?.edits.has(focus);
      const untouched = layers.change && layers.fade && !ch && !added && !removed;
      return {
        id: a.path || '(top)',
        type: 'area',
        position: pos.get(a.path)!,
        data: {
          area: a, files: files.length, symbols: files.reduce((n, f) => n + (f.symbols?.length ?? 0), 0), touch: t, ch,
          heat: ch ? (ch.added + ch.removed) / maxChurn : 0, hot: ch ? ch.hotspot / maxHot : 0, defs: cardDefs(change, a.path), color, layers,
          added, removed, rewritten: !!change?.areas.rewritten.includes(a.path),
          notes: notes.filter(n => n.path === a.path || (n.path !== '' && a.path.startsWith(n.path + '/'))).length,
          collisions: editors.get(a.path) ?? 0, working: !!t && now - t.lastEdit < 30_000, on: selected === a.path, lit: litSet.has(a.path),
          faded: (selected !== undefined && !near.has(a.path)) || !touchedByFocus || untouched,
        },
      };
    });
    const id = (p: string) => p || '(top)';
    const edges: Edge[] = [];
    if (layers.deps) {
      const added = new Set(change?.edges.added.map(e => `${e.from}\n${e.to}`));
      const circle = new Set<string>();
      for (const c of report?.cycles ?? []) for (const e of snap.edges) if (c.areas.includes(e.from) && c.areas.includes(e.to)) circle.add(`${e.from}\n${e.to}`);
      for (const e of snap.edges) {
        if (!pos.has(e.from) || !pos.has(e.to)) continue;
        const k = `${e.from}\n${e.to}`;
        const isNew = layers.change && added.has(k);
        const inCycle = circle.has(k);
        const on = selected !== undefined && (e.from === selected || e.to === selected);
        const stroke = inCycle ? 'var(--waiting)' : isNew ? 'var(--accent)' : on ? 'var(--text-2)' : 'var(--line-strong)';
        edges.push({
          id: `${e.from}->${e.to}`, source: id(e.from), target: id(e.to), ...handlesFor(pos.get(e.from)!, pos.get(e.to)!, false),
          label: [isNew && 'new', inCycle && 'circular', String(e.n)].filter(Boolean).join(' · '),
          labelStyle: { fill: inCycle ? 'var(--waiting)' : 'var(--text-2)', fontSize: 11 }, labelBgStyle: { fill: 'var(--panel)' },
          style: { stroke, strokeWidth: isNew || inCycle ? 2.5 : on ? 2 : 1.25, opacity: selected !== undefined && !on ? 0.3 : 1 },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        });
      }
      if (layers.change) {
        for (const e of change?.edges.removed ?? []) {
          if (!pos.has(e.from) || !pos.has(e.to)) continue;
          edges.push({ id: `gone:${e.from}->${e.to}`, source: id(e.from), target: id(e.to), ...handlesFor(pos.get(e.from)!, pos.get(e.to)!, false), label: 'gone', labelStyle: { fill: 'var(--text-3)', fontSize: 11 }, labelBgStyle: { fill: 'var(--panel)' }, style: { stroke: 'var(--text-3)', strokeDasharray: '4 4', strokeWidth: 1.25 } });
        }
      }
    }
    if (layers.flows) {
      const unbacked = new Map(report?.flows.map(f => [f.name, new Set(f.unbacked.map(([a, b]) => `${a}\n${b}`))]));
      (snap.map.flows ?? []).forEach((f, fi) => {
        const steps = f.steps.filter(s => s.area !== undefined && pos.has(s.area));
        const on = flow === undefined || flow === f.name;
        for (let i = 1; i < steps.length; i++) {
          const [a, b] = [steps[i - 1].area!, steps[i].area!];
          if (a === b) continue;
          const weak = unbacked.get(f.name)?.has(`${a}\n${b}`);
          edges.push({
            id: `flow:${fi}:${i}`, source: id(a), target: id(b), ...handlesFor(pos.get(a)!, pos.get(b)!, true), animated: true,
            label: i === 1 ? f.name : weak ? 'no import' : undefined,
            labelStyle: { fill: 'var(--text)', fontSize: 11, fontWeight: 600 }, labelBgStyle: { fill: 'var(--panel)' },
            style: { stroke: weak ? 'var(--waiting)' : 'var(--text)', strokeWidth: flow === f.name ? 3 : 2, opacity: on ? 0.85 : 0.12 },
            markerEnd: { type: MarkerType.Arrow, color: 'var(--text)' },
          });
        }
      });
    }
    return { nodes, edges };
  }, [snap, view, act, notes, color, layers, selected, lit, flow, focus, now, change, report]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={(_, n) => onSelect(n.id === '(top)' ? '' : n.id)}
      onPaneClick={() => onSelect(undefined)}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      minZoom={0.15}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
    >
      <Background gap={20} size={1} color="var(--line)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function AreaCard({ data: d }: NodeProps<Node<AreaData>>) {
  const t = d.touch;
  const edits = t ? [...t.edits].sort((a, b) => b[1] - a[1]) : [];
  const ch = d.layers.change ? d.ch : undefined;
  const style: CSSProperties = {};
  if (ch && d.heat > 0) style.background = `color-mix(in srgb, var(--accent) ${Math.round(5 + d.heat * 25)}%, var(--panel))`;
  if (d.layers.hot && d.hot > 0) style.boxShadow = `0 0 0 ${Math.round(2 + d.hot * 5)}px color-mix(in srgb, var(--limited) ${Math.round(25 + d.hot * 40)}%, transparent), var(--shadow)`;
  const cls = ['area-card', d.area.unmapped && 'unmapped', d.on && 'on', d.faded && 'faded', d.working && 'working', d.lit && 'lit', d.removed && 'gone', d.layers.change && d.added && 'added'].filter(Boolean).join(' ');
  return (
    <div className={cls} style={style}>
      {/* Arrows leave and enter by the side they travel: down, up, or along a row (see handlesFor). */}
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Top} id="u" />
      <Handle type="target" position={Position.Top} id="ft" style={{ left: '75%' }} />
      <Handle type="source" position={Position.Top} id="fu" style={{ left: '25%' }} />
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Left} id="fl" />
      <div className="area-head">
        <span className="area-title ellipsis">{d.area.title}</span>
        {d.layers.change && d.added && <span className="pill done">new</span>}
        {d.removed && <span className="pill">removed</span>}
        {d.layers.change && d.rewritten && <span className="pill decision" title="Its description in the map changed">redescribed</span>}
        {d.layers.hot && d.ch && d.ch.hotspot > 0 && <span className="pill urgent" title="Its hottest file's score: churn, rework, several agents, dependants">🔥 {d.ch.hotspot}</span>}
        {d.notes > 0 && <span title={`${d.notes} pinned note${d.notes > 1 ? 's' : ''}`}>📌{d.notes > 1 ? d.notes : ''}</span>}
        {d.collisions > 0 && (
          <span className="warn-text" title={`${d.collisions} file${d.collisions > 1 ? 's' : ''} here edited by more than one agent`}>
            ⚠{d.collisions}
          </span>
        )}
      </div>
      <div className="mono muted small ellipsis">{d.area.path || '(top level)'}</div>
      <div className="area-summary">{d.area.summary || (d.area.unmapped ? 'Not in the map.' : '')}</div>
      {ch ? (
        <>
          <div className="area-stats small">
            <span className="diff-add">+{ch.added}</span> <span className="diff-del">−{ch.removed}</span>
            <span className="muted">
              {' '}
              · {ch.files} file{ch.files === 1 ? '' : 's'}
              {ch.commits > 0 && ` · ${ch.commits} commit${ch.commits === 1 ? '' : 's'}`}
            </span>
          </div>
          {ch.agents.length > 0 && (
            <div className="act-bar" aria-hidden>
              {ch.agents.map(a => (
                <span key={a.name} style={{ flexGrow: a.commits, background: d.color(a.name) }} />
              ))}
            </div>
          )}
          {d.defs.length > 0 && (
            <ul className="card-defs">
              {d.defs.map((x, i) => (
                <li key={i} className="ellipsis">
                  <span className={`def-sign ${x.sign === '+' ? 'add' : x.sign === '−' ? 'del' : ''}`}>{x.sign}</span> <span className="mono">{x.text}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="area-stats muted small">
          {d.files} file{d.files === 1 ? '' : 's'} · {d.symbols} definition{d.symbols === 1 ? '' : 's'}
        </div>
      )}
      {edits.length > 0 && (
        <div className="act-names small" title="Editing here (Activity layer)">
          <span className={`live-dot${d.working ? ' on' : ''}`} />
          {edits.slice(0, 3).map(([a, n]) => (
            <span key={a}>
              <span className="swatch" style={{ background: d.color(a) }} />
              {a} {n}
            </span>
          ))}
          {edits.length > 3 && <span className="muted">+{edits.length - 3}</span>}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="target" position={Position.Bottom} id="d" />
      <Handle type="source" position={Position.Bottom} id="fb" style={{ left: '75%' }} />
      <Handle type="target" position={Position.Bottom} id="fd" style={{ left: '25%' }} />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="target" position={Position.Right} id="fr" />
    </div>
  );
}

const NODE_TYPES = { area: AreaCard };

/** Which handles an arrow takes between two cards: dependencies by the middle, flows off to one side. */
function handlesFor(a: { x: number; y: number }, b: { x: number; y: number }, flow: boolean): { sourceHandle: string; targetHandle: string } {
  if (b.y > a.y) return flow ? { sourceHandle: 'fb', targetHandle: 'ft' } : { sourceHandle: 'b', targetHandle: 't' };
  if (b.y < a.y) return flow ? { sourceHandle: 'fu', targetHandle: 'fd' } : { sourceHandle: 'u', targetHandle: 'd' };
  return b.x > a.x ? { sourceHandle: 'r', targetHandle: 'l' } : { sourceHandle: 'fl', targetHandle: 'fr' };
}

/* ---------------- diffs, read when asked for ---------------- */

const diffs = new Map<string, Promise<DiffFile | undefined>>();

/** One file's diff over the scope, fetched once. */
function useFileDiff(goal: string, from: string | undefined, to: string | undefined, path: string, on: boolean): DiffFile | undefined | null {
  const [f, setF] = useState<DiffFile | undefined | null>(null);
  useEffect(() => {
    if (!on || !from || !to) return;
    let alive = true;
    const k = `${goal}\n${from}\n${to}\n${path}`;
    let p = diffs.get(k);
    if (!p) {
      p = api.diff(goal, { from, to, paths: [path] }).then(d => d.files.find(x => x.path === path) ?? d.files[0]);
      p.catch(() => diffs.delete(k));
      diffs.set(k, p);
    }
    p.then(x => alive && setF(x), () => alive && setF(undefined));
    return () => {
      alive = false;
    };
  }, [goal, from, to, path, on]);
  return f;
}

/** The part of a file's diff inside one definition (or the whole file's, without lines). */
function SymbolDiff({ goal, view, path, lines, side = 'new' }: { goal: string; view: DesignScopeView; path: string; lines?: [number, number]; side?: 'new' | 'old' }) {
  const f = useFileDiff(goal, view.scope?.from, view.scope?.to, path, true);
  if (f === null) return <div className="muted small">Reading the diff…</div>;
  if (!f) return <div className="muted small">No changes to this file in this scope.</div>;
  if (f.binary) return <div className="muted small">A binary file.</div>;
  const patch = lines ? hunksFor(f.patch, lines[0], lines[1], side) : f.patch;
  if (!patch) return <div className="muted small">Its lines didn't change here (it moved, or only what's around it did).</div>;
  return (
    <div className="inline-diff">
      <Hunks patch={patch} cut={!lines && f.cut} />
    </div>
  );
}

/* ---------------- the inspector: an area ---------------- */

function AreaPanel(p: {
  goal: Goal;
  snap: DesignSnapshot;
  view: DesignScopeView;
  area: string;
  act: Activity;
  layers: Layers;
  notes: { id: string; path: string; text: string; delivered: string[]; kept?: string }[];
  color: (n?: string) => string;
  file?: string;
  focus?: string;
  onFile: (f?: string) => void;
  onArea: (a?: string) => void;
  onScope: (s: ScopeSel) => void;
  onCommand: Props['onCommand'];
  onMessage: () => void;
  onFocus: (f?: string) => void;
}) {
  const { snap, view, area, act, color } = p;
  const a = snap.map.areas.find(x => x.path === area) ?? view.removedAreas?.find(x => x.path === area);
  const files = snap.files.filter(f => f.area === area);
  const fresh = [...act.fresh].filter(f => areaOf(snap.map.areas, f) === area);
  const t = act.areas.get(area);
  const ch = view.report?.areas.find(x => x.path === area);
  const uses = snap.edges.filter(e => e.from === area);
  const usedBy = snap.edges.filter(e => e.to === area);
  const commits = (view.report?.commits ?? []).filter(c => c.areas.includes(area) && (!p.focus || c.agent === p.focus));
  const c = view.change;
  const defs = c
    ? ([['+', c.symbols.added], ['~', c.symbols.changed], ['−', c.symbols.removed]] as const).flatMap(([sign, list]) => list.filter(s => s.area === area).map(s => ({ sign, s })))
    : [];
  const [openDef, setOpenDef] = useState<string>();
  const [text, setText] = useState('');
  const live = p.goal.live && p.goal.status !== 'ended';
  const current = p.file ? snap.files.find(f => f.path === p.file) : undefined;
  const removedFile = p.file && !current ? view.report?.files.find(f => f.path === p.file) : undefined;
  return (
    <div className="area-panel scroll">
      <div className="area-panel-head">
        <div>
          <div className="kicker">Area</div>
          <b>{a?.title ?? areaLabel(area)}</b> <span className="mono muted small">{area || '(top level)'}</span>
        </div>
        <button className="btn ghost small" onClick={() => p.onArea(undefined)} aria-label="Close">
          ✕
        </button>
      </div>
      {a?.unmapped && <div className="notice-box">The map (ARCHITECTURE.md) doesn't describe this part of the code.</div>}
      {view.removedAreas?.some(x => x.path === area) && <div className="notice-box">This area is gone in this scope.</div>}
      {a?.summary && <p className="area-text">{a.summary}</p>}
      <div className="row-wrap small">
        {uses.length > 0 && (
          <span>
            uses{' '}
            {uses.map((e, i) => (
              <span key={e.to}>
                {i > 0 && ', '}
                <button className="text-link mono" onClick={() => p.onArea(e.to)}>
                  {areaLabel(e.to)}
                </button>
              </span>
            ))}
          </span>
        )}
        {usedBy.length > 0 && (
          <span>
            used by{' '}
            {usedBy.map((e, i) => (
              <span key={e.from}>
                {i > 0 && ', '}
                <button className="text-link mono" onClick={() => p.onArea(e.from)}>
                  {areaLabel(e.from)}
                </button>
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="section-title">In this scope</div>
      {ch ? (
        <div className="small">
          <span className="diff-add">+{ch.added}</span> <span className="diff-del">−{ch.removed}</span> · {ch.files} file{ch.files === 1 ? '' : 's'} · {ch.commits} commit{ch.commits === 1 ? '' : 's'}
          {ch.agents.length > 0 && (
            <div className="area-who">
              {ch.agents.map(x => (
                <button key={x.name} className={`agent-legend-item${p.focus === x.name ? ' on' : ''}`} onClick={() => p.onFocus(p.focus === x.name ? undefined : x.name)} title="Focus on what it did">
                  <span className="swatch" style={{ background: color(x.name) }} />
                  {x.name} <span className="muted">{x.commits} commit{x.commits === 1 ? '' : 's'}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="muted small">Nothing changed here.</div>
      )}
      {defs.length > 0 && (
        <ul className="defs">
          {defs.slice(0, 40).map(({ sign, s }) => {
            const k = `${sign}${s.file}${s.kind}${s.parent ?? ''}${s.name}`;
            const f = snap.files.find(x => x.path === s.file);
            const end = symbolEnd(sign === '−' ? undefined : f, s);
            return (
              <li key={k}>
                <button className="def-row" onClick={() => setOpenDef(openDef === k ? undefined : k)} aria-expanded={openDef === k}>
                  <span className={`def-sign ${sign === '+' ? 'add' : sign === '−' ? 'del' : ''}`}>{sign}</span>
                  <span className="sym-kind">{s.kind}</span>
                  <span className="mono ellipsis">
                    {s.parent ? `${s.parent}.` : ''}
                    {s.name}
                  </span>
                  <span className="muted small ellipsis def-file">{s.file.split('/').pop()}</span>
                  <span className="muted">{openDef === k ? '▾' : '▸'}</span>
                </button>
                {openDef === k && <SymbolDiff goal={p.goal.id} view={view} path={s.file} lines={s.line && end ? [s.line, end] : undefined} side={sign === '−' ? 'old' : 'new'} />}
              </li>
            );
          })}
          {defs.length > 40 && <li className="muted small">and {defs.length - 40} more</li>}
        </ul>
      )}
      {commits.length > 0 && (
        <>
          <div className="section-title">Commits here</div>
          {commits.slice(0, 30).map(cm => (
            <CommitRow key={cm.sha} c={cm} color={color} onClick={() => p.onScope({ kind: 'commit', sha: cm.sha })} />
          ))}
        </>
      )}

      {t && (
        <>
          <div className="section-title">Activity</div>
          <div className="area-who">
            {[...new Set([...t.edits.keys(), ...t.commits.keys(), ...t.reads.keys()])].map(n => (
              <button key={n} className="agent-legend-item" onClick={() => p.onFocus(n)} title="Edits, commits and reads from tool calls">
                <span className="swatch" style={{ background: color(n) }} />
                {n} <span className="muted">{[t.edits.get(n) && `${t.edits.get(n)} edits`, t.commits.get(n) && `${t.commits.get(n)} commits`, t.reads.get(n) && `${t.reads.get(n)} reads`].filter(Boolean).join(', ')}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="section-title">Files</div>
      <FileMap files={files} fresh={fresh} act={act} report={view.report} layers={p.layers} color={color} selected={p.file} onSelect={p.onFile} />
      {current && <FileDetail goal={p.goal.id} snap={snap} view={view} file={current} act={act} color={color} onFile={f => (p.onArea(areaOf(snap.map.areas, f) ?? ''), p.onFile(f))} />}
      {removedFile && (
        <div className="file-detail">
          <div className="mono small">{removedFile.path}</div>
          <div className="muted small">Removed in this scope.</div>
          <SymbolDiff goal={p.goal.id} view={view} path={removedFile.path} />
        </div>
      )}

      <div className="section-title">Notes for agents working here</div>
      {p.notes.map(n => (
        <div key={n.id} className="pinned">
          <div>📌 {n.text}</div>
          <div className="sub">
            {n.path !== area && <>on {areaLabel(n.path)} · </>}
            {n.delivered.length ? `reached ${n.delivered.join(', ')}` : 'nobody has worked here since'}
            {n.kept && ` · kept as rule ${n.kept}`}
          </div>
          <div className="row-wrap">
            {!n.kept && (
              <button className="btn ghost small" onClick={() => void p.onCommand({ cmd: 'note.keep', goal: p.goal.id, id: n.id })} title="Save it as a rule, so agents working here get it in future goals too">
                Keep for future goals
              </button>
            )}
            {live && (
              <button className="btn ghost small" onClick={() => void p.onCommand({ cmd: 'note.remove', goal: p.goal.id, id: n.id })}>
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
      {live ? (
        <div className="pin-form">
          <textarea rows={2} value={text} onChange={e => setText(e.target.value)} placeholder={`A note each agent gets the first time it works in ${areaLabel(area)}`} aria-label="Note" />
          <div className="row-wrap">
            <button
              className="btn small"
              disabled={!text.trim()}
              onClick={async () => {
                if (await p.onCommand({ cmd: 'note.pin', goal: p.goal.id, path: area, text })) setText('');
              }}
            >
              📌 Pin
            </button>
            <button className="btn ghost small" onClick={p.onMessage}>
              ✉ Message about this area
            </button>
          </div>
        </div>
      ) : (
        !p.notes.length && <div className="empty">No notes.</div>
      )}
    </div>
  );
}

/** The area's files as a treemap, sized by bytes: tinted by how much the scope changed them (or who last edited them), ringed when hot. */
function FileMap({ files, fresh, act, report, layers, color, selected, onSelect }: { files: DesignFile[]; fresh: string[]; act: Activity; report?: DesignReport; layers: Layers; color: (n?: string) => string; selected?: string; onSelect: (f?: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  useLayoutEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const h = Math.max(120, Math.min(320, Math.round(Math.sqrt(files.length + fresh.length) * 60)));
  const changes = new Map(report?.files.map(f => [f.path, f]));
  const maxChurn = Math.max(1, ...files.map(f => changes.get(f.path)).filter(Boolean).map(f => f!.added + f!.removed));
  const maxScore = Math.max(1, ...(report?.files.map(f => f.score) ?? []));
  const items = [...files.map(f => ({ key: f.path, weight: Math.max(f.size, 200) })), ...fresh.map(f => ({ key: f, weight: 800 }))];
  const tiles = treemap(items, w, h);
  return (
    <div ref={box} className="treemap" style={{ height: h }}>
      {tiles.map(t => {
        const touch = act.files.get(t.key);
        const fc = changes.get(t.key);
        const by = layers.change ? (fc?.agents[0] ?? (fc ? undefined : touch?.lastEditBy)) : touch?.lastEditBy;
        const name = t.key.split('/').pop()!;
        const isFresh = fresh.includes(t.key);
        const style: CSSProperties = { left: t.x, top: t.y, width: Math.max(0, t.w - 2), height: Math.max(0, t.h - 2) };
        if (layers.change && fc && fc.added + fc.removed > 0) {
          const k = (fc.added + fc.removed) / maxChurn;
          style.background = `color-mix(in srgb, ${by ? color(by) : 'var(--accent)'} ${Math.round(14 + k * 40)}%, var(--panel))`;
        } else if (by) style.background = `color-mix(in srgb, ${color(by)} 22%, var(--panel))`;
        if (by) style.boxShadow = `inset 3px 0 0 ${color(by)}`;
        if (layers.hot && fc && fc.score > 0) style.outline = `${Math.round(1 + (fc.score / maxScore) * 3)}px solid var(--limited)`;
        return (
          <button
            key={t.key}
            className={`fm-tile${selected === t.key ? ' on' : ''}${isFresh ? ' fresh' : ''}`}
            style={style}
            onClick={() => onSelect(selected === t.key ? undefined : t.key)}
            title={[
              t.key,
              isFresh ? 'new, not committed yet' : '',
              fc ? `+${fc.added} −${fc.removed} in this scope${fc.commits ? `, ${fc.commits} commit${fc.commits === 1 ? '' : 's'}` : ''}${fc.agents.length ? ` by ${fc.agents.join(', ')}` : ''}` : '',
              fc?.reasons.length ? `hot: ${fc.reasons.join('; ')}` : '',
              touch?.lastEditBy ? `last edited by ${touch.lastEditBy}` : '',
              touch && touch.edits.size > 1 ? `edited by ${[...touch.edits.keys()].join(', ')}` : '',
            ].filter(Boolean).join('\n')}
          >
            {t.w > 46 && t.h > 18 && <span className="fm-name">{name}</span>}
            {t.w > 60 && t.h > 34 && (fc ? <span className="fm-by">+{fc.added} −{fc.removed}</span> : by && <span className="fm-by">{by}</span>)}
          </button>
        );
      })}
      {!tiles.length && <div className="empty">No files.</div>}
    </div>
  );
}

function FileDetail({ goal, snap, view, file, act, color, onFile }: { goal: string; snap: DesignSnapshot; view: DesignScopeView; file: DesignFile; act: Activity; color: (n?: string) => string; onFile: (f: string) => void }) {
  const change = view.change;
  const mark = (s: { name: string; kind: string; parent?: string }) => {
    const same = (x: SymbolRef) => x.file === file.path && x.name === s.name && x.kind === s.kind && x.parent === s.parent;
    return change?.symbols.added.some(same) ? 'added' : change?.symbols.changed.some(same) ? 'changed' : undefined;
  };
  const removed = change?.symbols.removed.filter(s => s.file === file.path) ?? [];
  const importedBy = snap.files.filter(f => f.imports?.includes(file.path)).map(f => f.path);
  const t = act.files.get(file.path);
  const fc = view.report?.files.find(f => f.path === file.path);
  const [open, setOpen] = useState<string>();
  return (
    <div className="file-detail">
      <div className="mono small">{file.path}</div>
      <div className="muted small">
        {file.lang ?? 'no language pack'} · {(file.size / 1024).toFixed(1)} KB
        {t && t.edits.size > 0 && (
          <>
            {' · edited by '}
            {[...t.edits].map(([a, n]) => (
              <span key={a} className="nowrap">
                <span className="swatch" style={{ background: color(a) }} />
                {a} {n}{' '}
              </span>
            ))}
          </>
        )}
      </div>
      {fc && (
        <div className="small">
          <span className="diff-add">+{fc.added}</span> <span className="diff-del">−{fc.removed}</span> in this scope
          {fc.commits > 0 && ` · ${fc.commits} commit${fc.commits === 1 ? '' : 's'} (${fc.churn} lines along the way)`}
          {fc.reasons.length > 0 && <div className="warn-text">🔥 {fc.reasons.join('; ')}</div>}
          <div>
            <button className="text-link" onClick={() => setOpen(open === '*' ? undefined : '*')} aria-expanded={open === '*'}>
              {open === '*' ? '▾' : '▸'} the file's diff
            </button>
          </div>
          {open === '*' && <SymbolDiff goal={goal} view={view} path={file.path} />}
        </div>
      )}
      {!!file.symbols?.length && (
        <ul className="symbols">
          {file.symbols.map((s, i) => {
            const m = mark(s);
            const k = `${i}`;
            return (
              <li key={i} className={m} style={{ paddingLeft: s.parent ? 16 : 0 }}>
                {m ? (
                  <button className="def-row" onClick={() => setOpen(open === k ? undefined : k)} aria-expanded={open === k}>
                    <span className="sym-kind">{s.kind}</span> <span className="mono">{s.name}</span>
                    <span className="pill decision">{m}</span>
                    <span className="muted small"> :{s.line}</span>
                    <span className="muted">{open === k ? '▾' : '▸'}</span>
                  </button>
                ) : (
                  <>
                    <span className="sym-kind">{s.kind}</span> <span className="mono">{s.name}</span>
                    <span className="muted small"> :{s.line}</span>
                  </>
                )}
                {open === k && <SymbolDiff goal={goal} view={view} path={file.path} lines={[s.line, symbolEnd(file, s) ?? s.line]} />}
              </li>
            );
          })}
          {removed.map((s, i) => {
            const k = `r${i}`;
            return (
              <li key={k} className="removed">
                <button className="def-row" onClick={() => setOpen(open === k ? undefined : k)} aria-expanded={open === k}>
                  <span className="sym-kind">{s.kind}</span> <span className="mono">{s.name}</span> <span className="pill">removed</span>
                  <span className="muted">{open === k ? '▾' : '▸'}</span>
                </button>
                {open === k && <SymbolDiff goal={goal} view={view} path={file.path} lines={s.line ? [s.line, symbolEnd(undefined, s)!] : undefined} side="old" />}
              </li>
            );
          })}
        </ul>
      )}
      {!!file.imports?.length && (
        <div className="small">
          uses{' '}
          {file.imports.map((f, i) => (
            <span key={f}>
              {i > 0 && ', '}
              <button className="text-link mono" onClick={() => onFile(f)}>
                {f}
              </button>
            </span>
          ))}
        </div>
      )}
      {importedBy.length > 0 && (
        <div className="small">
          used by{' '}
          {importedBy.map((f, i) => (
            <span key={f}>
              {i > 0 && ', '}
              <button className="text-link mono" onClick={() => onFile(f)}>
                {f}
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CommitRow({ c, color, onClick, onHover }: { c: DesignReport['commits'][number]; color: (n?: string) => string; onClick: () => void; onHover?: (areas?: string[]) => void }) {
  return (
    <button className="history-row" onClick={onClick} onMouseEnter={() => onHover?.(c.areas)} onMouseLeave={() => onHover?.(undefined)} onFocus={() => onHover?.(c.areas)} onBlur={() => onHover?.(undefined)} title="Look at this commit">
      <span className="swatch" style={{ background: c.agent ? color(c.agent) : 'var(--text-3)' }} />
      <span className="grow">
        {c.merge && <span className="pill">merge</span>} {c.summary}
        <span className="sub">
          {c.agent ?? 'unnamed (you?)'} · <span className="mono">{c.sha.slice(0, 7)}</span> · <span className="diff-add">+{c.added}</span> <span className="diff-del">−{c.removed}</span> · {c.areas.map(areaLabel).join(', ')}
        </span>
      </span>
    </button>
  );
}

/* ---------------- the inspector: the scope ---------------- */

function ScopeSummary({ goal, events, snap, view, found, color, focus, flow, onFlow, onLit, onScope, onArea, onFile, onFocus, onSelectAgent, onOpenCommit }: {
  goal: Goal;
  events: MhEvent[];
  snap: DesignSnapshot;
  view: DesignScopeView;
  found: ReturnType<typeof insights>;
  color: (n?: string) => string;
  focus?: string;
  flow?: string;
  onFlow: (f?: string) => void;
  onLit: (a?: string[]) => void;
  onScope: (s: ScopeSel) => void;
  onArea: (a: string) => void;
  onFile: (area: string, file: string) => void;
  onFocus: (f?: string) => void;
  onSelectAgent: (n: string) => void;
  onOpenCommit: (sha: string) => void;
}) {
  const r = view.report;
  const mine = (agents: string[]) => !focus || agents.includes(focus);
  const commits = (r?.commits ?? []).filter(c => !focus || c.agent === focus);
  const files = new Map(r?.files.map(f => [f.path, f]));
  const hot = (r?.hotspots ?? []).map(p => files.get(p)!).filter(f => f && mine(f.agents)).slice(0, 8);
  const mapFile = snap.map.file ?? 'ARCHITECTURE.md';
  const mapCommits = events.filter(e => e.type === 'git.commit' && (e.data.paths as string[] | undefined)?.includes(mapFile)).reverse();
  const flows = snap.map.flows ?? [];
  const agent = focus ? goal.agents.find(a => a.name === focus) : undefined;
  return (
    <div className="area-panel scroll">
      <div className="kicker">This scope</div>
      <b>{view.scope?.title}</b>
      {r && (
        <div className="small">
          {r.totals.commits} commit{r.totals.commits === 1 ? '' : 's'} · {r.totals.files} file{r.totals.files === 1 ? '' : 's'} · <span className="diff-add">+{r.totals.added}</span> <span className="diff-del">−{r.totals.removed}</span>
          {r.totals.agents.length > 0 && ' · by '}
          {r.totals.agents.map(n => (
            <button key={n} className={`agent-legend-item${focus === n ? ' on' : ''}`} onClick={() => onFocus(focus === n ? undefined : n)}>
              <span className="swatch" style={{ background: color(n) }} />
              {n}
            </button>
          ))}
        </div>
      )}
      {!!view.scope?.conflicts.length && (
        <div className="notice-box warn">
          ⚠ Merged as a picture, these branches conflict in {view.scope.conflicts.slice(0, 6).join(', ')}
          {view.scope.conflicts.length > 6 && ` and ${view.scope.conflicts.length - 6} more`}: those files show with conflict markers.
        </div>
      )}
      {focus && (
        <div className="focus-box">
          <span className="swatch" style={{ background: color(focus) }} />
          <span className="grow">
            Focused on <b>{focus}</b>
            {agent && <span className="muted"> · {agent.role}</span>}
          </span>
          {agent?.worktree && (
            <button className="btn ghost small" onClick={() => onScope({ kind: 'branch', agent: focus })}>
              Its branch
            </button>
          )}
          <button className="btn ghost small" onClick={() => onSelectAgent(focus)}>
            Open
          </button>
          <button className="btn ghost small" onClick={() => onFocus(undefined)} aria-label="Stop focusing">
            ✕
          </button>
        </div>
      )}
      {view.change && (
        <>
          <div className="section-title">What changed in the design</div>
          <ChangeList change={view.change} keep={s => mine(files.get(s.file)?.agents ?? [])} onArea={onArea} />
        </>
      )}
      <div className="section-title">Commits{focus && ` by ${focus}`}</div>
      {commits.slice(0, 60).map(c => (
        <CommitRow key={c.sha} c={c} color={color} onHover={onLit} onClick={() => onScope({ kind: 'commit', sha: c.sha })} />
      ))}
      {commits.length > 60 && <div className="muted small">and {commits.length - 60} more</div>}
      {!commits.length && <div className="muted small">None in this scope.</div>}
      {view.scope?.kind === 'commit' && (
        <button className="text-link small" onClick={() => onOpenCommit(view.scope!.to)}>
          Open this commit in the Git tab
        </button>
      )}
      <div className="section-title">Hotspots</div>
      {hot.map(f => (
        <button key={f.path} className="history-row" onClick={() => onFile(f.area, f.path)} onMouseEnter={() => onLit([f.area])} onMouseLeave={() => onLit(undefined)}>
          <span className="pill urgent">🔥 {f.score}</span>
          <span className="grow">
            <span className="mono">{f.path}</span>
            <span className="sub">
              <span className="diff-add">+{f.added}</span> <span className="diff-del">−{f.removed}</span>
              {f.reasons.length ? ` · ${f.reasons.join('; ')}` : ''}
            </span>
          </span>
        </button>
      ))}
      {!hot.length && <div className="muted small">Nothing stands out.</div>}
      {!!r?.cycles.length && (
        <>
          <div className="section-title">Circular dependencies</div>
          <ul className="changes small">
            {r.cycles.map(c => (
              <li key={c.areas.join()}>
                {c.new && <span className="pill warn">new</span>}{' '}
                {c.areas.map((a, i) => (
                  <span key={a}>
                    {i > 0 && ' ⇄ '}
                    <button className="text-link mono" onClick={() => onArea(a)}>
                      {areaLabel(a)}
                    </button>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="section-title">Flows</div>
      {flows.map(f => {
        const check = r?.flows.find(x => x.name === f.name);
        return (
          <button key={f.name} className={`history-row${flow === f.name ? ' on' : ''}`} onClick={() => onFlow(flow === f.name ? undefined : f.name)} title="Show this flow on the map">
            <span className="flow-mark" />
            <span className="grow">
              <b>{f.name}</b>
              <span className="sub">{f.steps.map(s => s.label.replace(/`/g, '')).join(' → ')}</span>
              {f.text && <span className="sub">{f.text}</span>}
              {!!check?.unknown.length && <span className="sub warn-text">names no area: {check.unknown.join(', ')}</span>}
              {!!check?.unbacked.length && <span className="sub warn-text">no import between {check.unbacked.map(([a, b]) => `${areaLabel(a)} and ${areaLabel(b)}`).join('; ')}</span>}
            </span>
          </button>
        );
      })}
      {!flows.length && <div className="muted small">The map declares no flows. A "## Flows" section in {mapFile} lists them, one per line: `- Checkout: src/api/ → src/orders/ → src/store/ — what moves`. The cartographer keeps it.</div>}
      <details className="more">
        <summary className="section-title">The map, its history, and findings for next time</summary>
        {snap.map.overview && <p className="area-text">{snap.map.overview}</p>}
        {!snap.map.file && <div className="notice-box">There's no ARCHITECTURE.md, so the areas are the folders. The map-bootstrap workflow can write one.</div>}
        {mapCommits.map(e => (
          <button key={e.seq} className="history-row" onClick={() => onScope({ kind: 'commit', sha: String(e.data.sha) })} title="Look at this commit">
            <span className="swatch" style={{ background: color(e.agent) }} />
            <span>
              {String(e.data.summary)}
              <span className="sub">
                {e.agent ?? 'unnamed'} · {ago(e.ts)}
              </span>
            </span>
          </button>
        ))}
        <ul className="insights small">
          {found.collisions.length > 0 && (
            <li>
              <b>{found.collisions.length}</b> file{found.collisions.length > 1 ? 's' : ''} edited by more than one agent:{' '}
              {found.collisions.slice(0, 6).map(c => (
                <span key={c.path} className="mono nowrap" title={c.agents.join(', ')}>
                  {c.path}{' '}
                </span>
              ))}
            </li>
          )}
          {found.conflicts.length > 0 && (
            <li>
              <b>{found.conflicts.length}</b> merge conflict{found.conflicts.length > 1 ? 's' : ''}, in {[...new Set(found.conflicts.flatMap(c => c.files))].slice(0, 6).join(', ')}
            </li>
          )}
          {found.rework.length > 0 && <li>Reworked (3+ commits): {found.rework.slice(0, 5).map(x => `${x.path} ×${x.commits}`).join(', ')}</li>}
          {found.spread.length > 0 && (
            <li>
              Areas each agent edited in:{' '}
              {found.spread.map(s => (
                <button key={s.agent} className="text-link" onClick={() => onFocus(s.agent)}>
                  {s.agent} {s.areas}
                </button>
              ))}
            </li>
          )}
          {found.rules.length > 0 && <li>Rules that fired: {found.rules.map(x => `${x.rule} ×${x.n}`).join(', ')}</li>}
          {found.notes.pinned > 0 && <li>Your notes: {found.notes.pinned} pinned, delivered {found.notes.delivered} times</li>}
          {!found.collisions.length && !found.conflicts.length && !found.rework.length && !found.rules.length && <li className="muted">Nothing yet.</li>}
        </ul>
        {snap.skipped > 0 && <div className="muted small">{snap.skipped} files weren't read (too many, or too large).</div>}
        {snap.problems.map(pr => (
          <div key={pr} className="warn-text small">
            {pr}
          </div>
        ))}
        <div className="muted small">
          The design after this scope: {snap.sha.slice(0, 7)}. Each landing's report is kept in the goal's design/reports folder.
        </div>
      </details>
    </div>
  );
}

function ChangeList({ change: c, keep, onArea }: { change: DesignChange; keep: (s: SymbolRef) => boolean; onArea: (a: string) => void }) {
  const lines: { key: string; text: string; area?: string }[] = [
    ...c.areas.added.map(a => ({ key: `aa${a}`, text: `New area ${areaLabel(a)}`, area: a })),
    ...c.areas.removed.map(a => ({ key: `ar${a}`, text: `Area ${areaLabel(a)} is gone`, area: a })),
    ...c.areas.rewritten.map(a => ({ key: `aw${a}`, text: `${areaLabel(a)} described anew in the map`, area: a })),
    ...c.edges.added.map(e => ({ key: `ea${e.from}${e.to}`, text: `${areaLabel(e.from)} now uses ${areaLabel(e.to)}`, area: e.from })),
    ...c.edges.removed.map(e => ({ key: `er${e.from}${e.to}`, text: `${areaLabel(e.from)} no longer uses ${areaLabel(e.to)}`, area: e.from })),
    ...c.symbols.added.filter(s => (BIG.includes(s.kind) || !s.parent) && keep(s)).slice(0, 12).map(s => ({ key: `sa${s.file}${s.name}`, text: `+ ${s.kind} ${s.name} (${s.file})`, area: s.area })),
    ...c.symbols.removed.filter(s => (BIG.includes(s.kind) || !s.parent) && keep(s)).slice(0, 8).map(s => ({ key: `sr${s.file}${s.name}`, text: `− ${s.kind} ${s.name} (${s.file})`, area: s.area })),
  ];
  const more = c.symbols.changed.filter(keep).length;
  return (
    <ul className="changes small">
      {lines.map(l => (
        <li key={l.key}>{l.area !== undefined ? <button className="text-link" onClick={() => onArea(l.area!)}>{l.text}</button> : l.text}</li>
      ))}
      <li className="muted">
        {c.files.added.length} files added, {c.files.changed.length} changed, {c.files.removed.length} removed{more ? `; ${more} definitions changed` : ''}
      </li>
    </ul>
  );
}
