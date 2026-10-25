import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent, BoardItem, ConfigView, Goal, MhEvent, Participant } from '../types.ts';
import { BOARD_SECTIONS, COORDINATOR, isCoordinator, MODES, responsibilityLabel, seatWhat, type RoomMsg, type RoomView, type ThreadItem } from '../roomData.ts';
import { clock, oneLine } from '../format.ts';
import { Dot, Markdown, More, useNow } from '../components/common.tsx';
import { SeatEditor, seatProblem } from '../components/Room.tsx';
import { agentColors } from '../agentColors.ts';

interface Props {
  goal: Goal;
  events: MhEvent[];
  room: RoomView;
  config?: ConfigView;
  onCommand: (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onSelectAgent: (name: string) => void;
  onOpenCommit: (sha: string) => void;
  onOpenFile: (path: string) => void;
  /** Starts a goal that carries out what the room settled. */
  onStartGoal: () => void;
  /** A new room that starts from this one's board. */
  onNewRoom: () => void;
}

const SIDE_KEY = 'mh.room.side';

/**
 * A room (design §21): the canvas shows who's in it and what each is doing, with you in the
 * middle and the coordinator below; click seats to pick who your next message is for (nobody:
 * the coordinator picks), drag one onto another to have it respond. Beside it, the thread
 * (answers nested under what they answer) and the board.
 */
export default function Thread({ goal, events, room, config, onCommand, onSelectAgent, onOpenCommit, onOpenFile, onStartGoal, onNewRoom }: Props) {
  const live = goal.live && goal.status !== 'ended';
  const color = useMemo(() => agentColors(goal), [goal]);
  const [to, setTo] = useState<string[]>([]);
  const [replyTo, setReplyTo] = useState<RoomMsg>();
  const [side, setSide] = useState<'thread' | 'board'>(() => {
    try {
      return localStorage.getItem(SIDE_KEY) === 'board' ? 'board' : 'thread';
    } catch {
      return 'thread';
    }
  });
  const pickSide = (s: 'thread' | 'board') => {
    setSide(s);
    try {
      localStorage.setItem(SIDE_KEY, s);
    } catch {
      // Kept for this visit only.
    }
  };
  const presets = config?.responsibilities ?? [];
  const pick = (n: string, add: boolean) => setTo(t => (t.includes(n) ? t.filter(x => x !== n) : add ? [...t, n] : [n]));
  const respond = (m: RoomMsg, who?: string) => {
    setReplyTo(m);
    setTo(who ? [who] : []);
  };
  const name = (n: string) =>
    n === 'human' ? (
      <b className="you">you</b>
    ) : isCoordinator(n) ? (
      <b className="coord-name">◆ coordinator</b>
    ) : n === 'MetaHarness' ? (
      <b>MetaHarness</b>
    ) : (
      <button className="name-link" style={{ color: color(n) }} onClick={() => onSelectAgent(n)}>
        {n}
      </button>
    );

  return (
    <div className="room-wrap">
      <div className="room-left">
        <Canvas
          goal={goal}
          room={room}
          presets={presets}
          color={color}
          picked={to}
          live={live}
          config={config}
          onPick={pick}
          onClear={() => setTo([])}
          onOpen={onSelectAgent}
          onRespond={(from, target) => {
            const last = [...room.messages].reverse().find(m => m.from === from && m.kind === 'answer');
            if (last) respond(last, target);
          }}
          onCommand={onCommand}
        />
        {live && <Composer goal={goal} room={room} to={to} setTo={setTo} replyTo={replyTo} onClearReply={() => setReplyTo(undefined)} onCommand={onCommand} />}
      </div>
      <aside className="room-side">
        <div className="room-side-tabs">
          <button className={`tab${side === 'thread' ? ' on' : ''}`} onClick={() => pickSide('thread')}>
            Thread
          </button>
          <button className={`tab${side === 'board' ? ' on' : ''}`} onClick={() => pickSide('board')}>
            Board{room.board.length ? ` ${room.board.length}` : ''}
          </button>
          <span className="grow" />
          {live && (
            <label className="check small" title="Open: participants message each other directly and the coordinator only watches. Off: the coordinator decides who goes next.">
              <input type="checkbox" checked={room.open} onChange={e => void onCommand({ cmd: 'room.open', goal: goal.id, open: e.target.checked })} /> Open discussion
            </label>
          )}
        </div>
        {side === 'thread' ? (
          <ThreadList goal={goal} room={room} name={name} live={live} onRespond={respond} onPin={t => void onCommand({ cmd: 'room.board', goal: goal.id, ops: [{ op: 'add', kind: 'finding', text: oneLine(t, 400) }] })} onAnswer={n => setTo([n])} onOpenCommit={onOpenCommit} />
        ) : (
          <Board goal={goal} room={room} live={live} events={events} onCommand={onCommand} onOpenFile={onOpenFile} onStartGoal={onStartGoal} onNewRoom={onNewRoom} />
        )}
      </aside>
    </div>
  );
}

/* ---------------- the canvas ---------------- */

const CARD_W = 184;
const CARD_H = 92;

/** Where each seat sits: around you, over the top and sides, leaving the bottom to the coordinator. */
function layout(n: number, w: number, h: number) {
  const cx = w / 2;
  const cy = h * 0.46;
  const rx = Math.max(140, w / 2 - CARD_W / 2 - 16);
  const ry = Math.max(90, h * 0.46 - CARD_H / 2 - 8);
  const from = 150;
  const until = 390;
  const clampX = (x: number) => Math.min(Math.max(x, CARD_W / 2 + 6), w - CARD_W / 2 - 6);
  const clampY = (y: number) => Math.min(Math.max(y, CARD_H / 2 + 6), h - CARD_H / 2 - 40);
  const seats = Array.from({ length: n }, (_, i) => {
    const deg = n === 1 ? 270 : from + ((until - from) * i) / (n - 1);
    const t = (deg * Math.PI) / 180;
    return { x: clampX(cx + rx * Math.cos(t)), y: clampY(cy + ry * Math.sin(t)) };
  });
  const you = { x: cx, y: cy };
  const coordinator = { x: cx, y: Math.min(h - 34, cy + ry * 0.92) };
  // A narrow canvas puts cards on top of each other: push overlapping ones apart, and off you and the coordinator.
  const fixed = [
    { x: you.x, y: you.y, w: 64, h: 64 },
    { x: coordinator.x, y: coordinator.y, w: Math.min(340, w * 0.8), h: 40 },
  ];
  const gap = 10;
  for (let round = 0; round < 80; round++) {
    let moved = false;
    const push = (a: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }, share: number) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const ox = (CARD_W + b.w) / 2 + gap - Math.abs(dx);
      const oy = (CARD_H + b.h) / 2 + gap - Math.abs(dy);
      if (ox <= 0 || oy <= 0) return;
      moved = true;
      if (ox < oy) a.x = clampX(a.x + (dx >= 0 ? 1 : -1) * ox * share);
      else a.y = clampY(a.y + (dy >= 0 ? 1 : -1) * oy * share);
    };
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        const b = { ...seats[j], w: CARD_W, h: CARD_H };
        push(seats[i], b, 0.5);
        push(seats[j], { ...seats[i], w: CARD_W, h: CARD_H }, 0.5);
      }
      for (const f of fixed) push(seats[i], f, 1);
    }
    if (!moved) break;
  }
  return { you, coordinator, seats };
}

