import { useEffect, useMemo, useRef, useState } from 'react';
import { api, followEvents } from '../api.ts';
import { money } from '../format.ts';
import type { MhEvent } from '../types.ts';
import { Markdown } from './common.tsx';
import { Splitter } from './Splitter.tsx';

interface Choice {
  harness?: string;
  model?: string;
  effort?: string;
  write: boolean;
}

interface State {
  conv: string;
  since: number;
  busy: boolean;
  route: { harness: string; model: string; effort?: string } | null;
  error: string | null;
  choice: Choice;
  /** The folder it works in, which write mode lets it change. */
  dir: string;
}

/** What the panel offers: the role's own route, and each harness that runs here with its models and efforts. */
interface Options {
  role: { harness: string; model: string; effort: string | null };
  harnesses: { id: string; title: string; models: string[]; efforts: Record<string, string[]>; anyEffort: string[] | null }[];
}

const SUGGESTIONS = [
  'What did this goal cost, and where did the money go?',
  'Which agent took longest, and what was it waiting on?',
  'Which roles could run on cheaper models?',
  'How do I add another harness?',
];

const label = (r: { harness: string; model: string; effort?: string | null }) => `${r.harness} · ${r.model}${r.effort ? ` · ${r.effort}` : ''}`;

/**
 * The assistant: ask about your goals and setup. It reads only unless write mode is on; a change
 * it suggests shows here with an Apply button. Its model and effort can change mid-conversation:
 * the new one hears what was said. "New conversation" starts it fresh, back in read only.
 */
