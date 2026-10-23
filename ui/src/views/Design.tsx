import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.ts';
import { agentColors } from '../agentColors.ts';
import { ago } from '../format.ts';
import type { DesignChange, DesignFile, DesignSnapshot, DesignView, Goal, MhEvent, SnapshotInfo } from '../types.ts';
import { activity, areaLabel, areaOf, insights, layers, pinnedNotes, treemap, type Activity, type Touch } from '../designData.ts';
import { MessageDialog } from '../components/Dialogs.tsx';
import { Splitter } from '../components/Splitter.tsx';
import { useNow } from '../components/common.tsx';

const CW = 220;
const CH = 170;
const WINDOWS: [string, number][] = [
  ['last 5 min', 300_000],
  ['last 15 min', 900_000],
  ['last hour', 3_600_000],
  ['all', Infinity],
];
type CompareMode = 'previous' | 'start' | 'off';

interface Props {
  goal: Goal;
  events: MhEvent[];
  onCommand: (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onSelectAgent: (n: string) => void;
  onOpenCommit: (sha: string) => void;
}

/**
 * The Design view (design §14): the code as areas from the map, the dependencies between them,
 * and where each agent is working, coloured by agent. A timeline of snapshots (the goal's start,
 * each time work landed) shows how the design moved; comparing two says what changed. Click an
 * area for its files, their classes and functions, and the notes you've pinned on it.
 */
export default function Design({ goal, events, onCommand, onSelectAgent, onOpenCommit }: Props) {
  const live = goal.live && goal.status !== 'ended';
  const [view, setView] = useState<DesignView>();
  const [error, setError] = useState<string>();
  const [at, setAt] = useState<string>();
  const [mode, setMode] = useState<CompareMode>('previous');
  const [change, setChange] = useState<DesignChange>();
  const [win, setWin] = useState(live && goal.status === 'running' ? 900_000 : Infinity);
  const [area, setArea] = useState<string>();
  const [file, setFile] = useState<string>();
  const [messaging, setMessaging] = useState<string>();
  const color = useMemo(() => agentColors(goal), [goal]);
  const now = useNow(5000);

  // A new snapshot is announced in the log; read the timeline again then.
  const marks = events.filter(e => e.type === 'design.changed' || e.type === 'git.landed').length;
  useEffect(() => {
    let alive = true;
    api.design(goal.id, at).then(
      v => alive && (setView(v), setError(undefined)),
      e => alive && setError((e as Error).message),
    );
    return () => {
      alive = false;
    };
  }, [goal.id, at, marks]);

  const list = view?.list ?? [];
  const snap = view?.snapshot ?? undefined;
  const idx = snap ? list.findIndex(i => i.sha === snap.sha) : -1;
  const base = idx > 0 ? (mode === 'start' ? list[0] : mode === 'previous' ? list[idx - 1] : undefined) : undefined;
  useEffect(() => {
    let alive = true;
    setChange(undefined);
    if (base && snap) api.designCompare(goal.id, base.sha, snap.sha).then(c => alive && setChange(c), () => {});
    return () => {
      alive = false;
    };
  }, [goal.id, base?.sha, snap?.sha]);

  const since = win === Infinity ? 0 : now - win;
  const act = useMemo(() => activity(events, snap, since), [events, snap, since]);
  const notes = useMemo(() => pinnedNotes(events), [events]);
  const found = useMemo(() => insights(events, snap), [events, snap]);

  if (error) return <div className="empty warn-text">{error}</div>;
  if (view && !view.snapshot) return <div className="empty">{view.note}</div>;
  if (!snap) return <div className="empty">Reading the code…</div>;
  const atLatest = idx === list.length - 1 || idx < 0;

  return (
    <>
      <div className="toolbar design-toolbar">
        <div className="design-timeline" role="tablist" aria-label="Design snapshots">
          {list.map((s, i) => (
            <button key={s.sha} role="tab" aria-selected={i === idx} className={`snap${i === idx ? ' on' : ''}`} onClick={() => setAt(i === list.length - 1 ? undefined : s.sha)} title={snapTitle(s)}>
              <span className="snap-dot" />
              {i === 0 ? 'start' : `${i}`}
            </button>
          ))}
          {idx < 0 && <span className="snap on">now</span>}
          {view?.tip && list.at(-1)?.sha !== view.tip && idx >= 0 && (
            <button className="snap" onClick={() => setAt('now')} title="The goal branch as it is now, before the next snapshot">
              now
            </button>
          )}
        </div>
        <label className="small">
          Changes{' '}
          <select value={mode} onChange={e => setMode(e.target.value as CompareMode)}>
            <option value="previous">since the snapshot before</option>
            <option value="start">since the goal started</option>
            <option value="off">off</option>
          </select>
        </label>
        <label className="small">
          Activity{' '}
          <select value={String(win)} onChange={e => setWin(Number(e.target.value))}>
            {WINDOWS.map(([l, ms]) => (
              <option key={l} value={String(ms)}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <Legend goal={goal} color={color} act={act} onSelect={onSelectAgent} />
      </div>
      {!atLatest && <div className="notice-box">You're looking at an earlier snapshot. Activity is shown on its areas.</div>}
      <div className="design-body">
        <div className="view">
          <AreaMap snap={snap} act={act} change={change} notes={notes} color={color} selected={area} now={now} onSelect={a => (setArea(a), setFile(undefined))} />
        </div>
        <Splitter pane="design-side" grow="left" min={260} max={760} label="Design panel" />
        <aside className="design-side">
          {area !== undefined ? (
            <AreaPanel
              goal={goal}
              snap={snap}
              area={area}
              act={act}
              change={change}
              notes={notes.filter(n => n.path === area || (n.path && area.startsWith(n.path + '/')) || n.path === '')}
              color={color}
              file={file}
              onFile={setFile}
              onArea={a => (setArea(a), setFile(undefined))}
              onClose={() => setArea(undefined)}
              onCommand={onCommand}
              onMessage={() => setMessaging(area)}
              onSelectAgent={onSelectAgent}
            />
          ) : (
            <History goal={goal} events={events} list={list} snap={snap} change={change} found={found} color={color} onAt={sha => setAt(sha === list.at(-1)?.sha ? undefined : sha)} onOpenCommit={onOpenCommit} onArea={setArea} onSelectAgent={onSelectAgent} />
          )}
        </aside>
      </div>
      {messaging !== undefined && (
        <MessageDialog goal={goal} initial={`About ${areaLabel(messaging)}: `} onClose={() => setMessaging(undefined)} onSend={async b => !!(await onCommand(b))} />
      )}
    </>
  );
}

function snapTitle(s: SnapshotInfo): string {
  const head = s.kind === 'start' ? 'When the goal started' : `Work landed${s.by?.length ? ` (${s.by.join(', ')})` : ''}`;
  return [head + ` · ${ago(s.at)}`, ...(s.summaries ?? []).slice(-5), ...(s.change?.highlights ?? [])].join('\n');
}

/** Agents with their colour, the ones working here first. Names always sit next to the colour. */
function Legend({ goal, color, act, onSelect }: { goal: Goal; color: (n?: string) => string; act: Activity; onSelect: (n: string) => void }) {
  const busy = new Set([...act.files.values()].flatMap(t => [...t.edits.keys(), ...t.reads.keys(), ...t.commits.keys()]));
  const agents = goal.agents.filter(a => !a.quick);
  return (
    <div className="agent-legend" aria-label="Agents">
      {agents.map(a => (
        <button key={a.name} className={`agent-legend-item${busy.has(a.name) ? '' : ' faded'}`} onClick={() => onSelect(a.name)} title={`${a.name} · ${a.role}`}>
          <span className="swatch" style={{ background: color(a.name) }} />
          {a.name}
        </button>
      ))}
    </div>
  );
}

type AreaData = {
  area: DesignSnapshot['map']['areas'][number];
  files: number;
  symbols: number;
  touch?: Touch;
  color: (n?: string) => string;
  added: boolean;
  rewritten: boolean;
  delta?: { files: number; symbols: number };
  notes: number;
  collisions: number;
  hot: boolean;
  on: boolean;
  faded: boolean;
};

function AreaMap({ snap, act, change, notes, color, selected, now, onSelect }: { snap: DesignSnapshot; act: Activity; change?: DesignChange; notes: { path: string }[]; color: (n?: string) => string; selected?: string; now: number; onSelect: (a?: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    // A folder the map leaves out shows when it holds code (a file a language pack reads) or work is going on in it.
    const areas = snap.map.areas.filter(a => !a.unmapped || snap.files.some(f => f.area === a.path && f.lang) || !!act.areas.get(a.path)?.edits.size);
    const paths = areas.map(a => a.path);
    const layer = layers(paths, snap.edges);
    const rows = new Map<number, string[]>();
    for (const p of [...paths].sort()) rows.set(layer.get(p)!, [...(rows.get(layer.get(p)!) ?? []), p]);
    const widest = Math.max(...[...rows.values()].map(r => r.length));
    const pos = new Map<string, { x: number; y: number }>();
    for (const [l, row] of rows) row.forEach((p, i) => pos.set(p, { x: (i + (widest - row.length) / 2) * (CW + 36), y: l * (CH + 64) }));
    const near = new Set(selected === undefined ? [] : [selected, ...snap.edges.filter(e => e.from === selected).map(e => e.to), ...snap.edges.filter(e => e.to === selected).map(e => e.from)]);
    const editors = new Map<string, number>();
    for (const [path, t] of act.files) if (t.edits.size > 1) editors.set(areaOf(snap.map.areas, path) ?? '', (editors.get(areaOf(snap.map.areas, path) ?? '') ?? 0) + 1);
    const delta = (p: string) => {
      if (!change) return undefined;
      const f = [...change.files.added, ...change.files.removed, ...change.files.changed].filter(x => areaOf(snap.map.areas, x) === p).length;
      const s = [...change.symbols.added, ...change.symbols.removed, ...change.symbols.changed].filter(x => x.area === p).length;
      return f || s ? { files: f, symbols: s } : undefined;
    };
    const nodes: Node<AreaData>[] = areas.map(a => {
      const files = snap.files.filter(f => f.area === a.path);
      const t = act.areas.get(a.path);
      return {
        id: a.path || '(top)',
        type: 'area',
        position: pos.get(a.path)!,
        data: {
          area: a, files: files.length, symbols: files.reduce((n, f) => n + (f.symbols?.length ?? 0), 0), touch: t, color,
          added: !!change?.areas.added.includes(a.path), rewritten: !!change?.areas.rewritten.includes(a.path), delta: delta(a.path),
          notes: notes.filter(n => n.path === a.path || (n.path !== '' && a.path.startsWith(n.path + '/'))).length,
          collisions: editors.get(a.path) ?? 0, hot: !!t && now - t.lastEdit < 30_000, on: selected === a.path, faded: selected !== undefined && !near.has(a.path),
        },
      };
    });
    const id = (p: string) => p || '(top)';
    const added = new Set(change?.edges.added.map(e => `${e.from}\n${e.to}`));
    const edges: Edge[] = snap.edges
      .filter(e => pos.has(e.from) && pos.has(e.to))
      .map(e => {
        const isNew = added.has(`${e.from}\n${e.to}`);
        const lit = selected !== undefined && (e.from === selected || e.to === selected);
        const stroke = isNew ? 'var(--accent)' : lit ? 'var(--text-2)' : 'var(--line-strong)';
        return {
          id: `${e.from}->${e.to}`, source: id(e.from), target: id(e.to), label: isNew ? `new · ${e.n}` : String(e.n),
          labelStyle: { fill: 'var(--text-2)', fontSize: 11 }, labelBgStyle: { fill: 'var(--panel)' },
          style: { stroke, strokeWidth: isNew ? 2.5 : lit ? 2 : 1.25, opacity: selected !== undefined && !lit ? 0.3 : 1 },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        };
      });
    for (const e of change?.edges.removed ?? []) {
      if (!pos.has(e.from) || !pos.has(e.to)) continue;
      edges.push({ id: `gone:${e.from}->${e.to}`, source: id(e.from), target: id(e.to), label: 'gone', labelStyle: { fill: 'var(--text-3)', fontSize: 11 }, labelBgStyle: { fill: 'var(--panel)' }, style: { stroke: 'var(--text-3)', strokeDasharray: '4 4', strokeWidth: 1.25 } });
    }
    return { nodes, edges };
  }, [snap, act, change, notes, color, selected, now]);

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
  const sum = edits.reduce((n, [, c]) => n + c, 0);
  const readers = t ? [...t.reads.keys()].filter(r => !t.edits.has(r)) : [];
  return (
    <div className={`area-card${d.area.unmapped ? ' unmapped' : ''}${d.on ? ' on' : ''}${d.faded ? ' faded' : ''}${d.hot ? ' hot' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="area-head">
        <span className="area-title ellipsis">{d.area.title}</span>
        {d.added && <span className="pill decision">new</span>}
        {d.rewritten && <span className="pill decision" title="Its description in the map changed">redescribed</span>}
        {d.notes > 0 && <span title={`${d.notes} pinned note${d.notes > 1 ? 's' : ''}`}>📌{d.notes > 1 ? d.notes : ''}</span>}
        {d.collisions > 0 && (
          <span className="warn-text" title={`${d.collisions} file${d.collisions > 1 ? 's' : ''} here edited by more than one agent`}>
            ⚠{d.collisions}
          </span>
        )}
      </div>
      <div className="mono muted small ellipsis">{d.area.path || '(top level)'}</div>
      <div className="area-summary">{d.area.summary || (d.area.unmapped ? 'Not in the map.' : '')}</div>
      <div className="area-stats muted small">
        {d.files} file{d.files === 1 ? '' : 's'} · {d.symbols} definition{d.symbols === 1 ? '' : 's'}
        {d.delta && (
          <span className="area-delta">
            {' '}
            · changed: {d.delta.files} file{d.delta.files === 1 ? '' : 's'}, {d.delta.symbols} def{d.delta.symbols === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {sum > 0 && (
        <>
          <div className="act-bar" aria-hidden>
            {edits.map(([a, n]) => (
              <span key={a} style={{ flexGrow: n, background: d.color(a) }} />
            ))}
          </div>
          <div className="act-names small">
            {edits.slice(0, 3).map(([a, n]) => (
              <span key={a}>
                <span className="swatch" style={{ background: d.color(a) }} />
                {a} {n}
              </span>
            ))}
            {edits.length > 3 && <span className="muted">+{edits.length - 3}</span>}
          </div>
        </>
      )}
      {!sum && readers.length > 0 && <div className="muted small ellipsis">read by {readers.join(', ')}</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const NODE_TYPES = { area: AreaCard };

function AreaPanel(p: {
  goal: Goal;
  snap: DesignSnapshot;
  area: string;
  act: Activity;
  change?: DesignChange;
  notes: { id: string; path: string; text: string; delivered: string[]; kept?: string }[];
  color: (n?: string) => string;
  file?: string;
  onFile: (f?: string) => void;
  onArea: (a: string) => void;
  onClose: () => void;
  onCommand: Props['onCommand'];
  onMessage: () => void;
  onSelectAgent: (n: string) => void;
}) {
  const { snap, area, act, change, color } = p;
  const a = snap.map.areas.find(x => x.path === area);
  const files = snap.files.filter(f => f.area === area);
  const fresh = [...act.fresh].filter(f => areaOf(snap.map.areas, f) === area);
  const t = act.areas.get(area);
  const uses = snap.edges.filter(e => e.from === area);
  const usedBy = snap.edges.filter(e => e.to === area);
  const [text, setText] = useState('');
  const live = p.goal.live && p.goal.status !== 'ended';
  const current = p.file ? snap.files.find(f => f.path === p.file) : undefined;
  return (
    <div className="area-panel scroll">
      <div className="area-panel-head">
        <div>
          <div className="kicker">Area</div>
          <b>{a?.title ?? areaLabel(area)}</b> <span className="mono muted small">{area || '(top level)'}</span>
        </div>
        <button className="btn ghost small" onClick={p.onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {a?.unmapped && <div className="notice-box">The map (ARCHITECTURE.md) doesn't describe this part of the code.</div>}
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

      {t && (
        <div className="area-who">
          {[...new Set([...t.edits.keys(), ...t.commits.keys(), ...t.reads.keys()])].map(n => (
            <button key={n} className="agent-legend-item" onClick={() => p.onSelectAgent(n)} title="Edits, commits and reads in the activity window">
              <span className="swatch" style={{ background: color(n) }} />
              {n} <span className="muted">{[t.edits.get(n) && `${t.edits.get(n)} edits`, t.commits.get(n) && `${t.commits.get(n)} commits`, t.reads.get(n) && `${t.reads.get(n)} reads`].filter(Boolean).join(', ')}</span>
            </button>
          ))}
        </div>
      )}

      <div className="section-title">Files</div>
      <FileMap files={files} fresh={fresh} act={act} change={change} color={color} selected={p.file} onSelect={p.onFile} />
      {current && <FileDetail snap={snap} file={current} act={act} change={change} color={color} onFile={f => p.onArea(areaOf(snap.map.areas, f) ?? '')} />}

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

/** The area's files as a treemap, sized by bytes, each coloured by the agent who last edited it. */
function FileMap({ files, fresh, act, change, color, selected, onSelect }: { files: DesignFile[]; fresh: string[]; act: Activity; change?: DesignChange; color: (n?: string) => string; selected?: string; onSelect: (f?: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  useLayoutEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const h = Math.max(120, Math.min(320, Math.round(Math.sqrt(files.length + fresh.length) * 60)));
  const changed = new Set([...(change?.files.added ?? []), ...(change?.files.changed ?? [])]);
  const items = [...files.map(f => ({ key: f.path, weight: Math.max(f.size, 200) })), ...fresh.map(f => ({ key: f, weight: 800 }))];
  const tiles = treemap(items, w, h);
  return (
    <div ref={box} className="treemap" style={{ height: h }}>
      {tiles.map(t => {
        const touch = act.files.get(t.key);
        const by = touch?.lastEditBy;
        const name = t.key.split('/').pop()!;
        const isFresh = fresh.includes(t.key);
        return (
          <button
            key={t.key}
            className={`fm-tile${selected === t.key ? ' on' : ''}${changed.has(t.key) ? ' changed' : ''}${isFresh ? ' fresh' : ''}`}
            style={{ left: t.x, top: t.y, width: Math.max(0, t.w - 2), height: Math.max(0, t.h - 2), ...(by ? { background: `color-mix(in srgb, ${color(by)} 28%, var(--panel))`, boxShadow: `inset 3px 0 0 ${color(by)}` } : {}) }}
            onClick={() => onSelect(selected === t.key ? undefined : t.key)}
            title={[t.key, isFresh ? 'new, not committed yet' : '', by ? `last edited by ${by}` : '', touch && touch.edits.size > 1 ? `edited by ${[...touch.edits.keys()].join(', ')}` : '', changed.has(t.key) ? 'changed since the snapshot compared with' : ''].filter(Boolean).join('\n')}
          >
            {t.w > 46 && t.h > 18 && <span className="fm-name">{name}</span>}
            {t.w > 60 && t.h > 34 && by && <span className="fm-by">{by}</span>}
          </button>
        );
      })}
      {!tiles.length && <div className="empty">No files.</div>}
    </div>
  );
}

function FileDetail({ snap, file, act, change, color, onFile }: { snap: DesignSnapshot; file: DesignFile; act: Activity; change?: DesignChange; color: (n?: string) => string; onFile: (f: string) => void }) {
  const mark = (name: string, kind: string, parent?: string) => {
    const same = (s: { file: string; name: string; kind: string; parent?: string }) => s.file === file.path && s.name === name && s.kind === kind && s.parent === parent;
    return change?.symbols.added.some(same) ? 'added' : change?.symbols.changed.some(same) ? 'changed' : undefined;
  };
  const removed = change?.symbols.removed.filter(s => s.file === file.path) ?? [];
  const importedBy = snap.files.filter(f => f.imports?.includes(file.path)).map(f => f.path);
  const t = act.files.get(file.path);
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
      {!!file.symbols?.length && (
        <ul className="symbols">
          {file.symbols.map((s, i) => {
            const m = mark(s.name, s.kind, s.parent);
            return (
              <li key={i} className={m} style={{ paddingLeft: s.parent ? 16 : 0 }}>
                <span className="sym-kind">{s.kind}</span> <span className="mono">{s.name}</span>
                {m && <span className="pill decision">{m}</span>}
                <span className="muted small"> :{s.line}</span>
              </li>
            );
          })}
          {removed.map((s, i) => (
            <li key={`r${i}`} className="removed">
              <span className="sym-kind">{s.kind}</span> <span className="mono">{s.name}</span> <span className="pill">removed</span>
            </li>
          ))}
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

/** Beside the map when no area is picked: how the design moved, the map's history, and what the run says about the workflow. */
function History({ goal, events, list, snap, change, found, color, onAt, onOpenCommit, onArea, onSelectAgent }: {
  goal: Goal;
  events: MhEvent[];
  list: SnapshotInfo[];
  snap: DesignSnapshot;
  change?: DesignChange;
  found: ReturnType<typeof insights>;
  color: (n?: string) => string;
  onAt: (sha: string) => void;
  onOpenCommit: (sha: string) => void;
  onArea: (a: string) => void;
  onSelectAgent: (n: string) => void;
}) {
  const mapFile = snap.map.file ?? 'ARCHITECTURE.md';
  const mapCommits = events.filter(e => e.type === 'git.commit' && (e.data.paths as string[] | undefined)?.includes(mapFile)).reverse();
  return (
    <div className="area-panel scroll">
      {snap.map.overview && (
        <>
          <div className="kicker">The map</div>
          <p className="area-text">{snap.map.overview}</p>
        </>
      )}
      {!snap.map.file && <div className="notice-box">There's no ARCHITECTURE.md, so the areas are the folders. The map-bootstrap workflow can write one.</div>}
      {change && (
        <>
          <div className="section-title">What changed</div>
          <ChangeList change={change} onArea={onArea} />
        </>
      )}
      <div className="section-title">Design history</div>
      {mapCommits.map(e => (
        <button key={e.seq} className="history-row" onClick={() => onOpenCommit(String(e.data.sha))} title="Open the commit in the Git tab">
          <span className="swatch" style={{ background: color(e.agent) }} />
          <span>
            {String(e.data.summary)}
            <span className="sub">
              {e.agent ?? 'unnamed'} · {ago(e.ts)}
            </span>
          </span>
        </button>
      ))}
      {[...list].reverse().map((s, i) => (
        <button key={s.sha} className={`history-row${s.sha === snap.sha ? ' on' : ''}`} onClick={() => onAt(s.sha)}>
          <span className="snap-dot" />
          <span>
            {s.kind === 'start' ? 'The goal started' : `Snapshot ${list.length - 1 - i}: work landed`}
            {s.by?.length ? ` (${s.by.join(', ')})` : ''}
            {s.change?.highlights.map(h => (
              <span key={h} className="sub">
                {h}
              </span>
            ))}
            <span className="sub">{ago(s.at)}</span>
          </span>
        </button>
      ))}
      <div className="section-title">For next time</div>
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
        {found.rework.length > 0 && (
          <li>
            Reworked (3+ commits): {found.rework.slice(0, 5).map(r => `${r.path} ×${r.commits}`).join(', ')}
          </li>
        )}
        {found.spread.length > 0 && (
          <li>
            Areas each agent edited in:{' '}
            {found.spread.map(s => (
              <button key={s.agent} className="text-link" onClick={() => onSelectAgent(s.agent)}>
                {s.agent} {s.areas}
              </button>
            ))}
          </li>
        )}
        {found.rules.length > 0 && <li>Rules that fired: {found.rules.map(r => `${r.rule} ×${r.n}`).join(', ')}</li>}
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
        Snapshot of {snap.sha.slice(0, 7)} on {goal.branch ?? 'the goal branch'}.
      </div>
    </div>
  );
}

function ChangeList({ change: c, onArea }: { change: DesignChange; onArea: (a: string) => void }) {
  const big = (k: string) => ['class', 'interface', 'type', 'enum', 'module'].includes(k);
  const lines: { key: string; text: string; area?: string }[] = [
    ...c.areas.added.map(a => ({ key: `aa${a}`, text: `New area ${areaLabel(a)}`, area: a })),
    ...c.areas.removed.map(a => ({ key: `ar${a}`, text: `Area ${areaLabel(a)} is gone` })),
    ...c.areas.rewritten.map(a => ({ key: `aw${a}`, text: `${areaLabel(a)} described anew in the map`, area: a })),
    ...c.edges.added.map(e => ({ key: `ea${e.from}${e.to}`, text: `${areaLabel(e.from)} now uses ${areaLabel(e.to)}`, area: e.from })),
    ...c.edges.removed.map(e => ({ key: `er${e.from}${e.to}`, text: `${areaLabel(e.from)} no longer uses ${areaLabel(e.to)}`, area: e.from })),
    ...c.symbols.added.filter(s => big(s.kind) || !s.parent).slice(0, 12).map(s => ({ key: `sa${s.file}${s.name}`, text: `+ ${s.kind} ${s.name} (${s.file})`, area: s.area })),
    ...c.symbols.removed.filter(s => big(s.kind) || !s.parent).slice(0, 8).map(s => ({ key: `sr${s.file}${s.name}`, text: `− ${s.kind} ${s.name} (${s.file})`, area: s.area })),
  ];
  const more = c.symbols.changed.length;
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
