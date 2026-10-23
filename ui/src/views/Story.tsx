import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clock, eventKind, modelLabel, eventText, importance, oneLine, who } from '../format.ts';
import type { Goal, MhEvent } from '../types.ts';
import { Markdown, More } from '../components/common.tsx';

type Entry = { kind: 'card'; e: MhEvent } | { kind: 'steps'; id: number; events: MhEvent[] };

/** Key events as cards; runs of minor ones in between fold into one “steps” line. */
export function storyOf(events: MhEvent[], agent?: string): Entry[] {
  const out: Entry[] = [];
  let steps: MhEvent[] = [];
  const flush = () => {
    if (steps.length) out.push({ kind: 'steps', id: steps[0].seq, events: steps });
    steps = [];
  };
  for (const e of events) {
    if (agent && e.agent !== agent && !(e.type === 'message.sent' && e.data.to === agent)) continue;
    const imp = importance(e);
    if (imp === 'hidden') continue;
    if (imp === 'minor') {
      if (eventText(e)) steps.push(e);
      continue;
    }
    // Your answer to a request reaches the agent as a message from you: the answer's line says it already.
    const prev = out.at(-1);
    if (e.type === 'message.sent' && e.agent === 'human' && prev?.kind === 'card' && prev.e.type === 'inbox.resolved' && prev.e.agent === e.data.to && !steps.length) continue;
    flush();
    out.push({ kind: 'card', e });
  }
  flush();
  return out;
}

interface Props {
  goal: Goal;
  events: MhEvent[];
  onSelectAgent: (name: string) => void;
  onOpenFile: (path: string) => void;
}

