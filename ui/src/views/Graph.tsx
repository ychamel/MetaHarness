import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Background, BaseEdge, Controls, getBezierPath, Handle, MarkerType, Position, ReactFlow, useReactFlow, ReactFlowProvider, type Edge, type EdgeProps, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { clock, eventText, isOwnTool, modelLabel, money, oneLine, STATE_LABEL } from '../format.ts';
import type { Agent, Goal, MhEvent } from '../types.ts';
import { Ctx, Dot, useNow } from '../components/common.tsx';
import { Splitter } from '../components/Splitter.tsx';

const W = 240;
const H = 175;
/** Shared files sit in a grid under the team, in cells this size. */
const FW = 230;
const FH = 44;
/** How long a message's pulse takes to run along its line. */
const PULSE_MS = 1100;
const WINDOWS: [string, number][] = [
  ['last minute', 60_000],
  ['last 5 min', 300_000],
  ['last 15 min', 900_000],
  ['all', Infinity],
];

/** What an agent is doing right now, from its events: the step it's on, and since when. */
interface Live {
  tool?: { name: string; summary: string; since: number; running: boolean };
  /** When its state last changed. */
  since: number;
}

type AgentData = { agent: Agent; live?: Live; waiting?: string; helpers: number; open: boolean; faded: boolean; on: boolean; toggle: () => void };
type FileData = { path: string; faded: boolean };
type MsgData = { pulses: string[]; color: string; picked: boolean };

const short = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}`);
const toolName = (t: string) => t.replace(/^mcp__\w+?__/, '');
const WAIT_WHY: Record<string, string> = { approval: 'your approval', question: 'your answer', decision: 'your decision' };

function AgentCard({ data }: NodeProps<Node<AgentData>>) {
  const a = data.agent;
  // Each card keeps its own clock, so durations tick without rebuilding the graph.
  const now = useNow(1000);
  const live = data.live;
  const state = a.pausing ? 'paused' : a.state;
  const busy = a.state === 'working' || a.state === 'starting';
  const step = busy && live?.tool?.running ? live.tool : undefined;
  return (
    <div className={`card-node${data.on ? ' on' : ''}${data.faded ? ' faded' : ''}${busy ? ' busy' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      <SideHandles />
      <div className="top">
        <Dot state={state} />
        <span className="name">{a.name}</span>
        <span className="spacer" />
        {a.awaitingApproval > 0 && (
          <span className="badge warn" title="Waiting for your approval">
            !
          </span>
        )}
        {a.unread > 0 && (
          <span className="badge" title={`${a.unread} message${a.unread > 1 ? 's' : ''} waiting to reach it`}>
            ✉ {a.unread}
          </span>
        )}
      </div>
      <div className="meta">
        {a.harness} · {modelLabel(a)}
      </div>
      <div className={`now${step ? ' step' : ''}`} title={step ? `${step.name} ${step.summary}` : a.status}>
        {step ? (
          <>
            <b>{toolName(step.name)}</b> {oneLine(step.summary, 60)} · {short(now - step.since)}
          </>
        ) : data.waiting ? (
          <>waiting on {data.waiting}</>
        ) : a.state === 'idle' ? (
          'Waiting for messages'
        ) : a.status ? (
          oneLine(a.status, 80)
        ) : a.state === 'done' ? (
          'finished'
        ) : (
          ' '
        )}
      </div>
      <div className="foot">
        <span>
          {a.pausing ? 'pausing…' : STATE_LABEL[a.state]}
          {live && !['done', 'ended', 'crashed'].includes(a.state) ? ` ${short(now - live.since)}` : ''}
        </span>
        <Ctx pct={a.contextPct} />
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

/** A message line, with a dot running along it for each message just sent. */
function MessageEdge(p: EdgeProps<Edge<MsgData>>) {
  const [path, lx, ly] = getBezierPath(p);
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd={p.markerEnd} style={p.style} label={p.label} labelX={lx} labelY={ly} labelBgPadding={[4, 2]} labelBgBorderRadius={4} interactionWidth={24} />
      {p.data?.pulses.map(id => <Pulse key={id} path={path} color={p.data!.color} />)}
    </>
  );
}

