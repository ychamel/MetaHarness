import { useEffect, useMemo, useRef, useState } from 'react';
import { api, followEvents } from '../api.ts';
import { money } from '../format.ts';
import type { MhEvent } from '../types.ts';
import { Markdown } from './common.tsx';

interface State {
  conv: string;
  since: number;
  busy: boolean;
  route: { harness: string; model: string } | null;
  error: string | null;
}

const SUGGESTIONS = [
  'What did this goal cost, and where did the money go?',
  'Which agent took longest, and what was it waiting on?',
  'Which roles could run on cheaper models?',
  'How do I add another harness?',
];

/**
 * The assistant: ask about your goals and setup. It reads only; a change it suggests shows here
 * with an Apply button. "New conversation" starts it fresh.
 */
export function AssistantPanel({ open, context, onClose, onApplied }: { open: boolean; context?: string; onClose: () => void; onApplied: () => void }) {
  const [state, setState] = useState<State>();
  const [events, setEvents] = useState<MhEvent[]>([]);
  const [text, setText] = useState('');
  const [failed, setFailed] = useState<string>();
  const scroller = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      setState(await api.command<State>({ cmd: 'assistant.state' }));
      setFailed(undefined);
    } catch (e) {
      setFailed((e as Error).message);
    }
  };
  useEffect(() => {
    if (open && !state) void load();
  }, [open]);

  // Its conversation, from where it starts.
  useEffect(() => {
    if (!state) return;
    setEvents([]);
    return followEvents('assistant', e => setEvents(prev => prev.concat(e)), () => {}, state.since);
  }, [state?.conv, state?.since]);

  const conv = useMemo(() => events.filter(e => e.data.conv === state?.conv), [events, state?.conv]);
  const busy = useMemo(() => {
    const last = [...conv].reverse().find(e => e.type === 'assistant.state' || e.type === 'assistant.asked');
    return last ? last.type === 'assistant.asked' || last.data.busy === true : false;
  }, [conv]);
  const cost = [...conv].reverse().find(e => e.type === 'assistant.usage')?.data.costUsd as number | undefined;
  const route = [...conv].reverse().find(e => e.type === 'assistant.started')?.data as { harness: string; model: string; note?: string } | undefined;
  const done = useMemo(() => new Map(conv.filter(e => e.type === 'assistant.proposal_done').map(e => [String(e.data.id), e.data])), [conv]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [conv.length, busy]);

  const ask = async (q = text) => {
    if (!q.trim()) return;
    setText('');
    try {
      await api.command({ cmd: 'assistant.ask', text: q.trim(), context });
    } catch (e) {
      setFailed((e as Error).message);
    }
  };
  const reset = async () => {
    const r = await api.command<{ conv: string }>({ cmd: 'assistant.reset' });
    setState(s => (s ? { ...s, conv: r.conv, since: Math.max(s.since, events.at(-1)?.seq ?? s.since) } : s));
  };
  const decide = async (id: string, cmd: 'assistant.apply' | 'assistant.dismiss') => {
    try {
      await api.command({ cmd, id });
      if (cmd === 'assistant.apply') onApplied();
    } catch (e) {
      setFailed((e as Error).message);
    }
  };

  if (!open) return null;
  const where = route ?? state?.route;
  return (
    <aside className="assistant" aria-label="Assistant">
      <div className="assistant-head">
        <div>
          <b>Assistant</b>
          <div className="muted small">
            {where ? `${where.harness} · ${where.model}` : state?.error ? 'can’t run here' : 'reads only'}
            {cost !== undefined ? ` · ${money(cost)}` : ''}
          </div>
        </div>
        <span className="spacer" />
        <button className="btn ghost small" onClick={() => void reset()} disabled={!conv.length} title="Start over: it forgets this conversation">
          New conversation
        </button>
        <button className="btn ghost small" onClick={onClose} aria-label="Close the assistant">
          ✕
        </button>
      </div>

      <div className="assistant-body" ref={scroller}>
        {!conv.length && (
          <div className="assistant-empty">
            <p className="muted">Ask about your goals and setup: what happened, why, what it cost, how to set something up. It reads the logs, files and config; it can suggest setup changes, and you apply them.</p>
            {state?.error && <p className="warn-text">{state.error} Its role is in Settings.</p>}
            <div className="suggestions">
              {SUGGESTIONS.map(s => (
                <button key={s} className="btn ghost small" onClick={() => void ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {conv.map(e => {
          const d = e.data;
          switch (e.type) {
            case 'assistant.asked':
              return (
                <div key={e.seq} className="bubble you">
                  {String(d.text)}
                </div>
              );
            case 'assistant.text':
              return (
                <div key={e.seq} className={`bubble${d.error ? ' warn-text' : ''}`}>
                  <Markdown text={String(d.text)} />
                </div>
              );
            case 'assistant.tool':
              return (
                <div key={e.seq} className="tool-line muted small">
                  looked up <b>{String(d.tool)}</b> <span className="ellipsis">{String(d.summary ?? '')}</span>
                </div>
              );
            case 'assistant.proposal': {
              const outcome = done.get(String(d.id));
              return (
                <div key={e.seq} className="proposal">
                  <div className="proposal-head">Suggested change</div>
                  <div>{String(d.summary)}</div>
                  <details>
                    <summary className="muted small">What it runs</summary>
                    <pre className="code">{JSON.stringify(d.command, null, 2)}</pre>
                  </details>
                  {outcome ? (
                    <div className="muted small">{outcome.status === 'applied' ? `Applied. ${outcome.result ?? ''}` : 'Dismissed.'}</div>
                  ) : (
                    <div className="actions">
                      <button className="btn primary small" onClick={() => void decide(String(d.id), 'assistant.apply')}>
                        Apply
                      </button>
                      <button className="btn small" onClick={() => void decide(String(d.id), 'assistant.dismiss')}>
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            case 'assistant.started':
              return d.note ? (
                <div key={e.seq} className="muted small">
                  {String(d.note)}
                </div>
              ) : null;
            default:
              return null;
          }
        })}
        {busy && <div className="muted small thinking">Looking into it…</div>}
        {failed && <div className="warn-text small">{failed}</div>}
      </div>

      <div className="assistant-input">
        <textarea
          rows={2}
          value={text}
          placeholder={context ? `Ask about ${context}…` : 'Ask about your goals or setup…'}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <button className="btn primary small" disabled={!text.trim()} onClick={() => void ask()}>
          Ask
        </button>
      </div>
    </aside>
  );
}