/** What happened on the goal, as a story: who started whom, what they said, what came of it. */
export function Story({ goal, events, onSelectAgent, onOpenFile }: Props) {
  const [agent, setAgent] = useState('');
  const [expandAll, setExpandAll] = useState(false);
  const entries = useMemo(() => storyOf(events, agent || undefined), [events, agent]);
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  useEffect(() => {
    if (stuck) bottom.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, stuck, entries.at(-1)]);

  const name = (n: string | undefined) =>
    n && n !== 'human' ? (
      <button className="name-link" onClick={() => onSelectAgent(n)}>
        {n}
      </button>
    ) : (
      <b className="you">{who(n) || 'MetaHarness'}</b>
    );

  return (
    <>
      <div className="toolbar">
        <select value={agent} onChange={e => setAgent(e.target.value)} aria-label="Agent">
          <option value="">Everyone</option>
          {goal.agents.map(a => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={expandAll} onChange={e => setExpandAll(e.target.checked)} /> Show every step
        </label>
      </div>
      <div
        className="scroll story"
        ref={scroller}
        onScroll={() => {
          const s = scroller.current!;
          const at = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
          if (at !== stuck) setStuck(at);
        }}
      >
        {entries.map(en => (en.kind === 'steps' ? <Steps key={`s${en.id}`} events={en.events} open={expandAll} onSelectAgent={onSelectAgent} /> : <Card key={en.e.seq} e={en.e} name={name} onOpenFile={onOpenFile} />))}
        {!entries.length && <div className="empty">Nothing has happened yet.</div>}
        <div ref={bottom} />
      </div>
      {!stuck && (
        <button className="jump" onClick={() => setStuck(true)}>
          ↓ Latest
        </button>
      )}
    </>
  );
}

function Steps({ events, open: openAll, onSelectAgent }: { events: MhEvent[]; open: boolean; onSelectAgent: (n: string) => void }) {
  const [open, setOpen] = useState(false);
  const shown = open || openAll;
  // The latest status line of each agent in the run says what they were doing.
  const latest = new Map<string, string>();
  for (const e of events) {
    if (!e.agent) continue;
    if (e.type === 'agent.status') latest.set(e.agent, oneLine(e.data.text, 90));
    else if (!latest.has(e.agent)) latest.set(e.agent, '');
  }
  return (
    <div className={`steps${shown ? ' open' : ''}`}>
      <button className="steps-head" onClick={() => setOpen(o => !o)} aria-expanded={shown}>
        <span className="caret">{shown ? '▾' : '▸'}</span>
        <span className="count">
          {events.length} step{events.length > 1 ? 's' : ''}
        </span>
        <span className="steps-who">
          {[...latest].map(([a, s]) => (
            <span key={a}>
              <b>{a}</b>
              {s ? `: ${s}` : ''}
            </span>
          ))}
        </span>
      </button>
      {shown && (
        <div className="steps-body">
          {events.map(e => (
            <div key={e.seq} className={`feed-line ${eventKind(e)}`}>
              <span className="t">{clock(e.ts)}</span>
              <span className="who" onClick={() => e.agent && e.agent !== 'human' && onSelectAgent(e.agent)}>
                {who(e.agent)}
              </span>
              <span className="what">{eventText(e)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ e, name, onOpenFile }: { e: MhEvent; name: (n?: string) => ReactNode; onOpenFile: (p: string) => void }) {
  const d = e.data;
  const t = <span className="t">{clock(e.ts)}</span>;
  switch (e.type) {
    case 'goal.started':
      return (
        <div className="card goal-start">
          <div className="card-head">
            <span className="label">Goal started</span>
            {d.workflow && <span className="pill">workflow: {d.workflow}</span>}
            {t}
          </div>
          <More lines={5}>
            <Markdown text={String(d.request ?? '')} />
          </More>
        </div>
      );
    case 'agent.spawned':
      return (
        <div className="card spawn">
          <div className="card-head">
            {name(e.parent)} <span className="verb">started</span> {name(e.agent)}
            <span className="meta">
              {d.role} · {d.harness} · {modelLabel(d as { model: string; effort?: string })}
              {d.quick ? ' · quick helper' : ''}
              {d.branch ? ` · ${d.branch}` : ''}
            </span>
            {t}
          </div>
          {d.brief && (
            <More lines={2} className="quiet">
              <Markdown text={String(d.brief)} />
            </More>
          )}
        </div>
      );
    case 'message.sent': {
      const toYou = d.to === 'human';
      const fromYou = e.agent === 'human';
      return (
        <div className={`card msg${toYou ? ' to-you' : ''}${fromYou ? ' from-you' : ''}`}>
          <div className="card-head">
            {name(e.agent)} <span className="verb">→</span> {name(d.to)}
            {d.decision && <span className="pill decision">decision</span>}
            {d.urgent && <span className="pill urgent">urgent</span>}
            {t}
          </div>
          <More lines={4}>
            <Markdown text={String(d.text ?? '')} />
          </More>
        </div>
      );
    }
    case 'agent.done':
      return (
        <div className="card done">
          <div className="card-head">
            {name(e.agent)} <span className="verb">finished</span>
            {t}
          </div>
          <More lines={6}>
            <Markdown text={String(d.note ?? '')} />
          </More>
        </div>
      );
    case 'shared.write':
      return (
        <div className="line">
          {t} {name(e.agent)} <span className="verb">created</span>{' '}
          <button className="file-link" onClick={() => onOpenFile(String(d.path))}>
            shared/{d.path}
          </button>
        </div>
      );
    case 'git.commit':
      return (
        <div className="line git">
          {t} {name(e.agent)} <span className="verb">committed</span> <code>{String(d.sha).slice(0, 7)}</code> {oneLine(d.summary, 140)}
          <span className="meta"> on {d.branch}</span>
        </div>
      );
    case 'design.changed':
      return (
        <div className="card design">
          <div className="card-head">
            <span className="verb">The design moved</span> <span className="meta">at {String(d.sha).slice(0, 7)}</span>
            {t}
          </div>
          <ul className="plain small">
            {(d.highlights as string[]).map(h => (
              <li key={h}>{h}</li>
            ))}
            <li className="muted">
              {String(d.files)} files, {String(d.symbols)} definitions changed
            </li>
          </ul>
        </div>
      );
    case 'git.merge':
      return (
        <div className="line git">
          {t} {name(e.agent)} <span className="verb">merged</span> <code>{d.from}</code> into <code>{d.into}</code>
          {d.fastForward ? <span className="meta"> (fast-forward)</span> : null}
        </div>
      );
    case 'inbox.resolved': {
      const verb = d.decision === 'approve' ? 'approved' : d.decision === 'deny' ? 'denied' : d.reply ? 'answered' : 'cleared';
      return (
        <div className="line you">
          {t} <b className="you">You</b> <span className="verb">{verb}</span> {name(e.agent)}
          {d.reply ? <span>“{oneLine(d.reply, 300)}”</span> : null}
          {d.why ? <span className="meta"> ({d.why})</span> : null}
        </div>
      );
    }
    case 'inbox.item':
      return (
        <div className="card warn">
          <div className="card-head">
            {name(e.agent)} <span className="verb">asked for your approval</span>
            {t}
          </div>
          <More lines={3}>
            <pre>{String(d.text ?? '')}</pre>
          </More>
        </div>
      );
    case 'agent.crashed':
    case 'agent.ended':
    case 'agent.idle':
    case 'agent.moved':
    case 'agent.context_handoff':
    case 'agent.limited':
    case 'git.conflict':
    case 'shared.clash':
    case 'git.conflict_resolved': {
      const warn = !['agent.ended', 'git.conflict_resolved', 'agent.context_handoff'].includes(e.type);
      return (
        <div className={`line${warn ? ' warn' : ''}`}>
          {t} {name(e.agent)} {eventText(e)}
        </div>
      );
    }
    case 'goal.stalled':
      return (
        <div className="line center warn">
          {t} {eventText(e)}
        </div>
      );
    default:
      return (
        <div className="line center">
          {t} {eventText(e)}
        </div>
      );
  }
}