function Pulse({ path, color }: { path: string; color: string }) {
  const dot = useRef<SVGCircleElement>(null);
  const motion = useRef<SVGAnimateMotionElement>(null);
  // Started when it appears: an animation added later otherwise runs on the page's clock, already over.
  useLayoutEffect(() => {
    motion.current?.beginElement();
    dot.current?.setAttribute('visibility', 'visible');
  }, []);
  return (
    <circle ref={dot} r={5} fill={color} visibility="hidden" className="pulse-dot">
      <animateMotion ref={motion} begin="indefinite" dur={`${PULSE_MS}ms`} fill="freeze" path={path} calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.4 0 0.2 1" />
    </circle>
  );
}

const nodeTypes = { agent: AgentCard, human: HumanCard, file: FileCard };
const edgeTypes = { message: MessageEdge };

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

/** Each agent's current step and how long it's been in its state, from the whole event stream. */
function liveOf(events: MhEvent[]): Map<string, Live> {
  const out = new Map<string, Live>();
  for (const e of events) {
    if (!e.agent) continue;
    const t = new Date(e.ts).getTime();
    const l = out.get(e.agent) ?? { since: t };
    if (e.type === 'agent.spawned' || e.type === 'agent.state') {
      l.since = t;
      if (e.data.state && e.data.state !== 'working') l.tool = l.tool && { ...l.tool, running: false };
    } else if (e.type === 'agent.tool_call' && !isOwnTool(e)) l.tool = { name: String(e.data.tool), summary: String(e.data.summary ?? ''), since: t, running: true };
    else if (e.type === 'agent.tool_call') l.tool = l.tool && { ...l.tool, running: false };
    else if (e.type === 'agent.tool_result' && l.tool) l.tool = { ...l.tool, running: false };
    out.set(e.agent, l);
  }
  return out;
}

/** One message between two agents (or an agent and you), as the conversation panel shows it. */
interface Said {
  seq: number;
  ts: string;
  from: string;
  to: string;
  text: string;
  kind: 'message' | 'brief' | 'done';
  urgent?: boolean;
  queued?: boolean;
}

/** Every message, with the briefs and done notes that pass between spawner and spawned. */
function conversation(events: MhEvent[]): Said[] {
  const delivered = new Set(events.filter(e => e.type === 'message.delivered').map(e => String(e.data.id)));
  const parentOf = new Map<string, string>();
  const out: Said[] = [];
  for (const e of events) {
    if (!e.agent) continue;
    if (e.type === 'agent.spawned') {
      parentOf.set(e.agent, e.parent ?? 'human');
      out.push({ seq: e.seq, ts: e.ts, from: e.parent ?? 'human', to: e.agent, text: String(e.data.brief ?? ''), kind: 'brief' });
    } else if (e.type === 'message.sent') {
      const id = e.data.id ? String(e.data.id) : undefined;
      out.push({ seq: e.seq, ts: e.ts, from: e.agent, to: String(e.data.to), text: String(e.data.text ?? ''), kind: 'message', urgent: !!e.data.urgent, queued: !!id && !delivered.has(id) });
    } else if (e.type === 'agent.done') out.push({ seq: e.seq, ts: e.ts, from: e.agent, to: parentOf.get(e.agent) ?? 'human', text: String(e.data.note ?? ''), kind: 'done' });
  }
  return out;
}

/** Handles for a line between two cards: straight across when side by side, else down on the right and up on the left, so a pair's two directions never overlap. */
function sides(a?: Point, b?: Point): [string, string] {
  const dx = (b?.x ?? 0) - (a?.x ?? 0), dy = (b?.y ?? 0) - (a?.y ?? 0);
  return Math.abs(dx) > W / 2 && Math.abs(dy) < H / 2 ? (dx > 0 ? ['r-out', 'l-in'] : ['l-out', 'r-in']) : dy >= 0 ? ['r-out', 'r-in'] : ['l-out', 'l-in'];
}

