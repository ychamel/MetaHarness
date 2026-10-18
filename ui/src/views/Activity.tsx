import { useEffect, useMemo, useRef, useState } from 'react';
import { clock, eventKind, eventText, isOwnTool } from '../format.ts';
import type { MhEvent } from '../types.ts';

const KINDS = [
  ['all', 'Everything'],
  ['talk', 'Words and messages'],
  ['work', 'Tool calls'],
  ['git', 'Git and shared files'],
] as const;

/** Everything that happens on the goal, as it happens: `mh tail`, with filters. */
export function Activity({ events, agents, onSelectAgent }: { events: MhEvent[]; agents: string[]; onSelectAgent: (name: string) => void }) {
  const [who, setWho] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>('all');
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const lines = useMemo(
    () =>
      events
        .filter(e => {
          // A message to you shows as its Inbox item.
          if (isOwnTool(e) || (e.type === 'message.sent' && e.data.to === 'human')) return false;
          if (who && e.agent !== who && !(e.type === 'message.sent' && e.data.to === who)) return false;
          const k = eventKind(e);
          if (kind === 'talk') return k === 'say' || k === 'message' || k === 'you';
          if (kind === 'work') return k === 'tool';
          if (kind === 'git') return k === 'git' || k === 'shared' || (k === 'warn' && (e.type.startsWith('git.') || e.type.startsWith('shared.')));
          return true;
        })
        .map(e => ({ e, text: eventText(e) }))
        .filter(l => l.text && l.e.type !== 'agent.state'),
    [events, who, kind],
  );
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);

  return (
    <>
      <div className="toolbar">
        <select value={who} onChange={e => setWho(e.target.value)} aria-label="Agent">
          <option value="">All agents</option>
          {agents.map(a => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={kind} onChange={e => setKind(e.target.value as typeof kind)} aria-label="What">
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {lines.length} lines
        </span>
      </div>
      <div
        className="scroll feed"
        ref={scroller}
        onScroll={() => {
          const s = scroller.current!;
          stick.current = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
        }}
      >
        {lines.map(({ e, text }) => (
          <div key={e.seq} className={`feed-line ${eventKind(e)}`}>
            <span className="t">{clock(e.ts)}</span>
            <span className="who" onClick={() => e.agent && e.agent !== 'human' && onSelectAgent(e.agent)}>
              {e.agent === 'human' ? 'you' : (e.agent ?? (e.type.startsWith('goal.') ? 'goal' : ''))}
            </span>
            <span className="what">{text}</span>
          </div>
        ))}
        {!lines.length && <div className="empty">Nothing to show yet.</div>}
        <div ref={bottom} />
      </div>
    </>
  );
}
