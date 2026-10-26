import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent, CanvasCard, CardKind, ConfigView, Goal, Lens, MhEvent } from '../types.ts';
import { CARD_KINDS, lensWhat, responsibilityLabel, type ChatItem, type RoomMsg, type RoomView as Room } from '../roomData.ts';
import { clock, oneLine } from '../format.ts';
import { Dot, Markdown, More, useNow } from '../components/common.tsx';
import { LensEditor, lensProblem } from '../components/Room.tsx';
import { Splitter } from '../components/Splitter.tsx';
import { agentColors } from '../agentColors.ts';
import { FileSide } from './Files.tsx';
import { fileMentions, filesNamed, type FileLinks } from '../fileLinks.tsx';

interface Props {
  goal: Goal;
  events: MhEvent[];
  room: Room;
  config?: ConfigView;
  onCommand: (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onSelectAgent: (name: string) => void;
  onOpenCommit: (sha: string) => void;
  /** The shared file open in the chat's place (the page's), and opening or closing one. */
  file?: string;
  onFile: (path?: string) => void;
  onFilesTab: () => void;
  /** A new room from some of this one's cards: a branch. */
  onBranch: (cards: CanvasCard[]) => void;
  /** Opens another room, e.g. one a card branched into. */
  onRoom: (id: string) => void;
}

const busy = (a?: Agent) => !!a && ['starting', 'working'].includes(a.state);

/**
 * A brainstorm room (design §21): you talk with the lead in the chat; the lead keeps the canvas
 * beside it, cards with links, and sends lenses (the bar above the canvas) to look into things.
 * Pick cards to ask the lead about one, branch them into a room of their own, or settle them.
 */
export default function RoomView({ goal, events, room, config, onCommand, onSelectAgent, onOpenCommit, file, onFile, onFilesTab, onBranch, onRoom }: Props) {
  const live = goal.live && goal.status !== 'ended';
  const color = useMemo(() => agentColors(goal), [goal]);
  const [picked, setPicked] = useState<string[]>([]);
  const [about, setAbout] = useState<string>();
  const fileRe = useMemo(() => fileMentions(events, goal.sharedDir), [events, goal.sharedDir]);
  const files: FileLinks = { re: fileRe, open: onFile };
  const lead = goal.agents.find(a => a.name === goal.lead);
  useEffect(() => {
    // Cards that went away (removed) aren't picked any more.
    setPicked(p => p.filter(id => room.cards.some(c => c.id === id)));
    if (about && !room.cards.some(c => c.id === about)) setAbout(undefined);
  }, [room.cards, about]);
  useEffect(() => {
    if (!file) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.closest?.('input, textarea, select') || document.querySelector('.backdrop')) return;
      onFile(undefined);
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  });
  const who = (n: string) =>
    n === 'human' ? (
      <b className="you">you</b>
    ) : n === 'MetaHarness' ? (
      <b>MetaHarness</b>
    ) : (
      <button className="name-link" style={{ color: color(n) }} onClick={() => onSelectAgent(n)}>
        {n}
      </button>
    );

  return (
    <div className="room-wrap">
      <div className="room-chat">
        {file ? (
          <>
            <div className="room-chat-head">
              <button className="btn ghost small" onClick={() => onFile(undefined)} title="Back to the chat (Esc)">
                ← Chat
              </button>
              <span className="grow" />
              <button className="btn ghost small" onClick={onFilesTab} title="Read it in the Files tab, with the whole shared folder beside it">
                Open in Files
              </button>
            </div>
            <FileSide key={file} goal={goal} events={events} path={file} onSelectAgent={onSelectAgent} />
          </>
        ) : (
          <>
            <div className="room-chat-head">
              {lead ? <Dot state={lead.state} /> : <span className="dot unstarted" />}
              <button className="name-link" style={{ color: color(goal.lead) }} onClick={() => goal.lead && onSelectAgent(goal.lead)}>
                {goal.lead || 'lead'}
              </button>
              {lead && (
                <span className="muted small ellipsis" title={`${lead.role} · ${lead.harness} · ${lead.model}`}>
                  {lead.harness} · {lead.model}
                </span>
              )}
              <span className="grow" />
              {live && busy(lead) && (
                <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.stop', goal: goal.id, agent: goal.lead })} title="Stop the lead's turn: what it said so far is its reply, and it listens again">
                  ■ Stop
                </button>
              )}
            </div>
            <Chat goal={goal} room={room} who={who} files={files} live={live} lead={lead} onCard={id => setPicked([id])} onOpenCommit={onOpenCommit} />
            {live && <Composer goal={goal} room={room} about={about} onClearAbout={() => setAbout(undefined)} onCommand={onCommand} />}
          </>
        )}
      </div>
      <Splitter pane="room-chat" grow="right" min={300} max={900} label="Chat" />
      <div className="room-board">
        <LensBar goal={goal} room={room} config={config} live={live} color={color} onCommand={onCommand} onOpen={onSelectAgent} />
        <CanvasBoard
          goal={goal}
          room={room}
          live={live}
          color={color}
          picked={picked}
          files={files}
          onPick={(id, add) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : add ? [...p, id] : [id]))}
          onClear={() => setPicked([])}
          onAsk={id => setAbout(id)}
          onBranch={ids => onBranch(room.cards.filter(c => ids.includes(c.id)))}
          onRoom={onRoom}
          onCommand={onCommand}
        />
      </div>
    </div>
  );
}