/** How information flows: who spawned whom, who messaged whom (live), who waits on whom, who wrote which shared file. */
function GraphInner({ goal, events, selected, onSelect }: { goal: Goal; events: MhEvent[]; selected?: string; onSelect: (n: string) => void }) {
  const [windowMs, setWindowMs] = useState(Infinity);
  const [focus, setFocus] = useState(true);
  const [openHelpers, setOpenHelpers] = useState<Set<string>>(new Set());
  const [pair, setPair] = useState<[string, string]>();
  const [tickN, tick] = useState(0);
  const flow = useReactFlow();
  // Recent messages animate; look again every few seconds so they stop.
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const { moved, setMoved, save } = useMoved(goal.id);
  // React Flow hides a node it gets without its measured size, and drops its handles, until it
  // measures it again. Nodes are rebuilt on every drag step and event, so the sizes go back in.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const live = useMemo(() => liveOf(events), [events]);
  const said = useMemo(() => conversation(events), [events]);

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
    const msgs = new Map<string, { from: string; to: string; n: number; last: number; recent: { id: string; at: number }[] }>();
    for (const e of recent) {
      if (e.type !== 'message.sent' || !e.agent) continue;
      const from = owner(e.agent);
      const to = owner(String(e.data.to));
      if (from === to) continue;
      const k = `${from}→${to}`;
      const m = msgs.get(k) ?? { from, to, n: 0, last: 0, recent: [] };
      const at = new Date(e.ts).getTime();
      m.n++;
      m.last = Math.max(m.last, at);
      m.recent.push({ id: String(e.data.id ?? e.seq), at });
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
    return { visible, shown, owner, pos, msgs, writes, files };
  }, [goal, events, windowMs, openHelpers]);

  const { nodes, edges, nextPulseEnd } = useMemo(() => {
    const { visible, shown, owner, msgs, writes, files } = layout;
    const now = Date.now();
    const pos = new Map(layout.pos);
    for (const [id, p] of Object.entries(moved)) if (pos.has(id)) pos.set(id, p);

    // Who each agent waits on, folded helpers counting as their caller.
    const waits = visible.flatMap(a => (a.waitingOn ? [...new Set(a.waitingOn.who.map(owner))].filter(w => w !== a.name).map(w => ({ from: a.name, to: w, why: a.waitingOn!.why })) : []));
    const waitLabel = (a: Agent) => {
      const w = a.waitingOn;
      if (!w) return undefined;
      if (WAIT_WHY[w.why]) return WAIT_WHY[w.why];
      const names = w.who.map(n => (n === 'human' ? 'you' : n));
      return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
    };

    // Focus: the selected agent, its parent and children, whoever it talked to or waits on, what it wrote.
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
      for (const w of waits) {
        if (w.from === selected) related.add(w.to);
        if (w.to === selected) related.add(w.from);
      }
      for (const w of writes.values()) if (w.by === selected) related.add(`file:${w.path}`);
    }
    const faded = (id: string) => related.size > 0 && !related.has(id);

    const built: Node[] = [
      { id: 'human', type: 'human', position: pos.get('human')!, data: {}, draggable: true },
      ...visible.map(
        (a): Node<AgentData> => ({
          id: a.name,
          type: 'agent',
          position: pos.get(a.name)!,
          data: {
            agent: a,
            live: live.get(a.name),
            waiting: waitLabel(a),
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
    const nodes = built.map(n => (sizes[n.id] ? { ...n, measured: sizes[n.id] } : n));
    const dim = (a: string, b: string) => (related.size > 0 && !(related.has(a) && related.has(b)) ? 0.15 : 1);
    const inPair = (a: string, b: string) => !!pair && ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a));
    let nextPulseEnd = Infinity;
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
      ...[...msgs.values()].map((m): Edge<MsgData> => {
        const [sh, th] = sides(pos.get(m.from), pos.get(m.to));
        const color = m.from === 'human' || m.to === 'human' ? 'var(--you)' : 'var(--accent)';
        const pulses = m.recent.filter(r => now - r.at < PULSE_MS + 300);
        for (const r of pulses) nextPulseEnd = Math.min(nextPulseEnd, r.at + PULSE_MS + 300);
        const picked = inPair(m.from, m.to);
        return {
          id: `msg:${m.from}→${m.to}`,
          source: m.from,
          sourceHandle: sh,
          target: m.to,
          targetHandle: th,
          type: 'message',
          animated: now - m.last < 15_000,
          label: String(m.n),
          data: { pulses: pulses.map(r => r.id), color, picked },
          style: { stroke: color, strokeWidth: Math.min(5, 1 + Math.log2(m.n)) + (picked ? 2 : 0), opacity: pair && !picked ? 0.35 : dim(m.from, m.to), cursor: 'pointer' },
          markerEnd: { type: MarkerType.ArrowClosed, color },
        };
      }),
      ...waits.map((w): Edge => {
        const [sh, th] = sides(pos.get(w.from), pos.get(w.to));
        return {
          id: `wait:${w.from}→${w.to}`,
          source: w.from,
          sourceHandle: sh,
          target: w.to,
          targetHandle: th,
          type: 'default',
          animated: true,
          label: w.why === 'partner' ? 'waits' : w.why === 'helpers' ? 'waits for' : `waits: ${w.why}`,
          style: { stroke: 'var(--waiting)', strokeWidth: 1.6, strokeDasharray: '6 4', opacity: dim(w.from, w.to) },
          markerEnd: { type: MarkerType.Arrow, color: 'var(--waiting)' },
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
    return { nodes, edges, nextPulseEnd };
  }, [layout, moved, sizes, live, goal.agents, focus, selected, pair, tickN]);

  // Pulses go once they've arrived.
  useEffect(() => {
    if (!Number.isFinite(nextPulseEnd)) return;
    const t = setTimeout(() => tick(n => n + 1), Math.max(50, nextPulseEnd - Date.now()));
    return () => clearTimeout(t);
  }, [nextPulseEnd]);

  // Dragging moves a card for good (in this browser); the rest keep their places in the layout.
  const onNodesChange = (changes: NodeChange[]) => {
    const measured = changes.filter(c => c.type === 'dimensions' && c.dimensions);
    if (measured.length)
      setSizes(s => {
        const n = { ...s };
        for (const c of measured) if (c.type === 'dimensions' && c.dimensions) n[c.id] = c.dimensions;
        return n;
      });
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

  // Frame the team again when it grows, once its new cards are measured: framed before that,
  // the view can end up on empty space.
  const ids = nodes.map(n => n.id).join('\n');
  const measuredAll = nodes.every(n => n.measured);
  const framed = useRef('');
  useEffect(() => {
    if (!measuredAll || framed.current === ids) return;
    framed.current = ids;
    const t = setTimeout(() => void flow.fitView({ padding: 0.2, duration: 200, maxZoom: 1 }), 50);
    return () => clearTimeout(t);
  }, [ids, measuredAll, flow]);

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
            <i style={{ background: 'var(--waiting)' }} /> waits on
          </span>
          <span>
            <i style={{ background: 'var(--text-3)' }} /> wrote a shared file
          </span>
        </div>
      </div>
      <div className="graph-body">
        <div className="view">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, n) => n.type === 'agent' && onSelect(n.id)}
            onEdgeClick={(_, e) => {
              if (!e.id.startsWith('msg:')) return;
              const p: [string, string] = [e.source, e.target];
              setPair(cur => (cur && cur[0] === p[0] && cur[1] === p[1]) || (cur && cur[0] === p[1] && cur[1] === p[0]) ? undefined : p);
            }}
            onPaneClick={() => setPair(undefined)}
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
        <Splitter pane="graph-side" grow="left" min={220} max={700} label="Messages panel" />
        <Talk goal={goal} events={events} said={said} pair={pair} agent={focus ? selected : undefined} owner={layout.owner} onPair={setPair} onSelect={onSelect} />
      </div>
    </>
  );
}

/**
 * Beside the graph: the team's messages as they happen, or the conversation between the two
 * ends of the line you clicked, briefs and done notes included. "Everything" adds the rest of
 * what the team does (steps, commits, files) to the feed.
 */
function Talk({ goal, events, said, pair, agent, owner, onPair, onSelect }: { goal: Goal; events: MhEvent[]; said: Said[]; pair?: [string, string]; agent?: string; owner: (n: string) => string; onPair: (p?: [string, string]) => void; onSelect: (n: string) => void }) {
  const [all, setAll] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const name = (n: string) => (n === 'human' ? 'you' : n);

  const lines = useMemo((): { key: string; said?: Said; event?: MhEvent }[] => {
    if (pair) {
      const [a, b] = pair;
      return said.filter(s => (owner(s.from) === a && owner(s.to) === b) || (owner(s.from) === b && owner(s.to) === a)).map(s => ({ key: `s${s.seq}`, said: s }));
    }
    const mine = (s: { from: string; to: string }) => !agent || s.from === agent || s.to === agent;
    if (!all) return said.filter(mine).slice(-200).map(s => ({ key: `s${s.seq}`, said: s }));
    const bySeq = new Map(said.map(s => [s.seq, s]));
    return events
      .filter(e => (bySeq.has(e.seq) ? mine(bySeq.get(e.seq)!) : (!agent || e.agent === agent) && e.type !== 'agent.text' && e.type !== 'agent.state' && e.type !== 'usage' && !isOwnTool(e) && !!eventText(e)))
      .slice(-300)
      .map(e => (bySeq.has(e.seq) ? { key: `s${e.seq}`, said: bySeq.get(e.seq)! } : { key: `e${e.seq}`, event: e }));
  }, [pair, said, all, agent, events, owner]);

  // Follow the newest line unless you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <aside className="talk" aria-label={pair ? 'Conversation' : 'Messages'}>
      <div className="talk-head">
        {pair ? (
          <>
            <b>
              {name(pair[0])} ⇄ {name(pair[1])}
            </b>
            <span className="spacer" />
            <button className="btn ghost small" onClick={() => onPair(undefined)}>
              All messages
            </button>
          </>
        ) : (
          <>
            <b>{all ? 'Activity' : 'Messages'}</b>
            {agent && <span className="muted small">with {agent}</span>}
            <span className="spacer" />
            <span className="segmented small">
              <button className={!all ? 'on' : ''} onClick={() => setAll(false)}>
                Messages
              </button>
              <button className={all ? 'on' : ''} onClick={() => setAll(true)}>
                Everything
              </button>
            </span>
          </>
        )}
      </div>
      <div className="talk-body" ref={scroller} onScroll={e => (stick.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 40)}>
        {lines.map(l =>
          l.said ? (
            <div key={l.key} className={`said ${l.said.kind}${l.said.from === 'human' || l.said.to === 'human' ? ' you' : ''}`}>
              <div className="said-head">
                <button className="link" onClick={() => l.said!.from !== 'human' && onSelect(l.said!.from)}>
                  {name(l.said.from)}
                </button>
                <span className="muted">→</span>
                <button className="link" onClick={() => l.said!.to !== 'human' && onSelect(l.said!.to)}>
                  {name(l.said.to)}
                </button>
                {l.said.kind !== 'message' && <span className="pill">{l.said.kind}</span>}
                {l.said.urgent && <span className="pill warn">urgent</span>}
                {l.said.queued && <span className="pill" title="Sent, not yet delivered: it reaches them at their next step">queued</span>}
                <span className="spacer" />
                {!pair && (
                  <button className="link muted small" title="The whole conversation between these two" onClick={() => onPair([owner(l.said!.from), owner(l.said!.to)])}>
                    thread
                  </button>
                )}
                <span className="muted small mono">{clock(l.said.ts)}</span>
              </div>
              <div className="said-text">{oneLine(l.said.text, pair ? 2000 : 280)}</div>
            </div>
          ) : (
            <div key={l.key} className="did">
              <span className="muted small mono">{clock(l.event!.ts)}</span>
              <button className="link" onClick={() => l.event!.agent && onSelect(l.event!.agent)}>
                {l.event!.agent ?? 'goal'}
              </button>
              <span className="ellipsis" title={eventText(l.event!)}>
                {eventText(l.event!)}
              </span>
            </div>
          ),
        )}
        {!lines.length && <div className="empty">{pair ? 'Nothing passed between these two yet.' : agent ? `No messages with ${agent} yet.` : goal.live ? 'Messages show up here as the team sends them.' : 'Nobody sent a message.'}</div>}
      </div>
    </aside>
  );
}

export default function Graph(props: { goal: Goal; events: MhEvent[]; selected?: string; onSelect: (n: string) => void }) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