/** `project`: the one you're in; a proposal that names none applies there. */
export function AssistantPanel({ open, context, project, onClose, onApplied }: { open: boolean; context?: string; project?: string; onClose: () => void; onApplied: () => void }) {
  const [state, setState] = useState<State>();
  const [events, setEvents] = useState<MhEvent[]>([]);
  const [text, setText] = useState('');
  const [failed, setFailed] = useState<string>();
  const [options, setOptions] = useState<Options>();
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
    if (open && !options) void api.command<Options>({ cmd: 'assistant.options' }).then(setOptions, () => {});
  }, [open]);

  // Its conversation, from where it starts.
  useEffect(() => {
    if (!state) return;
    setEvents([]);
    return followEvents('assistant', e => setEvents(prev => prev.concat(e)), () => {}, state.since).stop;
  }, [state?.conv, state?.since]);

  const conv = useMemo(() => events.filter(e => e.data.conv === state?.conv), [events, state?.conv]);
  /** Where the human first asked: switches before it show only in the controls. */
  const firstAsk = conv.find(e => e.type === 'assistant.asked')?.seq;
  const busy = useMemo(() => {
    const last = [...conv].reverse().find(e => e.type === 'assistant.state' || e.type === 'assistant.asked');
    return last ? last.type === 'assistant.asked' || last.data.busy === true : false;
  }, [conv]);
  const cost = [...conv].reverse().find(e => e.type === 'assistant.usage')?.data.costUsd as number | undefined;
  const route = [...conv].reverse().find(e => e.type === 'assistant.started' || (e.type === 'assistant.settings' && e.data.rerouted));
  const started = route?.type === 'assistant.started' ? (route.data as { harness: string; model: string; effort?: string }) : undefined;
  const done = useMemo(() => new Map(conv.filter(e => e.type === 'assistant.proposal_done').map(e => [String(e.data.id), e.data])), [conv]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [conv.length, busy]);

  const ask = async (q = text) => {
    if (!q.trim()) return;
    setText('');
    try {
      await api.command({ cmd: 'assistant.ask', text: q.trim(), context, ...(project ? { project } : {}) });
    } catch (e) {
      setFailed((e as Error).message);
    }
  };
  const reset = async () => {
    const r = await api.command<{ conv: string; choice: Choice }>({ cmd: 'assistant.reset' });
    setState(s => (s ? { ...s, conv: r.conv, choice: r.choice, since: Math.max(s.since, events.at(-1)?.seq ?? s.since) } : s));
  };
  /** Its model, effort or write mode; the route it'll run on comes back with the new state. */
  const choose = async (change: Record<string, unknown>) => {
    try {
      await api.command({ cmd: 'assistant.set', ...change });
      const next = await api.command<State>({ cmd: 'assistant.state' });
      setState(s => (s ? { ...s, route: next.route, error: next.error, choice: next.choice } : next));
      setFailed(undefined);
    } catch (e) {
      setFailed((e as Error).message);
    }
  };
  /** The pick becomes its role's model and effort, kept across restarts. */
  const makeDefault = async () => {
    try {
      await api.command({ cmd: 'assistant.make_default' });
      const [next, opts] = await Promise.all([api.command<State>({ cmd: 'assistant.state' }), api.command<Options>({ cmd: 'assistant.options' })]);
      setState(s => (s ? { ...s, route: next.route, error: next.error, choice: next.choice } : next));
      setOptions(opts);
      onApplied();
    } catch (e) {
      setFailed((e as Error).message);
    }
  };
  const decide = async (id: string, cmd: 'assistant.apply' | 'assistant.dismiss') => {
    try {
      const r = await api.command<{ needsTrust?: boolean; dir?: string }>({ cmd, id, ...(project ? { project } : {}) });
      // A folder with its own setup is opened from Projects, where you see what it would run first.
      if (r.needsTrust) setFailed(`${r.dir} has its own MetaHarness setup. Open it from Projects → Open folder, where you can look at it and trust it.`);
      if (cmd === 'assistant.apply') onApplied();
    } catch (e) {
      setFailed((e as Error).message);
    }
  };

  if (!open) return null;
  // The session's own route once it started on the current pick; before that, the one it would take.
  const where = started ?? state?.route;
  const choice = state?.choice ?? { write: false };
  return (
    <aside className="assistant" aria-label="Assistant">
      <Splitter pane="assistant" grow="left" min={320} max={1100} inside label="Assistant panel" />
      <div className="assistant-head">
        <div>
          <b>Assistant</b>
          <div className="muted small">
            {where ? label(where) : state?.error ? 'can’t run here' : 'reads only'}
            {cost !== undefined ? ` · ${money(cost)}` : ''}
          </div>
        </div>
        <span className="spacer" />
        <button className="btn ghost small" onClick={() => void reset()} disabled={firstAsk === undefined} title="Start over: it forgets this conversation">
          New conversation
        </button>
        <button className="btn ghost small" onClick={onClose} aria-label="Close the assistant">
          ✕
        </button>
      </div>

      {state && <Controls choice={choice} options={options} busy={busy} dir={state.dir} onChoose={c => void choose(c)} onMakeDefault={() => void makeDefault()} />}

      <div className="assistant-body" ref={scroller}>
        {firstAsk === undefined && (
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
            case 'assistant.settings':
              return firstAsk === undefined || e.seq < firstAsk ? null : (
                <div key={e.seq} className={`muted small switch-line${d.write && !d.rerouted ? ' warn-text' : ''}`}>
                  {d.rerouted ? `Now on ${d.model ? label({ harness: String(d.harness), model: String(d.model), effort: d.effort as string | null }) : `the role's model${d.effort ? ` · ${d.effort}` : ''}`}. It keeps this conversation.` : d.write ? 'Write mode on: it can edit files and run commands.' : 'Back to read only.'}
                </div>
              );
            case 'assistant.default_saved':
              return firstAsk === undefined || e.seq < firstAsk ? null : (
                <div key={e.seq} className="muted small switch-line">
                  Saved as its default, in {String(d.file)}.
                </div>
              );
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

/** Its model and effort for this conversation, and whether it may write. */
function Controls({ choice, options, busy, dir, onChoose, onMakeDefault }: { choice: Choice; options?: Options; busy: boolean; dir: string; onChoose: (c: Record<string, unknown>) => void; onMakeDefault: () => void }) {
  const harness = choice.model ? choice.harness! : options?.role.harness;
  const model = choice.model ?? options?.role.model;
  const h = options?.harnesses.find(x => x.id === harness);
  const efforts = (model && h?.efforts[model]) || h?.anyEffort || ['low', 'medium', 'high'];
  const picked = choice.model ? `${choice.harness}/${choice.model}` : '';
  // A pick no harness lists any more still shows as itself.
  const listed = !picked || options?.harnesses.some(x => x.id === choice.harness && x.models.includes(choice.model!));
  const switching = busy ? 'It switches once this answer is in.' : undefined;
  return (
    <div className="assistant-controls">
      <div className="row">
        <select
          aria-label="Model"
          title={switching ?? 'Its model for this conversation. A new one hears what was said so far.'}
          value={picked}
          disabled={busy}
          onChange={e => {
            const v = e.target.value;
            const slash = v.indexOf('/');
            onChoose(v ? { harness: v.slice(0, slash), model: v.slice(slash + 1) } : { model: '' });
          }}
        >
          <option value="">{options ? `Role's model (${label(options.role)})` : "Role's model"}</option>
          {!listed && <option value={picked}>{picked}</option>}
          {options?.harnesses.map(x => (
            <optgroup key={x.id} label={x.title}>
              {x.models.map(m => (
                <option key={m} value={`${x.id}/${m}`}>
                  {m}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <select aria-label="Effort" title={switching ?? 'How hard it thinks'} value={choice.effort ?? ''} disabled={busy} onChange={e => onChoose({ effort: e.target.value })}>
          <option value="">{choice.model || !options?.role.effort ? 'Default effort' : `Role's effort (${options.role.effort})`}</option>
          {choice.effort && !efforts.includes(choice.effort) && <option value={choice.effort}>{choice.effort}</option>}
          {efforts.map(x => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <div className="segmented small" role="group" aria-label="Permissions">
          <button className={choice.write ? '' : 'on'} aria-pressed={!choice.write} onClick={() => choice.write && onChoose({ write: false })} title="It reads files and runs commands that only read">
            Read only
          </button>
          <button className={choice.write ? 'on write' : ''} aria-pressed={choice.write} onClick={() => !choice.write && onChoose({ write: true })} title="It may edit files and run any command, for a task you give it">
            Write
          </button>
        </div>
        {(choice.model || choice.effort) && (
          <button className="link" onClick={onMakeDefault} title="Save this model and effort to the assistant role, so it starts on them after a restart too">
            Make default
          </button>
        )}
      </div>
      {choice.write && <div className="warn-text small">Write mode: it can edit files and run commands in {dir}. New conversations start in read only.</div>}
    </div>
  );
}