/* ---------------- the chat ---------------- */

function Chat({ goal, room, who, files, live, lead, onCard, onOpenCommit }: { goal: Goal; room: Room; who: (n: string) => ReactNode; files: FileLinks; live: boolean; lead?: Agent; onCard: (id: string) => void; onOpenCommit: (sha: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  // At the bottom, the chat follows what's said; scrolled up, it stays put.
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const s = scroller.current!;
    const follow = () => {
      if (stuck.current) s.scrollTop = s.scrollHeight;
    };
    const ro = new ResizeObserver(follow);
    const watch = () => {
      ro.disconnect();
      ro.observe(s);
      for (const c of s.children) ro.observe(c);
    };
    const mo = new MutationObserver(() => {
      watch();
      follow();
    });
    mo.observe(s, { childList: true });
    watch();
    follow();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  const lenses = goal.agents.filter(a => a.name !== goal.lead && !a.quick && busy(a));
  const item = (it: ChatItem): ReactNode => {
    if (it.kind === 'merged')
      return (
        <div key={`m${it.e.seq}`} className="thread-note">
          ⤵ Merged {String(it.e.data.commits)} commit{Number(it.e.data.commits) > 1 ? 's' : ''} from <span className="mono">{String(it.e.data.branch)}</span> into <span className="mono">{String(it.e.data.into)}</span>
        </div>
      );
    if (it.kind === 'commit') {
      const d = it.e.data;
      return (
        <div key={`c${it.e.seq}`} className="chat-line commit">
          {who(it.e.agent ?? 'human')} committed{' '}
          <button className="btn ghost small mono" onClick={() => onOpenCommit(String(d.sha))} title="Open it in the Git tab">
            {String(d.sha).slice(0, 7)}
          </button>{' '}
          {String(d.summary)} <span className="add">+{String(d.added)}</span> <span className="del">−{String(d.removed)}</span>
        </div>
      );
    }
    return <Message key={it.m.id} m={it.m} room={room} who={who} files={files} onCard={onCard} />;
  };
  return (
    <div
      className="scroll chat"
      ref={scroller}
      onScroll={() => {
        const s = scroller.current!;
        stuck.current = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
      }}
    >
      <div className="chat-topic">
        <span className="label">Room</span> <span className="t meta">{clock(goal.createdAt)}</span>
        <Markdown text={goal.request} />
        {room.from && <div className="muted small">Carried over from {room.from}: see the canvas.</div>}
      </div>
      {room.chat.map(item)}
      {live && busy(lead) && (
        <div className="chat-typing">
          <Dot state="working" /> {who(goal.lead)} <span className="muted">{lead?.status ? oneLine(lead.status, 100) : 'is thinking…'}</span>
        </div>
      )}
      {lenses.map(a => (
        <div key={a.name} className="chat-typing lens">
          <Dot state={a.state} /> {who(a.name)} <span className="muted">{room.writers.has(a.name) ? 'is patching' : 'is looking'}{a.status ? `: ${oneLine(a.status, 100)}` : '…'}</span>
        </div>
      ))}
    </div>
  );
}

/** The shared files a message names, as chips that open them beside the canvas. */
function FileChips({ text, files }: { text: string; files: FileLinks }) {
  const named = filesNamed(text, files);
  if (!named.length) return null;
  return (
    <div className="file-chips">
      {named.map(p => (
        <button key={p} className="file-chip" onClick={() => files.open(p)} title={`Read shared/${p} in the chat's place`}>
          📄 {p}
        </button>
      ))}
    </div>
  );
}

function Message({ m, room, who, files, onCard }: { m: RoomMsg; room: Room; who: (n: string) => ReactNode; files: FileLinks; onCard: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (m.kind === 'note') return <div className="thread-note">{oneLine(m.text, 600)}</div>;
  if (m.kind === 'ask') {
    const card = m.card ? room.cards.find(c => c.id === m.card) : undefined;
    return (
      <div className="chat-you">
        {m.card && (
          <button className="card-chip" onClick={() => onCard(m.card!)} title="Show the card">
            {card ? `${m.card} · ${oneLine(card.title, 50)}` : m.card}
          </button>
        )}
        <Markdown text={m.text} />
        <span className="t meta">{clock(m.ts)}</span>
      </div>
    );
  }
  if (m.kind === 'reply') {
    return (
      <div className="chat-lead">
        <div className="card-head">
          {who(m.from)}
          {m.stopped && <span className="mode-tag stopped" title="You stopped it here: this is what it had said">stopped</span>}
          <span className="t meta">{clock(m.ts)}</span>
        </div>
        <More lines={14}>
          <Markdown text={m.text} files={files} />
        </More>
        <FileChips text={m.text} files={files} />
      </div>
    );
  }
  // A lens sent, or a lens's answer: one line each, the whole of it a click away.
  return (
    <div className={`chat-line ${m.kind}`}>
      {m.kind === 'dispatch' ? (
        <>
          → {who(m.to[0] ?? '')}
          {m.patch && <span className="mode-tag patch">patch</span>}
        </>
      ) : (
        <>
          ↩ {who(m.from)}
          {m.stopped && <span className="mode-tag stopped">stopped</span>}
        </>
      )}
      <button className="chat-line-text" onClick={() => setOpen(o => !o)} aria-expanded={open} title={open ? 'Fold' : 'Read all of it'}>
        {oneLine(m.text, 140)}
      </button>
      <span className="t meta">{clock(m.ts)}</span>
      {open && (
        <div className="quote">
          <Markdown text={m.text} files={files} />
        </div>
      )}
      <FileChips text={m.text} files={files} />
    </div>
  );
}

function Composer({ goal, room, about, onClearAbout, onCommand }: { goal: Goal; room: Room; about?: string; onClearAbout: () => void; onCommand: Props['onCommand'] }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const card = about ? room.cards.find(c => c.id === about) : undefined;
  useEffect(() => {
    if (about) ref.current?.focus();
  }, [about]);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const r = await onCommand({ cmd: 'room.post', goal: goal.id, text: text.trim(), ...(about ? { card: about } : {}) });
    setSending(false);
    if (r) {
      setText('');
      onClearAbout();
    }
  };
  return (
    <div className="composer">
      {card && (
        <div className="composer-about">
          About <span className="card-chip">{card.id} · {oneLine(card.title, 60)}</span>
          <button className="btn ghost small" onClick={onClearAbout} aria-label="Not about this card">
            ×
          </button>
        </div>
      )}
      <div className="composer-input">
        <textarea
          ref={ref}
          rows={2}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={card ? `What about ${card.id}?` : `Talk it through with ${goal.lead || 'the lead'}…`}
          aria-label="Message to the lead"
        />
        <button className="btn primary" disabled={!text.trim() || sending} onClick={() => void send()} title="Enter sends, Shift+Enter starts a new line">
          Send
        </button>
      </div>
    </div>
  );
}

/* ---------------- the lenses ---------------- */

/** The lenses the lead may send: what each is for, what it's doing, and stopping or putting one away. */
function LensBar({ goal, room, config, live, color, onCommand, onOpen }: { goal: Goal; room: Room; config?: ConfigView; live: boolean; color: (n?: string) => string; onCommand: Props['onCommand']; onOpen: (n: string) => void }) {
  const [adding, setAdding] = useState<Lens>();
  const presets = config?.responsibilities ?? [];
  const doing = (p: Lens, a?: Agent) => {
    if (p.off) return busy(a) ? 'finishing, then away' : 'put away';
    if (!a) return 'not sent yet';
    if (room.writers.has(p.name!) && busy(a)) return `patching${a.status ? `: ${a.status}` : '…'}`;
    if (busy(a)) return a.status || 'looking…';
    return a.state === 'done' || a.state === 'idle' ? 'ready' : a.state;
  };
  return (
    <div className="lens-bar">
      <span className="kicker">Lenses</span>
      {room.lenses.map(p => {
        const a = goal.agents.find(x => x.name === p.name);
        return (
          <div key={p.name} className={`lens-chip${busy(a) ? ' busy' : ''}${a ? '' : ' unstarted'}${p.off ? ' off' : ''}`} title={`${p.name}: ${lensWhat(p)}${a ? ` · ${a.harness}/${a.model}` : p.on ? ` · ${p.on}` : ''}\n${p.responsibility ?? ''}${p.stance ? `\nStance: ${p.stance}` : ''}`}>
            {a ? <Dot state={a.state} /> : <span className="dot unstarted" />}
            <button className="name-link" style={{ color: color(p.name) }} onClick={() => a && onOpen(p.name!)} disabled={!a}>
              {p.name}
            </button>
            <span className="lens-resp">{responsibilityLabel(p.responsibility, presets) || lensWhat(p)}</span>
            <span className="lens-now">{doing(p, a)}</span>
            {live && busy(a) && (
              <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.stop', goal: goal.id, agent: p.name })} title="Stop it: what it found so far goes to the lead">
                ■
              </button>
            )}
            {live && (
              <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.lensOff', goal: goal.id, lens: p.name, off: !p.off })} title={p.off ? 'Make it available to the lead again' : 'Put it away: the lead can’t send it until you bring it back'}>
                {p.off ? '↺' : '⏻'}
              </button>
            )}
          </div>
        );
      })}
      {!room.lenses.length && <span className="muted small">No lenses: the lead can only talk.</span>}
      {live && !adding && (
        <button className="btn small" onClick={() => setAdding({ role: config?.roles.some(r => r.name === 'reviewer') ? 'reviewer' : undefined })} title="Another role, the same role on another model, or just a model">
          + Lens
        </button>
      )}
      {adding && (
        <div className="lens-add">
          <LensEditor lens={adding} config={config} onChange={setAdding} />
          <div className="row end">
            {lensProblem(adding) && <span className="warn-text small">{lensProblem(adding)}</span>}
            <button className="btn ghost small" onClick={() => setAdding(undefined)}>
              Cancel
            </button>
            <button
              className="btn small primary"
              disabled={!!lensProblem(adding)}
              onClick={async () => {
                if (await onCommand({ cmd: 'room.lens', goal: goal.id, ...adding })) setAdding(undefined);
              }}
            >
              Add the lens
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- the canvas ---------------- */

const FRESH_MS = 12_000;
const KIND_ORDER = new Map(CARD_KINDS.map((k, i) => [k.kind, i]));

interface Wire {
  from: string;
  to: string;
  label?: string;
  d: string;
}

function CanvasBoard({ goal, room, live, color, picked, files, onPick, onClear, onAsk, onBranch, onRoom, onCommand }: {
  goal: Goal;
  room: Room;
  live: boolean;
  color: (n?: string) => string;
  picked: string[];
  files: FileLinks;
  onPick: (id: string, add: boolean) => void;
  onClear: () => void;
  onAsk: (id: string) => void;
  onBranch: (ids: string[]) => void;
  onRoom: (id: string) => void;
  onCommand: Props['onCommand'];
}) {
  const now = useNow(2000);
  const box = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const [wires, setWires] = useState<Wire[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string>();
  const [adding, setAdding] = useState<{ kind: CardKind; title: string }>();
  const [measure, setMeasure] = useState(0);
  const op = (o: Record<string, unknown>) => void onCommand({ cmd: 'room.canvas', goal: goal.id, ops: [o] });
  // A column for each kind of card there is: open cards first, settled and dropped ones sink to the bottom.
  const columns = useMemo(
    () =>
      CARD_KINDS.map(k => ({ ...k, cards: room.cards.filter(c => c.kind === k.kind).sort((a, b) => Number(!!a.status) - Number(!!b.status)) })).filter(
        k => k.cards.length,
      ),
    [room.cards],
  );

  // Links are drawn between the cards where they ended up: measured after layout, and again whenever a card changes size.
  useEffect(() => {
    const ro = new ResizeObserver(() => setMeasure(m => m + 1));
    if (box.current) ro.observe(box.current);
    for (const el of els.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [room.cards, picked]);
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const base = b.getBoundingClientRect();
    const at = (id: string) => {
      const r = els.current.get(id)?.getBoundingClientRect();
      return r && { l: r.left - base.left + b.scrollLeft, r: r.right - base.left + b.scrollLeft, t: r.top - base.top + b.scrollTop, h: r.height };
    };
    const kindOf = new Map(room.cards.map(c => [c.id, KIND_ORDER.get(c.kind) ?? 0]));
    const out: Wire[] = [];
    for (const l of room.links) {
      const a = at(l.from);
      const z = at(l.to);
      if (!a || !z) continue;
      const ka = kindOf.get(l.from)!;
      const kz = kindOf.get(l.to)!;
      const ya = a.t + Math.min(a.h / 2, 22);
      const yz = z.t + Math.min(z.h / 2, 22);
      let d: string;
      if (ka === kz) {
        // In the same column: a loop out on its right.
        const x = Math.max(a.r, z.r);
        const out = 28 + Math.min(40, Math.abs(yz - ya) / 6);
        d = `M ${a.r} ${ya} C ${x + out} ${ya}, ${x + out} ${yz}, ${z.r} ${yz}`;
      } else {
        const [x1, x2] = ka < kz ? [a.r, z.l] : [a.l, z.r];
        const bend = Math.max(30, Math.abs(x2 - x1) / 2.4);
        const s = ka < kz ? 1 : -1;
        d = `M ${x1} ${ya} C ${x1 + s * bend} ${ya}, ${x2 - s * bend} ${yz}, ${x2} ${yz}`;
      }
      out.push({ from: l.from, to: l.to, ...(l.label ? { label: l.label } : {}), d });
    }
    setWires(out);
    setSize({ w: b.scrollWidth, h: b.scrollHeight });
  }, [room.cards, room.links, measure, picked]);

  const lit = hover ?? (picked.length === 1 ? picked[0] : undefined);
  const near = useMemo(() => {
    if (!lit) return undefined;
    const s = new Set([lit]);
    for (const l of room.links) {
      if (l.from === lit) s.add(l.to);
      if (l.to === lit) s.add(l.from);
    }
    return s;
  }, [lit, room.links]);
  const sel = room.cards.filter(c => picked.includes(c.id));
  const shared = goal.sharedDir.endsWith('/') ? goal.sharedDir : `${goal.sharedDir}/`;

  return (
    <div className="canvas-wrap">
      <div className="canvas-tools">
        {sel.length ? (
          <>
            <span className="muted small">
              {sel.length} card{sel.length > 1 ? 's' : ''} picked
            </span>
            {live && sel.length === 1 && (
              <button className="btn small" onClick={() => onAsk(sel[0].id)} title="Your next message to the lead is about this card">
                Ask about it
              </button>
            )}
            <button className="btn small" onClick={() => onBranch(sel.map(c => c.id))} title="A room of its own for this topic: it starts with these cards and the ones linked to them">
              ⑂ Branch
            </button>
            {live && (
              <>
                <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.canvas', goal: goal.id, ops: sel.map(c => ({ op: c.status === 'settled' ? 'reopen' : 'settle', id: c.id })) })} title="Settled: answered, done or agreed. Again: open">
                  ✓ Settle
                </button>
                <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.canvas', goal: goal.id, ops: sel.map(c => ({ op: c.status === 'dropped' ? 'reopen' : 'drop', id: c.id })) })} title="Dropped: turned down, or proved wrong. Again: open">
                  ✗ Drop
                </button>
                {sel.length === 2 && (
                  <button className="btn ghost small" onClick={() => op({ op: 'link', from: picked[0], to: picked[1] })} title={`Link ${picked[0]} to ${picked[1]}`}>
                    ⟶ Link
                  </button>
                )}
              </>
            )}
            <button className="btn ghost small" onClick={onClear}>
              Clear
            </button>
          </>
        ) : (
          <span className="muted small">{room.cards.length ? 'Click a card to read it; shift-click picks more.' : ''}</span>
        )}
        <span className="grow" />
        {live &&
          (adding ? (
            <span className="card-add">
              <select value={adding.kind} onChange={e => setAdding({ ...adding, kind: e.target.value as CardKind })} aria-label="Kind">
                {CARD_KINDS.map(k => (
                  <option key={k.kind} value={k.kind}>
                    {k.label.replace(/s$/, '').replace('Decided', 'Decision')}
                  </option>
                ))}
              </select>
              <input
                type="text"
                autoFocus
                value={adding.title}
                onChange={e => setAdding({ ...adding, title: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter' && adding.title.trim()) {
                    op({ op: 'add', kind: adding.kind, title: adding.title.trim() });
                    setAdding(undefined);
                  }
                  if (e.key === 'Escape') setAdding(undefined);
                }}
                placeholder="A few words"
              />
            </span>
          ) : (
            <button className="btn ghost small" onClick={() => setAdding({ kind: 'idea', title: '' })} title="Put a card on the canvas yourself">
              + Card
            </button>
          ))}
      </div>
      <div className="canvas" ref={box} onClick={e => e.target === e.currentTarget && onClear()}>
        <svg className="canvas-wires" width={size.w} height={size.h} aria-hidden>
          <defs>
            <marker id="wire-end" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" className="wire-head" />
            </marker>
          </defs>
          {wires.map(w => {
            const on = near?.has(w.from) && near.has(w.to) && (w.from === lit || w.to === lit);
            return (
              <g key={`${w.from}-${w.to}`} className={`wire${on ? ' lit' : near ? ' dim' : ''}`}>
                <path d={w.d} markerEnd="url(#wire-end)">{w.label && <title>{w.label}</title>}</path>
              </g>
            );
          })}
        </svg>
        <div className="canvas-cols" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(180px, 280px))` }} onClick={e => e.target === e.currentTarget && onClear()}>
          {columns.map(col => (
            <div key={col.kind} className={`canvas-col ${col.kind}`} onClick={e => e.target === e.currentTarget && onClear()}>
              <div className="canvas-col-head" title={col.hint}>
                {col.label}
                {col.cards.length > 0 && <span className="muted"> {col.cards.length}</span>}
              </div>
              {col.cards.map(c => (
                <CardView
                  key={c.id}
                  card={c}
                  room={room}
                  live={live}
                  color={color}
                  open={picked.includes(c.id)}
                  dim={!!near && !near.has(c.id)}
                  fresh={now - (room.seen.get(c.id)?.added ?? 0) < FRESH_MS}
                  touched={now - (room.seen.get(c.id)?.changed ?? 0) < FRESH_MS}
                  files={files}
                  shared={shared}
                  refEl={el => (el ? els.current.set(c.id, el) : els.current.delete(c.id))}
                  onPick={add => onPick(c.id, add)}
                  onHover={on => setHover(on ? c.id : undefined)}
                  onRoom={onRoom}
                  onCommand={onCommand}
                  goal={goal}
                />
              ))}
            </div>
          ))}
        </div>
        {!room.cards.length && <div className="canvas-empty">As you talk, the lead puts the questions, ideas, findings and decisions here, linked to each other.</div>}
      </div>
    </div>
  );
}

function CardView({ card: c, room, goal, live, color, open, dim, fresh, touched, files, shared, refEl, onPick, onHover, onRoom, onCommand }: {
  card: CanvasCard;
  room: Room;
  goal: Goal;
  live: boolean;
  color: (n?: string) => string;
  open: boolean;
  dim: boolean;
  fresh: boolean;
  touched: boolean;
  files: FileLinks;
  shared: string;
  refEl: (el: HTMLElement | null) => void;
  onPick: (add: boolean) => void;
  onHover: (on: boolean) => void;
  onRoom: (id: string) => void;
  onCommand: Props['onCommand'];
}) {
  const [editing, setEditing] = useState<{ title: string; text: string }>();
  const by = c.by === 'human' ? 'you' : c.by;
  const byColor = c.by === 'human' ? 'var(--you)' : /^(room|goal) /.test(c.by) ? 'var(--text-3)' : color(c.by);
  const links = room.links.filter(l => l.from === c.id || l.to === c.id);
  const title = (id: string) => room.cards.find(x => x.id === id)?.title ?? id;
  const save = () => {
    if (!editing) return;
    void onCommand({ cmd: 'room.canvas', goal: goal.id, ops: [{ op: 'edit', id: c.id, title: editing.title, text: editing.text }] });
    setEditing(undefined);
  };
  return (
    <div
      ref={refEl}
      className={`canvas-card ${c.kind}${c.status ? ` ${c.status}` : ''}${open ? ' open' : ''}${dim ? ' dim' : ''}${fresh ? ' fresh' : touched ? ' touched' : ''}`}
      onClick={e => !(e.target as HTMLElement).closest('button, input, textarea, a') && onPick(e.shiftKey || e.ctrlKey || e.metaKey)}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && e.target === e.currentTarget && onPick(e.shiftKey)}
    >
      <div className="card-top">
        <span className="card-id">{c.id}</span>
        {c.status && <span className="card-status">{c.status}</span>}
        <span className="card-by" style={{ color: byColor }} title={`Added by ${by}`}>
          {by}
        </span>
      </div>
      {editing ? (
        <div className="card-edit" onKeyDown={e => e.key === 'Escape' && setEditing(undefined)}>
          <input type="text" autoFocus value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} onKeyDown={e => e.key === 'Enter' && save()} aria-label="Title" />
          <textarea rows={3} value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })} placeholder="More, if the title isn't enough" aria-label="Detail" />
          <div className="row end">
            <button className="btn ghost small" onClick={() => setEditing(undefined)}>
              Cancel
            </button>
            <button className="btn small primary" onClick={save} disabled={!editing.title.trim()}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="card-title">{c.title}</div>
      )}
      {!open && (c.text || c.notes?.length || c.refs?.length) ? (
        <div className="card-more">
          {c.text ? '¶ ' : ''}
          {c.refs?.length ? `${c.refs.length} file${c.refs.length > 1 ? 's' : ''} ` : ''}
          {c.notes?.length ? `${c.notes.length} note${c.notes.length > 1 ? 's' : ''}` : ''}
        </div>
      ) : null}
      {open && !editing && (
        <div className="card-body">
          {c.text && <Markdown text={c.text} files={files} />}
          {c.refs?.length ? (
            <div className="card-refs">
              {c.refs.map(r =>
                r.startsWith(shared) ? (
                  <button key={r} className="file-chip" onClick={() => files.open(r.slice(shared.length))} title={r}>
                    📄 {r.slice(shared.length)}
                  </button>
                ) : (
                  <span key={r} className="ref-chip mono" title={r}>
                    {r.split('/').slice(-2).join('/')}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {c.notes?.map((n, i) => (
            <div key={i} className="card-note">
              <b style={{ color: n.by === 'human' ? 'var(--you)' : color(n.by) }}>{n.by === 'human' ? 'you' : n.by}</b> {n.text}
            </div>
          ))}
          {links.length > 0 && (
            <div className="card-links">
              {links.map(l => (
                <div key={`${l.from}-${l.to}`}>
                  {l.from === c.id ? '→' : '←'} {l.label ? <i>{l.label}</i> : null} <span className="muted">{l.from === c.id ? l.to : l.from}</span> {oneLine(title(l.from === c.id ? l.to : l.from), 60)}
                </div>
              ))}
            </div>
          )}
          {c.branches?.map(b => (
            <button key={b} className="btn ghost small" onClick={() => onRoom(b)} title="Open the room it branched into">
              ⑂ room {b}
            </button>
          ))}
          {live && (
            <div className="card-actions">
              <button className="btn ghost small" onClick={() => setEditing({ title: c.title, text: c.text ?? '' })}>
                ✎ Edit
              </button>
              <button className="btn ghost small danger" onClick={() => void onCommand({ cmd: 'room.canvas', goal: goal.id, ops: [{ op: 'remove', id: c.id }] })}>
                Remove
              </button>
            </div>
          )}
        </div>
      )}
      {!open && c.branches?.length ? <div className="card-more">⑂ branched</div> : null}
    </div>
  );
}