interface Link {
  from: string;
  to: string;
  kind: 'active' | 'recent';
}

function Canvas({ goal, room, presets, color, picked, live, config, onPick, onClear, onOpen, onRespond, onCommand }: {
  goal: Goal;
  room: RoomView;
  presets: { name: string; text: string }[];
  color: (n?: string) => string;
  picked: string[];
  live: boolean;
  config?: ConfigView;
  onPick: (n: string, add: boolean) => void;
  onClear: () => void;
  onOpen: (n: string) => void;
  onRespond: (from: string, to: string) => void;
  onCommand: Props['onCommand'];
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const now = useNow(1000);
  const [adding, setAdding] = useState<Participant>();
  const [dragging, setDragging] = useState<string>();
  const pos = layout(room.cast.length, size.w, size.h);
  const at = (n: string) => (n === 'human' ? pos.you : isCoordinator(n) ? pos.coordinator : pos.seats[room.cast.findIndex(c => c.name === n)]);
  const agent = (n: string) => goal.agents.find(a => a.name === n);

  // Lines: who each working seat is working for, and what was just said (the last 12 seconds).
  const links = useMemo(() => {
    const out: Link[] = [];
    const add = (l: Link) => !out.some(x => x.from === l.from && x.to === l.to) && out.push(l);
    for (const c of room.cast) {
      const a = goal.agents.find(x => x.name === c.name);
      if (!a || !['starting', 'working'].includes(a.state)) continue;
      const asked = [...room.messages].reverse().find(m => m.to.includes(c.name!) && m.from !== c.name);
      if (asked) add({ from: asked.from, to: c.name!, kind: 'active' });
    }
    for (const m of room.messages) {
      if (now - Date.parse(m.ts) > 12_000 || m.kind === 'note') continue;
      const targets = m.kind === 'answer' || m.kind === 'question' ? [m.to.includes('coordinator') ? COORDINATOR : 'human'] : m.to.map(t => (t === 'coordinator' ? COORDINATOR : t));
      for (const t of targets) if (t !== m.from) add({ from: m.from, to: t, kind: 'recent' });
    }
    return out;
  }, [room, goal.agents, now]);

  const lastAnswer = (n: string) => [...room.messages].reverse().find(m => m.from === n && m.kind === 'answer');
  const doing = (p: Participant, a?: Agent) => {
    if (!a) return 'not started: starts when asked';
    if (room.writers.has(p.name!) && a.state === 'working') return `patching${a.status ? `: ${a.status}` : '…'}`;
    if (['starting', 'working'].includes(a.state)) return a.status ? a.status : 'working…';
    if (a.state === 'waiting') return 'waiting';
    return a.state === 'done' || a.state === 'idle' ? 'listening' : a.state;
  };
  const coordinatorLine = room.coordinating === 'route' ? 'choosing who answers…' : room.coordinating === 'decide' ? 'deciding what’s next…' : room.status ? room.status.line : room.open ? 'watching' : 'routes what you don’t address';

  return (
    <div className="room-canvas" ref={box} onClick={e => e.target === e.currentTarget && onClear()}>
      <svg className="room-links" width={size.w} height={size.h} aria-hidden>
        {room.cast.map(c => {
          const p = at(c.name!);
          return p ? <line key={`base-${c.name}`} x1={pos.you.x} y1={pos.you.y} x2={p.x} y2={p.y} className="base" /> : null;
        })}
        {links.map(l => {
          const a = at(l.from);
          const b = at(l.to);
          if (!a || !b) return null;
          return <line key={`${l.kind}-${l.from}-${l.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={l.kind} style={{ stroke: l.from === 'human' ? 'var(--you)' : isCoordinator(l.from) ? 'var(--text-2)' : color(l.from) }} />;
        })}
      </svg>

      <button className={`room-node you-node${picked.length ? '' : ' on'}`} style={{ left: pos.you.x, top: pos.you.y }} onClick={onClear} title={picked.length ? 'Clear who your next message is for: the coordinator picks' : 'You'}>
        you
      </button>

      <div className={`room-node coord-node${room.status ? ` ${room.status.state}` : ''}${room.coordinating ? ' busy' : ''}`} style={{ left: pos.coordinator.x, top: pos.coordinator.y }} title={room.status ? `${room.status.state}: ${room.status.line}` : 'The coordinator'}>
        <b>◆ coordinator</b>
        {room.status && <span className="coord-state">{room.status.state}</span>}
        <span className="coord-line">{coordinatorLine}</span>
        {live && !room.coordinating && (
          <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.coordinate', goal: goal.id })} title="Have the coordinator look at the room now">
            ↻
          </button>
        )}
      </div>

      {room.cast.map((p, i) => {
        const a = agent(p.name!);
        const xy = pos.seats[i];
        const on = picked.includes(p.name!);
        const busy = !!a && ['starting', 'working'].includes(a.state);
        const last = lastAnswer(p.name!);
        const resp = responsibilityLabel(p.responsibility, presets);
        return (
          <div
            key={p.name}
            className={`seat-card-node${on ? ' on' : ''}${busy ? ' busy' : ''}${a ? '' : ' unstarted'}${dragging && dragging !== p.name ? ' drop' : ''}`}
            style={{ left: xy.x, top: xy.y, width: CARD_W, borderColor: on ? color(p.name) : undefined }}
            draggable={live && !!last}
            onDragStart={e => {
              e.dataTransfer.setData('text/plain', p.name!);
              setDragging(p.name);
            }}
            onDragEnd={() => setDragging(undefined)}
            onDragOver={e => dragging && dragging !== p.name && e.preventDefault()}
            onDrop={e => {
              e.preventDefault();
              const from = e.dataTransfer.getData('text/plain');
              setDragging(undefined);
              if (from && from !== p.name) onRespond(from, p.name!);
            }}
            onClick={e => live && onPick(p.name!, e.shiftKey || e.ctrlKey || e.metaKey)}
            onDoubleClick={() => a && onOpen(p.name!)}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && live && onPick(p.name!, e.shiftKey)}
            title={`${p.name}: ${seatWhat(p)}${a ? ` · ${a.harness}/${a.model}` : p.on ? ` · ${p.on}` : ''}\n${p.responsibility ?? ''}${p.stance ? `\nStance: ${p.stance}` : ''}\n\nClick: your next message is for it (shift-click adds). Double-click: open it. Drag onto another seat: have that one respond to its last answer.`}
          >
            <div className="top">
              {a ? <Dot state={a.state} /> : <span className="dot unstarted" />}
              <span className="name" style={{ color: color(p.name) }}>
                {p.name}
              </span>
              {on && picked.length > 1 && <span className="seat-order">{picked.indexOf(p.name!) + 1}</span>}
              <span className="what">{seatWhat(p)}</span>
            </div>
            {resp && <div className="resp">{resp}</div>}
            <div className={`now${busy ? ' step' : ''}`}>{doing(p, a)}</div>
            {last && <div className="last">“{oneLine(last.text, 90)}”</div>}
          </div>
        );
      })}

      {!room.cast.length && <div className="room-empty">Nobody here yet: add a seat.</div>}

      {live && (
        <div className={`room-add${adding ? ' open' : ''}`}>
          {adding ? (
            <div className="room-add-form">
              <SeatEditor seat={adding} config={config} onChange={setAdding} />
              <div className="row end">
                {seatProblem(adding) && <span className="warn-text small">{seatProblem(adding)}</span>}
                <button className="btn ghost small" onClick={() => setAdding(undefined)}>
                  Cancel
                </button>
                <button
                  className="btn small primary"
                  disabled={!!seatProblem(adding)}
                  onClick={async () => {
                    if (await onCommand({ cmd: 'room.add', goal: goal.id, ...adding })) setAdding(undefined);
                  }}
                >
                  Add the seat
                </button>
              </div>
            </div>
          ) : (
            <button className="btn small" onClick={() => setAdding({ role: config?.roles.some(r => r.name === 'reviewer') ? 'reviewer' : undefined })} title="Another role, the same role on another model, or just a model">
              + Seat
            </button>
          )}
        </div>
      )}
      <div className="room-hint muted small">Click a seat to address it · shift-click adds · double-click opens · drag onto another: respond</div>
    </div>
  );
}

/* ---------------- the composer ---------------- */

function Composer({ goal, room, to, setTo, replyTo, onClearReply, onCommand }: {
  goal: Goal;
  room: RoomView;
  to: string[];
  setTo: (t: string[]) => void;
  replyTo?: RoomMsg;
  onClearReply: () => void;
  onCommand: Props['onCommand'];
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<(typeof MODES)[number]['mode']>('ask');
  const [rounds, setRounds] = useState(2);
  const [busy, setBusy] = useState(false);
  const effective = replyTo ? 'respond' : mode;
  const need =
    effective === 'patch' && to.length !== 1 ? 'Pick one seat for a patch job.'
    : effective === 'debate' && to.length < 2 ? 'Pick two or more seats for a debate.'
    : (effective === 'chain' || effective === 'respond') && !to.length ? `Pick who ${effective === 'chain' ? 'goes, in order' : 'should respond'}.`
    : !room.cast.length ? 'Add a seat first.'
    : '';
  const send = async () => {
    if (!text.trim() || busy || need) return;
    setBusy(true);
    const r = await onCommand({ cmd: 'room.post', goal: goal.id, text: text.trim(), to, mode: effective, ...(effective === 'debate' ? { rounds } : {}), ...(replyTo ? { replyTo: replyTo.id } : {}) });
    setBusy(false);
    if (r) {
      setText('');
      onClearReply();
      if (mode === 'patch') setMode('ask');
    }
  };
  return (
    <div className="composer">
      {replyTo && (
        <div className="quote composer-quote">
          {to.length ? `${to.join(', ')} responds` : 'Responding'} to {replyTo.from === 'human' ? 'you' : replyTo.from}: {oneLine(replyTo.text, 140)}
          <button className="btn ghost small" onClick={onClearReply} aria-label="Not a response">
            ×
          </button>
        </div>
      )}
      <div className="composer-row">
        <span className="to-chips">
          To:{' '}
          {to.length ? (
            <>
              {to.map(n => (
                <span key={n} className="to-chip">
                  {n}
                  <button onClick={() => setTo(to.filter(x => x !== n))} aria-label={`Not ${n}`}>
                    ×
                  </button>
                </span>
              ))}
            </>
          ) : (
            <span className="to-chip coord">◆ the coordinator picks</span>
          )}
        </span>
        <span className="grow" />
        <span className="modes" role="group" aria-label="How to ask">
          {MODES.map(m => (
            <button key={m.mode} className={`mode-btn${mode === m.mode && !replyTo ? ' on' : ''}`} title={m.hint} disabled={!!replyTo} onClick={() => setMode(m.mode)}>
              {m.label}
            </button>
          ))}
        </span>
        {mode === 'debate' && !replyTo && (
          <label className="small muted">
            rounds <input type="number" min={2} max={6} value={rounds} onChange={e => setRounds(Number(e.target.value) || 2)} className="rounds" />
          </label>
        )}
      </div>
      <div className="composer-input">
        <textarea
          rows={2}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={replyTo ? 'What should they respond to, or how?' : to.length ? `${MODES.find(m => m.mode === mode)?.hint ?? ''}.` : 'Ask the room. The coordinator picks who answers; click seats (or @name) to pick yourself.'}
          aria-label="Message to the room"
        />
        <button className="btn primary" disabled={!text.trim() || busy || !!need} onClick={() => void send()} title={need || 'Enter sends, Shift+Enter starts a new line'}>
          Send
        </button>
      </div>
      {need && text.trim() && <div className="muted small composer-need">{need}</div>}
    </div>
  );
}

/* ---------------- the thread ---------------- */

const MODE_LABEL: Record<string, string> = { job: 'job', views: 'views', respond: 'respond', debate: 'debate', chain: 'chain', patch: 'patch' };

function ThreadList({ goal, room, name, live, onRespond, onPin, onAnswer, onOpenCommit }: {
  goal: Goal;
  room: RoomView;
  name: (n: string) => ReactNode;
  live: boolean;
  onRespond: (m: RoomMsg) => void;
  onPin: (t: string) => void;
  onAnswer: (n: string) => void;
  onOpenCommit: (sha: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const count = room.messages.length + room.thread.length;
  useEffect(() => {
    if (stuck) bottom.current?.scrollIntoView({ block: 'end' });
  }, [count, stuck, room.coordinating]);
  const working = goal.agents.filter(a => !a.quick && ['starting', 'working'].includes(a.state));

  const item = (it: ThreadItem, depth: number): ReactNode => {
    if (it.kind === 'round') return <div key={`r${it.e.seq}`} className="thread-round">Round {String(it.e.data.round)} of {String(it.e.data.rounds)}</div>;
    if (it.kind === 'merged')
      return (
        <div key={`m${it.e.seq}`} className="thread-note">
          ⤵ Merged {String(it.e.data.commits)} commit{Number(it.e.data.commits) > 1 ? 's' : ''} from <span className="mono">{String(it.e.data.branch)}</span> into <span className="mono">{String(it.e.data.into)}</span>
        </div>
      );
    if (it.kind === 'commit') {
      const d = it.e.data;
      return (
        <div key={`c${it.e.seq}`} className="card commit-card">
          <div className="card-head">
            {name(it.e.agent ?? 'human')}
            <span className="verb">committed</span>
            <button className="btn ghost small mono" onClick={() => onOpenCommit(String(d.sha))} title="Open it in the Git tab">
              {String(d.sha).slice(0, 7)}
            </button>
            <span className="t meta">{clock(it.e.ts)}</span>
          </div>
          <div>{String(d.summary)}</div>
          <div className="meta">
            {String(d.files)} file{d.files === 1 ? '' : 's'} · <span className="add">+{String(d.added)}</span> <span className="del">−{String(d.removed)}</span>
          </div>
        </div>
      );
    }
    return (
      <div key={it.m.id} className={depth ? 'thread-child' : undefined}>
        <Message m={it.m} room={room} name={name} live={live} onRespond={onRespond} onPin={onPin} onAnswer={onAnswer} />
        {it.children.length > 0 && <div className={`thread-children${depth >= 3 ? ' flat' : ''}`}>{it.children.map(c => item(c, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <div
      className="scroll thread"
      ref={scroller}
      onScroll={() => {
        const s = scroller.current!;
        const at = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
        if (at !== stuck) setStuck(at);
      }}
    >
      <div className="card goal-start">
        <div className="card-head">
          <span className="label">Room</span>
          <span className="t meta">{clock(goal.createdAt)}</span>
        </div>
        <Markdown text={goal.request} />
        {room.from && <div className="muted small">Carried over from {room.from}: see the board.</div>}
      </div>
      {room.thread.map(it => item(it, 0))}
      {room.coordinating && (
        <div className="thread-coord busy">
          <b>◆</b> the coordinator is {room.coordinating === 'route' ? 'choosing who answers' : 'deciding what’s next'}…
        </div>
      )}
      {working.map(a => (
        <div key={a.name} className="thread-working">
          <Dot state={a.state} /> {name(a.name)} <span className="muted">{room.writers.has(a.name) ? 'is patching' : 'is working'}{a.status ? `: ${oneLine(a.status, 100)}` : '…'}</span>
        </div>
      ))}
      {!room.messages.length && <div className="empty">Ask the room something below. Nobody picked: the coordinator picks who answers.</div>}
      <div ref={bottom} />
    </div>
  );
}

function Message({ m, room, name, live, onRespond, onPin, onAnswer }: { m: RoomMsg; room: RoomView; name: (n: string) => ReactNode; live: boolean; onRespond: (m: RoomMsg) => void; onPin: (t: string) => void; onAnswer: (n: string) => void }) {
  const [open, setOpen] = useState(false);
  if (m.kind === 'note') return <div className="thread-note">{oneLine(m.text, 600)}</div>;
  const toList = m.to.map(t => (t === 'human' ? 'you' : t === 'coordinator' ? '◆' : t)).join(', ');
  if (m.kind === 'route' && m.parts) {
    // A split question: the plan, in order; each part follows with its answers under it.
    return (
      <div className="thread-coord split">
        <b>◆</b> split in {m.parts.length} parts: {m.text}
        <ol className="split-parts">
          {m.parts.map((p, i) => (
            <li key={i}>
              <b>{p.to}</b>
              {p.after.length > 0 && <span className="muted"> after {p.after.join(', ')}</span>}: {p.ask}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (m.kind === 'part') {
    return (
      <div className="thread-coord part">
        <b>◆</b> → <b>{m.to.join(', ')}</b> <span className="mode-tag">part {m.part} of {m.of}</span>
        {m.after?.length ? <span className="muted">with {m.after.join(' and ')}’s answers</span> : null}: {m.text}
      </div>
    );
  }
  if (m.kind === 'route' || m.kind === 'forward' || m.kind === 'compare') {
    return (
      <div className={`thread-coord ${m.kind}`}>
        <b>◆</b> {m.kind === 'compare' ? '⇄' : '→'} <b>{m.to.join(', ')}</b>
        {m.mode && m.mode !== 'ask' && <span className={`mode-tag ${m.mode}`}>{m.mode}</span>}: {m.kind === 'route' ? m.text : m.line || oneLine(m.text, 140)}
        {m.kind !== 'route' && (
          <button className="btn ghost small" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? 'hide' : 'what it asked'}
          </button>
        )}
        {open && <div className="quote">{m.text}</div>}
      </div>
    );
  }
  if (m.kind === 'back') {
    return (
      <div className="thread-back">
        <div className="card-head">
          <b className="coord-name">◆ back to you</b>
          <span className="t meta">{clock(m.ts)}</span>
        </div>
        <Markdown text={m.text} />
      </div>
    );
  }
  if (m.from === 'human') {
    const quoted = m.replyTo ? room.byId.get(m.replyTo) : undefined;
    return (
      <div className="msg-you">
        <div className="card-head">
          <b className="you">you</b>
          <span className="verb">→ {m.to.includes('coordinator') ? 'the room' : toList}</span>
          {m.mode && MODE_LABEL[m.mode] && <span className={`mode-tag ${m.mode}`}>{m.mode}{m.rounds ? ` ×${m.rounds}` : ''}</span>}
          <span className="t meta">{clock(m.ts)}</span>
        </div>
        {quoted && <div className="quote">{quoted.from === 'human' ? 'you' : quoted.from}: {oneLine(quoted.text, 200)}</div>}
        <Markdown text={m.text} />
      </div>
    );
  }
  if (m.kind === 'aside') {
    return (
      <div className="card room-msg aside">
        <div className="card-head">
          {name(m.from)}
          <span className="verb">→ {toList}{!room.open && !m.to.includes('coordinator') ? ' (the coordinator decides)' : ''}</span>
          <span className="t meta">{clock(m.ts)}</span>
        </div>
        <More lines={3}>
          <Markdown text={m.text} />
        </More>
      </div>
    );
  }
  const hidden = m.held && m.flow && !room.revealed.has(m.flow);
  return (
    <div className={`card room-msg ${m.kind}${hidden ? ' held' : ''}`}>
      <div className="card-head">
        {name(m.from)}
        {m.kind === 'question' && <span className="mode-tag question">asks you</span>}
        {m.mode && MODE_LABEL[m.mode] && <span className={`mode-tag ${m.mode}`}>{m.mode}{m.round && m.mode === 'debate' ? ` · round ${m.round}` : ''}</span>}
        <span className="t meta">{clock(m.ts)}</span>
      </div>
      {hidden ? (
        <div className="muted small">Answered. Shown once everyone asked has answered, so nobody sees another’s view first.</div>
      ) : (
        <>
          <More lines={8}>
            <Markdown text={m.text} />
          </More>
          {live && (
            <div className="msg-actions">
              {m.kind === 'question' ? (
                <button className="btn ghost small" onClick={() => onAnswer(m.from)}>
                  Answer {m.from}
                </button>
              ) : (
                <button className="btn ghost small" onClick={() => onRespond(m)} title="Have someone respond to this (pick them on the canvas)">
                  ↩ Respond
                </button>
              )}
              <button className="btn ghost small" onClick={() => onPin(m.text)} title="Add it to the board as a finding">
                Pin to board
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- the board ---------------- */

/** What the room found, still asks, and settled, kept by the coordinator and by you; and where the room goes from here. */
function Board({ goal, room, live, events, onCommand, onOpenFile, onStartGoal, onNewRoom }: {
  goal: Goal;
  room: RoomView;
  live: boolean;
  events: MhEvent[];
  onCommand: Props['onCommand'];
  onOpenFile: (path: string) => void;
  onStartGoal: () => void;
  onNewRoom: () => void;
}) {
  const [kind, setKind] = useState<BoardItem['kind']>('finding');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [savingCast, setSavingCast] = useState<string>();
  const op = (o: Record<string, unknown>) => void onCommand({ cmd: 'room.board', goal: goal.id, ops: [o] });
  const add = () => {
    if (!text.trim()) return;
    op({ op: 'add', kind, text: text.trim() });
    setText('');
  };
  const shared = goal.sharedDir.endsWith('/') ? goal.sharedDir : `${goal.sharedDir}/`;
  const designPath = `${shared}room/design.md`;
  const hasDesign = events.some(e => e.type === 'shared.write' && /(^|\/)design\.md$/.test(String(e.data.path)));
  const writer = room.cast.find(c => /bigger picture/i.test(c.responsibility ?? '') || c.role === 'designer') ?? room.cast.find(c => c.role === 'architect') ?? room.cast[0];
  const writeDesign = () =>
    writer &&
    void onCommand({
      cmd: 'room.post', goal: goal.id, to: [writer.name], mode: 'job',
      text: `Write the design for a goal to carry out, as ${designPath}: the problem, what we decided and why, the plan in steps, what to test, and the risks still open. Work from the board and the thread. Answer with a short summary.`,
    });
  const ending = room.status?.ending;
  return (
    <div className="board">
      <div className="board-scroll">
        {BOARD_SECTIONS.map(sec => {
          const items = room.board.filter(i => i.kind === sec.kind);
          if (!items.length) return null;
          return (
            <section key={sec.kind}>
              <div className="kicker">{sec.label}</div>
              {items.map(i => (
                <div key={i.id} className={`board-item ${i.kind}${i.closed ? ' closed' : ''}`}>
                  {editing?.id === i.id ? (
                    <input
                      type="text"
                      autoFocus
                      value={editing.text}
                      onChange={e => setEditing({ id: i.id, text: e.target.value })}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          op({ op: 'edit', id: i.id, text: editing.text });
                          setEditing(undefined);
                        }
                        if (e.key === 'Escape') setEditing(undefined);
                      }}
                      onBlur={() => setEditing(undefined)}
                    />
                  ) : i.kind === 'file' && i.text.startsWith(shared) ? (
                    <button className="name-link mono small" onClick={() => onOpenFile(i.text.slice(shared.length))} title={i.text}>
                      {i.text.slice(shared.length)}
                    </button>
                  ) : i.kind === 'file' ? (
                    // Another goal's or room's file: its path, to read where it is.
                    <span className="board-text mono small" title={i.text}>
                      {i.text.split('/').slice(-3).join('/')}
                    </span>
                  ) : (
                    <span className="board-text">{i.text}</span>
                  )}
                  <span className="board-by" title={`Added by ${i.by === COORDINATOR ? 'the coordinator' : i.by === 'human' ? 'you' : i.by}`}>
                    {i.by === COORDINATOR ? '◆' : i.by === 'human' ? 'you' : '↩'}
                  </span>
                  {live && (
                    <span className="board-actions">
                      {i.kind === 'question' && (
                        <button className="btn ghost small" onClick={() => op({ op: 'close', id: i.id, closed: !i.closed })} title={i.closed ? 'Open it again' : 'Mark it answered'}>
                          {i.closed ? '↺' : '✓'}
                        </button>
                      )}
                      {i.kind !== 'file' && (
                        <button className="btn ghost small" onClick={() => setEditing({ id: i.id, text: i.text })} title="Edit">
                          ✎
                        </button>
                      )}
                      <button className="btn ghost small" onClick={() => op({ op: 'remove', id: i.id })} title="Remove">
                        ×
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </section>
          );
        })}
        {!room.board.length && <div className="empty">Nothing on the board yet. The coordinator notes findings, open questions and decisions as answers come in; you can too.</div>}
        {live && (
          <div className="board-add">
            <select value={kind} onChange={e => setKind(e.target.value as BoardItem['kind'])} aria-label="Kind">
              {BOARD_SECTIONS.map(s => (
                <option key={s.kind} value={s.kind}>
                  {s.label}
                </option>
              ))}
            </select>
            <input type="text" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="Add to the board" />
          </div>
        )}
      </div>
      <div className="board-foot">
        {ending && live && <div className="muted small">The coordinator suggests {ending === 'design' ? 'writing a design' : ending === 'patch' ? 'a patch here' : 'starting a goal'}.</div>}
        {live && writer && (
          <button className={`btn small${ending === 'design' ? ' on' : ''}`} onClick={writeDesign} title={`${writer.name} writes ${designPath} from the board and the thread`}>
            Write the design
          </button>
        )}
        {hasDesign && (
          <button className="btn ghost small" onClick={() => onOpenFile('room/design.md')}>
            Open design.md
          </button>
        )}
        <button className={`btn small${ending === 'goal' ? ' on' : ''}`} onClick={onStartGoal} title="A goal that carries out what the room settled; its lead reads the board and the design">
          Start a goal from this
        </button>
        <button className="btn ghost small" onClick={onNewRoom} title="A new room that starts with this board, e.g. after a goal tried it">
          New room from this
        </button>
        {room.cast.length > 0 &&
          (savingCast === undefined ? (
            <button className="btn ghost small" onClick={() => setSavingCast('')} title="Save this room's seats to start the next room with">
              Save the cast…
            </button>
          ) : (
            <span className="row start">
              <input type="text" autoFocus value={savingCast} onChange={e => setSavingCast(e.target.value)} placeholder="name, e.g. bug-hunt" className="cast-name" />
              <button
                className="btn small"
                disabled={!savingCast.trim()}
                onClick={async () => {
                  const cast = room.cast.map(({ role, on, responsibility, stance }) => ({ role, on, responsibility, stance }));
                  if (await onCommand({ cmd: 'cast.save', name: savingCast.trim(), participants: cast })) setSavingCast(undefined);
                }}
              >
                Save
              </button>
            </span>
          ))}
      </div>
    </div>
  );
}
