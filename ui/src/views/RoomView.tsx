import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent, CanvasCard, ConfigView, Goal, Lens, MhEvent } from '../types.ts';
import { lensWhat, responsibilityLabel, type RoomMsg, type RoomView as Room } from '../roomData.ts';
import { clock, oneLine } from '../format.ts';
import { Dot, Markdown, More } from '../components/common.tsx';
import { LensEditor, lensProblem } from '../components/Room.tsx';
import { Splitter } from '../components/Splitter.tsx';
import { agentColors } from '../agentColors.ts';
import { FileSide } from './Files.tsx';
import { fileMentions, filesNamed, type FileLinks } from '../fileLinks.tsx';
import { Board } from './Board.tsx';

interface Props {
  goal: Goal;
  events: MhEvent[];
  room: Room;
  config?: ConfigView;
  onCommand: (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onSelectAgent: (name: string) => void;
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
 * A brainstorm room (design §21): you talk with the lead in the chat; beside it is the board the
 * lead keeps, and the makers (the bar above the board) it sends, or you ask directly, to find
 * references and make images, demos and write-ups. Pick cards to mix them, ask about them,
 * frame, branch or settle them.
 */
export default function RoomView({ goal, events, room, config, onCommand, onSelectAgent, file, onFile, onFilesTab, onBranch, onRoom }: Props) {
  const live = goal.live && goal.status !== 'ended';
  const color = useMemo(() => agentColors(goal), [goal]);
  const [about, setAbout] = useState<string>();
  const fileRe = useMemo(() => fileMentions(events, goal.sharedDir), [events, goal.sharedDir]);
  const files: FileLinks = { re: fileRe, open: onFile };
  const lead = goal.agents.find(a => a.name === goal.lead);
  useEffect(() => {
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
            <Chat goal={goal} room={room} who={who} files={files} live={live} lead={lead} onCard={setAbout} />
            {live && <Composer goal={goal} room={room} about={about} onClearAbout={() => setAbout(undefined)} onCommand={onCommand} />}
          </>
        )}
      </div>
      <Splitter pane="room-chat" grow="right" min={300} max={900} label="Chat" />
      <div className="room-board">
        <MakerBar goal={goal} room={room} config={config} live={live} color={color} onCommand={onCommand} onOpen={onSelectAgent} />
        <Board goal={goal} room={room} live={live} color={color} files={files} onCommand={onCommand} onAskLead={setAbout} onBranch={ids => onBranch(room.cards.filter(c => ids.includes(c.id)))} onRoom={onRoom} />
      </div>
    </div>
  );
}

/* ---------------- the chat ---------------- */

function Chat({ goal, room, who, files, live, lead, onCard }: { goal: Goal; room: Room; who: (n: string) => ReactNode; files: FileLinks; live: boolean; lead?: Agent; onCard: (id: string) => void }) {
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
  const makers = goal.agents.filter(a => a.name !== goal.lead && !a.quick && busy(a));
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
        {room.from && <div className="muted small">Carried over from {room.from}: see the board.</div>}
      </div>
      {room.messages.map(m => (
        <Message key={m.id} m={m} room={room} who={who} files={files} onCard={onCard} />
      ))}
      {live && busy(lead) && (
        <div className="chat-typing">
          <Dot state="working" /> {who(goal.lead)} <span className="muted">{lead?.status ? oneLine(lead.status, 100) : 'is thinking…'}</span>
        </div>
      )}
      {makers.map(a => (
        <div key={a.name} className="chat-typing lens">
          <Dot state={a.state} /> {who(a.name)} <span className="muted">is making{a.status ? `: ${oneLine(a.status, 100)}` : '…'}</span>
        </div>
      ))}
    </div>
  );
}

/** The shared files a message names, as chips that open them in the chat's place. */
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
  // An ask to a maker (the lead's or yours), or a maker's answer: one line each, the whole of it a click away.
  return (
    <div className={`chat-line ${m.kind}${m.from === 'human' || m.to.includes('human') ? ' yours' : ''}`}>
      {m.kind === 'dispatch' ? (
        <>
          {m.from === 'human' && <>{who('human')} </>}→ {who(m.to[0] ?? '')}
        </>
      ) : (
        <>
          ↩ {who(m.from)}
          {m.to.includes('human') && <span className="muted"> to you</span>}
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

/* ---------------- the makers ---------------- */

const MAKES: Record<string, string> = { source: '↗ references', image: '▣ images', demo: '▶ demos', text: '¶ write-ups' };

/** The makers: what each makes, what it's doing, and stopping or putting one away. */
function MakerBar({ goal, room, config, live, color, onCommand, onOpen }: { goal: Goal; room: Room; config?: ConfigView; live: boolean; color: (n?: string) => string; onCommand: Props['onCommand']; onOpen: (n: string) => void }) {
  const [adding, setAdding] = useState<Lens>();
  const presets = config?.responsibilities ?? [];
  const doing = (p: Lens, a?: Agent) => {
    if (p.off) return busy(a) ? 'finishing, then away' : 'put away';
    if (!a) return 'not asked yet';
    if (busy(a)) return a.status || 'making…';
    return a.state === 'done' || a.state === 'idle' ? 'ready' : a.state;
  };
  return (
    <div className="lens-bar">
      <span className="kicker">Makers</span>
      {room.lenses.map(p => {
        const a = goal.agents.find(x => x.name === p.name);
        return (
          <div key={p.name} className={`lens-chip${busy(a) ? ' busy' : ''}${a ? '' : ' unstarted'}${p.off ? ' off' : ''}`} title={`${p.name}: ${lensWhat(p)}${a ? ` · ${a.harness}/${a.model}` : p.on ? ` · ${p.on}` : ''}${p.web ? ' · searches the web' : ''}${p.images ? ' · makes images' : ''}\n${p.responsibility ?? ''}${p.stance ? `\nStance: ${p.stance}` : ''}`}>
            {a ? <Dot state={a.state} /> : <span className="dot unstarted" />}
            <button className="name-link" style={{ color: color(p.name) }} onClick={() => a && onOpen(p.name!)} disabled={!a}>
              {p.name}
            </button>
            <span className="lens-resp">{(p.makes === 'text' && !['', 'Write'].includes(responsibilityLabel(p.responsibility, presets)) && responsibilityLabel(p.responsibility, presets)) || MAKES[p.makes ?? ''] || lensWhat(p)}</span>
            {p.makes === 'image' && !p.images && <span className="warn-text small" title="Its harness can't generate images here: it can only find reference images or draw SVG">no image tool</span>}
            <span className="lens-now">{doing(p, a)}</span>
            {live && busy(a) && (
              <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.stop', goal: goal.id, agent: p.name })} title="Stop it: what it has so far is its answer">
                ■
              </button>
            )}
            {live && (
              <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.lensOff', goal: goal.id, lens: p.name, off: !p.off })} title={p.off ? 'Make it available again' : 'Put it away: nobody can send it until you bring it back'}>
                {p.off ? '↺' : '⏻'}
              </button>
            )}
          </div>
        );
      })}
      {!room.lenses.length && <span className="muted small">No makers: the lead can only talk.</span>}
      {live && !adding && (
        <button className="btn small" onClick={() => setAdding({ role: config?.roles.some(r => r.name === 'writer') ? 'writer' : undefined })} title="Another role, the same role on another model, or just a model">
          + Maker
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
              Add the maker
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
