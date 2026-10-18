import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useReactFlow, ReactFlowProvider, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { money, STATE_LABEL } from '../format.ts';
import type { Agent, Goal, MhEvent } from '../types.ts';
import { Dot } from '../components/common.tsx';

const W = 230;
const H = 120;
/** Shared files sit in a grid under the team, in cells this size. */
const FW = 230;
const FH = 44;
const WINDOWS: [string, number][] = [
  ['last minute', 60_000],
  ['last 5 min', 300_000],
  ['last 15 min', 900_000],
  ['all', Infinity],
];

type AgentData = { agent: Agent; helpers: number; open: boolean; faded: boolean; on: boolean; toggle: () => void };
type FileData = { path: string; faded: boolean };

function AgentCard({ data }: NodeProps<Node<AgentData>>) {
  const a = data.agent;
  return (
    <div className={`card-node${data.on ? ' on' : ''}${data.faded ? ' faded' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      <SideHandles />
      <div className="top">
        <Dot state={a.pausing ? 'paused' : a.state} />
        <span className="name">{a.name}</span>
      </div>
      <div className="meta">
        {a.harness} · {a.model}
      </div>
      <div className="foot">
        <span>{a.pausing ? 'pausing…' : STATE_LABEL[a.state]}</span>
        <span>{money(a.cost)}</span>
        {data.helpers > 0 && (
          <button
            className="helpers nodrag"
            onClick={e => {
              e.stopPropagation();
              data.toggle();
            }}
            title={data.open ? 'Fold its helpers' : 'Show its helpers'}
          >
            {data.open ? '−' : '+'}
            {data.helpers} helper{data.helpers > 1 ? 's' : ''}
          </button>
        )}
      </div>
    </div>
  );
}

/** Message lines leave and arrive at the sides, so they arc beside cards instead of crossing spawn lines. */
function SideHandles() {
  return (
    <>
      <Handle type="source" id="r-out" position={Position.Right} />
      <Handle type="target" id="r-in" position={Position.Right} />
      <Handle type="source" id="l-out" position={Position.Left} />
      <Handle type="target" id="l-in" position={Position.Left} />
    </>
  );
}

function HumanCard() {
  return (
    <div className="card-node human">
      <Handle type="source" position={Position.Bottom} />
      <SideHandles />
      <b>You</b>
    </div>
  );
}

function FileCard({ data }: NodeProps<Node<FileData>>) {
  return (
    <div className={`file-node${data.faded ? ' faded' : ''}`} title={data.path}>
      <Handle type="target" position={Position.Top} />
      📄 {data.path}
    </div>
  );
}

const nodeTypes = { agent: AgentCard, human: HumanCard, file: FileCard };

type Point = { x: number; y: number };

/** Where the human dragged cards to, per goal, kept in this browser. */
function useMoved(goal: string) {
  const key = `metaharness-graph:${goal}`;
  const read = (): Record<string, Point> => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, Point>;
    } catch {
      return {};
    }
  };
  const [moved, setMoved] = useState(read);
  useEffect(() => setMoved(read()), [key]);
  const save = (m: Record<string, Point>) => {
    try {
      if (Object.keys(m).length) localStorage.setItem(key, JSON.stringify(m));
      else localStorage.removeItem(key);
    } catch {
      // Not kept, but the layout still works for this visit.
    }
  };
  return { moved, setMoved, save };
}

/** How information flows: who spawned whom, who messaged whom (and how often), who wrote which shared file. */
function GraphInner({ goal, events, selected, onSelect }: { goal: Goal; events: MhEvent[]; selected?: string; onSelect: (n: string) => void }) {
  const [windowMs, setWindowMs] = useState(Infinity);
  const [focus, setFocus] = useState(true);
  const [openHelpers, setOpenHelpers] = useState<Set<string>>(new Set());
  const [tickN, tick] = useState(0);
  const flow = useReactFlow();
  // Recent messages animate; look again every few seconds so they stop.
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const { moved, setMoved, save } = useMoved(goal.id);

  const layout = useMemo(() => {
    const visible = goal.agents.filter(a => !a.quick || openHelpers.has(a.parent));
    const shown = new Set(visible.map(a => a.name));
    const kids = new Map<string, Agent[]>();
    for (const a of visible) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);

    // A tree, each subtree as wide as its leaves.
    const pos = new Map<string, { x: number; y: number }>();
    let next = 0;
    const place = (name: string, depth: number): number => {
      const ch = kids.get(name) ?? [];
      let x: number;
      if (!ch.length) x = next++;
      else {
        const xs = ch.map(c => place(c.name, depth + 1));
        x = (xs[0] + xs[xs.length - 1]) / 2;
      }
      pos.set(name, { x: x * W, y: depth * H });
      return x;
    };
    place('human', 0);
    for (const a of visible) if (!pos.has(a.name)) place(a.name, 1);
    const maxDepth = Math.max(0, ...[...pos.values()].map(p => p.y / H));
    const leaves = Math.max(1, next);

    const since = Date.now() - windowMs;
    const recent = events.filter(e => new Date(e.ts).getTime() >= since);
    // Messages from or to a folded helper count as its caller's.
    const owner = (n: string): string => (n === 'human' ? 'human' : shown.has(n) ? n : (goal.agents.find(a => a.name === n)?.parent ?? n));
    const msgs = new Map<string, { from: string; to: string; n: number; last: number }>();
    for (const e of recent) {
      if (e.type !== 'message.sent' || !e.agent) continue;
      const from = owner(e.agent);
      const to = owner(String(e.data.to));
      if (from === to) continue;
      const k = `${from}→${to}`;
      const m = msgs.get(k) ?? { from, to, n: 0, last: 0 };
      m.n++;
      m.last = Math.max(m.last, new Date(e.ts).getTime());
      msgs.set(k, m);
    }
    const writes = new Map<string, { by: string; path: string; n: number }>();
    const files: string[] = [];
    for (const e of recent) {
      if (e.type !== 'shared.write') continue;
      const path = String(e.data.path);
      if (!files.includes(path)) files.push(path);
      const by = e.agent ? owner(e.agent) : '';
      if (!by) continue;
      const k = `${by}→${path}`;
      const w = writes.get(k) ?? { by, path, n: 0 };
      w.n++;
      writes.set(k, w);
    }

    // Files in a grid under the team, about as wide as it, centred.
    const cols = Math.max(1, Math.min(files.length, Math.max(Math.ceil(Math.sqrt(files.length)), Math.floor((leaves * W) / FW))));
    const left = ((leaves - 1) * W - (cols - 1) * FW) / 2;
    files.forEach((path, i) => pos.set(`file:${path}`, { x: left + (i % cols) * FW, y: (maxDepth + 1) * H + 30 + Math.floor(i / cols) * FH }));
    return { visible, shown, pos, msgs, writes, files };
  }, [goal, events, windowMs, openHelpers]);

  const { nodes, edges } = useMemo(() => {
    const { visible, shown, msgs, writes, files } = layout;
    const now = Date.now();
    const pos = new Map(layout.pos);
    for (const [id, p] of Object.entries(moved)) if (pos.has(id)) pos.set(id, p);

    // Focus: the selected agent, its parent and children, whoever it talked to, what it wrote.
    const related = new Set<string>();
    if (focus && selected && shown.has(selected)) {
      related.add(selected);
      const me = goal.agents.find(a => a.name === selected);
      if (me) related.add(me.parent);
      for (const a of visible) if (a.parent === selected) related.add(a.name);
      for (const m of msgs.values()) {
        if (m.from === selected) related.add(m.to);
        if (m.to === selected) related.add(m.from);
      }
      for (const w of writes.values()) if (w.by === selected) related.add(`file:${w.path}`);
    }
    const faded = (id: string) => related.size > 0 && !related.has(id);

    const nodes: Node[] = [
      { id: 'human', type: 'human', position: pos.get('human')!, data: {}, draggable: true },
      ...visible.map(
        (a): Node<AgentData> => ({
          id: a.name,
          type: 'agent',
          position: pos.get(a.name)!,
          data: {
            agent: a,
            helpers: goal.agents.filter(h => h.quick && h.parent === a.name).length,
            open: openHelpers.has(a.name),
            faded: faded(a.name),
            on: a.name === selected,
            toggle: () =>
              setOpenHelpers(s => {
                const n = new Set(s);
                if (n.has(a.name)) n.delete(a.name);
                else n.add(a.name);
                return n;
              }),
          },
        }),
      ),
      ...files.map(
        (path): Node<FileData> => ({
          id: `file:${path}`,
          type: 'file',
          position: pos.get(`file:${path}`)!,
          data: { path, faded: faded(`file:${path}`) },
        }),
      ),
    ];
    const dim = (a: string, b: string) => (related.size > 0 && !(related.has(a) && related.has(b)) ? 0.15 : 1);
    const edges: Edge[] = [
      ...visible.map(
        (a): Edge => ({
          id: `spawn:${a.name}`,
          source: a.parent === 'human' || shown.has(a.parent) ? a.parent : 'human',
          target: a.name,
          type: 'smoothstep',
          style: { stroke: 'var(--line-strong)', opacity: dim(a.parent, a.name) },
          markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--line-strong)' },
        }),
      ),
      ...[...msgs.values()].map((m): Edge => {
        // Side by side: straight across. Above and below: down on the right, up on the left, so a
        // pair's two directions never overlap.
        const a = pos.get(m.from), b = pos.get(m.to);
        const dx = (b?.x ?? 0) - (a?.x ?? 0), dy = (b?.y ?? 0) - (a?.y ?? 0);
        const [sh, th] = Math.abs(dx) > W / 2 && Math.abs(dy) < H / 2 ? (dx > 0 ? ['r-out', 'l-in'] : ['l-out', 'r-in']) : dy >= 0 ? ['r-out', 'r-in'] : ['l-out', 'l-in'];
        return {
          id: `msg:${m.from}→${m.to}`,
          source: m.from,
          sourceHandle: sh,
          target: m.to,
          targetHandle: th,
          type: 'default',
          animated: now - m.last < 15_000,
          label: String(m.n),
          style: { stroke: m.from === 'human' || m.to === 'human' ? 'var(--you)' : 'var(--accent)', strokeWidth: Math.min(4, 1 + Math.log2(m.n)), opacity: dim(m.from, m.to) },
          markerEnd: { type: MarkerType.ArrowClosed, color: m.from === 'human' || m.to === 'human' ? 'var(--you)' : 'var(--accent)' },
        };
      }),
      ...[...writes.values()].map(
        (w): Edge => ({
          id: `write:${w.by}→${w.path}`,
          source: w.by,
          target: `file:${w.path}`,
          type: 'default',
          label: w.n > 1 ? `${w.n}×` : undefined,
          style: { stroke: 'var(--text-3)', strokeDasharray: '4 3', opacity: dim(w.by, `file:${w.path}`) },
        }),
      ),
    ].filter(e => nodes.some(n => n.id === e.source) && nodes.some(n => n.id === e.target));
    return { nodes, edges };
  }, [layout, moved, goal.agents, focus, selected, tickN]);

  // Dragging moves a card for good (in this browser); the rest keep their places in the layout.
  const onNodesChange = (changes: NodeChange[]) => {
    const moves = changes.filter(c => c.type === 'position' && c.position);
    if (!moves.length) return;
    setMoved(m => {
      const n = { ...m };
      for (const c of moves) if (c.type === 'position' && c.position) n[c.id] = c.position;
      if (moves.some(c => c.type === 'position' && !c.dragging)) save(n);
      return n;
    });
  };
  const resetLayout = () => {
    setMoved({});
    save({});
    setTimeout(() => void flow.fitView({ padding: 0.2, duration: 200, maxZoom: 1 }), 50);
  };

  // Frame the team again when it grows.
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.2, duration: 200, maxZoom: 1 }), 50);
    return () => clearTimeout(t);
  }, [nodes.length, flow]);

  return (
    <>
      <div className="toolbar">
        <select value={String(windowMs)} onChange={e => setWindowMs(Number(e.target.value))} aria-label="Time window">
          {WINDOWS.map(([label, ms]) => (
            <option key={label} value={String(ms)}>
              Messages and files: {label}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={focus} onChange={e => setFocus(e.target.checked)} /> Focus on the selected agent
        </label>
        {Object.keys(moved).length > 0 && (
          <button className="btn ghost small" onClick={resetLayout} title="Put every card back where the layout places it">
            Reset layout
          </button>
        )}
        <div className="legend">
          <span>
            <i style={{ background: 'var(--line-strong)' }} /> spawned
          </span>
          <span>
            <i style={{ background: 'var(--accent)' }} /> messages
          </span>
          <span>
            <i style={{ background: 'var(--text-3)' }} /> wrote a shared file
          </span>
        </div>
      </div>
      <div className="view">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => n.type === 'agent' && onSelect(n.id)}
          onNodesChange={onNodesChange}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
        >
          <Background gap={20} size={1} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </>
  );
}

export default function Graph(props: { goal: Goal; events: MhEvent[]; selected?: string; onSelect: (n: string) => void }) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
