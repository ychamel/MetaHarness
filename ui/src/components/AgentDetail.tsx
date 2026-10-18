import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { BUSY, clock, isOwnTool, money, oneLine, ruleLine, STATE_LABEL, GATE } from '../format.ts';
import type { Agent, AgentDetail as Detail, Goal, Manifest, MhEvent } from '../types.ts';
import { CopyText, Ctx, Dialog, Dot, Markdown, More, useConfirm, CacheClock } from './common.tsx';

type Item =
  | { kind: 'say'; seq: number; ts: string; text: string }
  | { kind: 'done'; seq: number; ts: string; text: string }
  | { kind: 'msg'; seq: number; ts: string; dir: 'in' | 'out'; who: string; text: string; urgent: boolean; decision?: boolean }
  | { kind: 'tool'; seq: number; ts: string; tool: string; summary: string; result?: string; ok?: boolean }
  | { kind: 'note'; seq: number; ts: string; text: string; warn?: boolean };

/** What one agent did, in order: its words, tool calls with their results, messages either way. */
function streamOf(events: MhEvent[], name: string): Item[] {
  const out: Item[] = [];
  const openTools: Extract<Item, { kind: 'tool' }>[] = [];
  for (const e of events) {
    const d = e.data;
    if (e.type === 'message.sent' && d.to === name) {
      out.push({ kind: 'msg', seq: e.seq, ts: e.ts, dir: 'in', who: e.agent === 'human' ? 'you' : (e.agent ?? '?'), text: d.text, urgent: !!d.urgent });
      continue;
    }
    if (e.agent !== name) continue;
    switch (e.type) {
      case 'agent.text':
        out.push({ kind: 'say', seq: e.seq, ts: e.ts, text: d.text });
        break;
      case 'agent.done':
        out.push({ kind: 'done', seq: e.seq, ts: e.ts, text: d.note });
        break;
      case 'message.sent':
        out.push({ kind: 'msg', seq: e.seq, ts: e.ts, dir: 'out', who: d.to === 'human' ? 'you' : d.to, text: d.text, urgent: !!d.urgent, decision: !!d.decision });
        break;
      case 'agent.tool_call': {
        // Its result still comes, so it keeps its place in line without being shown.
        if (isOwnTool(e)) {
          openTools.push({ kind: 'tool', seq: e.seq, ts: e.ts, tool: '', summary: '' });
          break;
        }
        const t: Extract<Item, { kind: 'tool' }> = { kind: 'tool', seq: e.seq, ts: e.ts, tool: d.tool, summary: d.summary };
        openTools.push(t);
        out.push(t);
        break;
      }
      case 'agent.tool_result': {
        const t = openTools.shift();
        if (t) Object.assign(t, { result: d.summary, ok: d.ok });
        break;
      }
      case 'agent.status':
        out.push({ kind: 'note', seq: e.seq, ts: e.ts, text: `status: ${d.text}` });
        break;
      case 'approval.auto':
        out.push({ kind: 'note', seq: e.seq, ts: e.ts, text: `ran without asking (read-only): ${oneLine(d.detail, 120)}` });
        break;
      case 'approval.refused':
        out.push({ kind: 'note', seq: e.seq, ts: e.ts, text: `refused: ${oneLine(d.detail, 100)} — ${oneLine(d.why, 200)}`, warn: true });
        break;
      case 'approval.gatekeeper':
        // Asked: the Inbox item that follows says so.
        if (d.verdict !== 'ask') out.push({ kind: 'note', seq: e.seq, ts: e.ts, text: `${GATE[d.verdict] ?? d.verdict}: ${oneLine(d.detail, 100)} — ${oneLine(d.reason, 200)}`, warn: d.verdict === 'deny' });
        break;
      case 'inbox.item':
        // A decision it asked for is already in the stream as its message to you.
        if (d.kind === 'approval') out.push({ kind: 'note', seq: e.seq, ts: e.ts, text: `asked your approval: ${oneLine(d.text, 200)}`, warn: true });
        break;
      case 'agent.paused':
      case 'agent.resumed':
      case 'agent.paused_between_steps':
      case 'agent.interrupted':
      case 'agent.moved':
      case 'agent.context_full':
      case 'agent.context_handoff':
      case 'agent.limited':
      case 'agent.crashed':
      case 'agent.ended':
      case 'agent.idle':
      case 'git.commit':
      case 'git.merge':
      case 'git.conflict':
      case 'shared.write':
      case 'shared.clash':
      case 'rule.fired':
        out.push({ kind: 'note', seq: e.seq, ts: e.ts, text: noteText(e), warn: ['agent.crashed', 'git.conflict', 'shared.clash', 'agent.limited', 'agent.moved'].includes(e.type) });
        break;
    }
  }
  return out;
}

function noteText(e: MhEvent): string {
  const d = e.data;
  switch (e.type) {
    case 'agent.paused': return `paused by ${d.by === 'human' ? 'you' : d.by}`;
    case 'agent.resumed': return `resumed by ${d.by === 'human' ? 'you' : d.by}`;
    case 'agent.paused_between_steps': return `turn paused between steps${d.cut ? ' (a command ran too long and was cut)' : ''}`;
    case 'agent.interrupted': return 'interrupted';
    case 'agent.moved': return `moved to ${d.to.harness} · ${d.to.model}: ${d.reason}`;
    case 'agent.limited': return `rate limited until ${clock(d.until)}`;
    case 'agent.context_full': return `context ${d.pct}% full${d.notesAsked ? ': asked to write notes, then continue in a fresh session' : ': its next message starts a fresh session'}`;
    case 'agent.context_handoff': return `continues in a fresh session from a handoff (context was ${d.pct}% full)`;
    case 'agent.crashed': return `crashed: ${d.reason}`;
    case 'agent.ended': return `ended: ${d.reason}`;
    case 'agent.idle': return 'stopped without calling done';
    case 'git.commit': return `committed ${String(d.sha).slice(0, 7)} on ${d.branch}: ${d.summary}`;
    case 'git.merge': return `merged ${d.from} into ${d.into}`;
    case 'git.conflict': return `${d.op} conflict on ${d.branch}: ${(d.files as string[]).join(', ')}`;
    case 'shared.write': return `wrote shared/${d.path} (v${d.version})`;
    case 'shared.clash': return `changed shared/${d.path}, which is ${d.owner}'s`;
    case 'rule.fired': return ruleLine(d);
    default: return e.type;
  }
}

/** Tool calls and plain notes in a row fold into one line; words, messages, results and warnings stay out. */
type Row = { kind: 'item'; item: Item } | { kind: 'steps'; id: number; items: Item[] };
function rowsOf(items: Item[]): Row[] {
  const out: Row[] = [];
  let run: Item[] = [];
  const flush = () => {
    if (run.length === 1) out.push({ kind: 'item', item: run[0] });
    else if (run.length) out.push({ kind: 'steps', id: run[0].seq, items: run });
    run = [];
  };
  for (const i of items) {
    if (i.kind === 'tool' || (i.kind === 'note' && !i.warn)) run.push(i);
    else {
      flush();
      out.push({ kind: 'item', item: i });
    }
  }
  flush();
  return out;
}

interface Props {
  goal: Goal;
  agent: Agent;
  events: MhEvent[];
  manifest?: Manifest;
  onCommand: (body: Record<string, unknown>) => Promise<unknown>;
  onSpawnUnder: (name: string) => void;
  onEditRole: (role: string) => void;
}

type Tab = 'talk' | 'brief' | 'setup';

export function AgentDetail({ goal, agent, events, manifest, onCommand, onSpawnUnder, onEditRole }: Props) {
  const items = useMemo(() => streamOf(events, agent.name), [events, agent.name]);
  const rows = useMemo(() => rowsOf(items), [items]);
  const [tab, setTab] = useState<Tab>('talk');
  const [detail, setDetail] = useState<Detail>();
  const [text, setText] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [openNative, setOpenNative] = useState<{ command?: string; note: string }>();
  const confirm = useConfirm();
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDetail(undefined);
    void api.agent(goal.id, agent.name).then(setDetail, () => {});
  }, [goal.id, agent.name]);
  useEffect(() => {
    if (stick.current && tab === 'talk') bottom.current?.scrollIntoView({ block: 'end' });
  }, [rows.length, tab]);

  const goalLive = goal.live && goal.status !== 'ended';
  const gone = ['ended', 'crashed'].includes(agent.state);
  const paused = agent.state === 'paused' || agent.pausing;
  const busy = BUSY.includes(agent.state);
  const canMessage = goalLive && !gone;
  const lastProblem = useMemo(() => [...events].reverse().find(e => e.agent === agent.name && ['agent.crashed', 'agent.ended', 'agent.idle'].includes(e.type)), [events, agent.name]);

  const send = async () => {
    if (!text.trim()) return;
    await onCommand({ cmd: 'agent.message', goal: goal.id, to: agent.name, text: text.trim(), urgent });
    setText('');
    setUrgent(false);
  };

  return (
    <>
      <div className="detail-head">
        <h2>
          <Dot state={agent.pausing ? 'paused' : agent.state} /> {agent.name}
          <span className={`pill state-${agent.state}`}>{agent.pausing ? 'pausing…' : STATE_LABEL[agent.state]}</span>
        </h2>
        <div className="sub">
          {agent.role} · {agent.harness} · {agent.model} · {agent.parent !== 'human' ? `started by ${agent.parent}` : 'started by you'}
        </div>

        <Now agent={agent} problem={lastProblem} />

        <div className="facts">
          {manifest?.reportsCost !== false && <span title="Cost so far">{money(agent.cost)}</span>}
          {agent.contextPct != null && (
            <span className="ctx-fact" title="How full its context window is">
              <Ctx pct={agent.contextPct} /> {agent.contextPct}% context
            </span>
          )}
          <CacheClock agent={agent} long />
          {agent.branch && <span className="mono" title="Its branch">{agent.branch}</span>}
          {agent.awaitingApproval > 0 && <span className="warn-text">{agent.awaitingApproval} waiting for your approval</span>}
          {agent.unread > 0 && <span>{agent.unread} unread message{agent.unread > 1 ? 's' : ''}</span>}
        </div>

        {goalLive && !gone && (
          <div className="row actions">
            {paused ? (
              <button className="btn small" onClick={() => onCommand({ cmd: 'agent.resume', goal: goal.id, agent: agent.name })}>
                ▶ Resume
              </button>
            ) : busy ? (
              <button className="btn small" onClick={() => onCommand({ cmd: 'agent.pause', goal: goal.id, agent: agent.name })} title="Stops after its current step; messages wait until you resume it">
                ⏸ Pause
              </button>
            ) : null}
            {!agent.quick && agent.state !== 'done' && (
              <button className="btn small" onClick={() => onSpawnUnder(agent.name)} title="Start an agent that reports to this one">
                + Helper
              </button>
            )}
            {agent.nativeSession && (
              <button className="btn small" onClick={() => void onCommand({ cmd: 'agent.open_native', goal: goal.id, agent: agent.name }).then(r => setOpenNative(r as { command?: string; note: string }))}>
                Open in {agent.harness}
              </button>
            )}
            <button
              className="btn small ghost danger"
              onClick={async () => {
                if (await confirm({ title: `Stop ${agent.name}?`, body: 'Its session ends and whoever started it is told. This can’t be undone; you can start a new agent in its place.', confirm: 'Stop it', danger: true }))
                  void onCommand({ cmd: 'agent.stop', goal: goal.id, agent: agent.name });
              }}
            >
              Stop
            </button>
          </div>
        )}
      </div>

      <nav className="tabs small">
        {(
          [
            ['talk', 'Conversation'],
            ['brief', 'Brief'],
            ['setup', 'Setup'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className={`tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </nav>

      <div
        className="scroll"
        ref={scroller}
        onScroll={() => {
          const s = scroller.current!;
          stick.current = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
        }}
      >
        {tab === 'talk' && (
          <div className="stream">
            {rows.map(r => (r.kind === 'steps' ? <StepRun key={`s${r.id}`} items={r.items} /> : <StreamItem key={r.item.seq} item={r.item} />))}
            {!rows.length && <div className="empty">Nothing yet.</div>}
            <div ref={bottom} />
          </div>
        )}
        {tab === 'brief' && (
          <div className="pane-body">
            <div className="kicker">What it was asked to do</div>
            <Markdown text={agent.brief || '—'} />
          </div>
        )}
        {tab === 'setup' && (
          <div className="pane-body">
            <dl className="kv">
              <dt>Role</dt>
              <dd>
                {agent.role}{' '}
                <button className="btn ghost small" onClick={() => onEditRole(agent.role)}>
                  Edit role
                </button>
              </dd>
              <dt>Runs on</dt>
              <dd>
                {agent.harness} · {agent.model}
              </dd>
              <dt>Folder</dt>
              <dd className="mono">{agent.cwd}</dd>
              {detail?.worktree && (
                <>
                  <dt>Worktree</dt>
                  <dd className="mono">
                    {detail.worktree.branch} from {detail.worktree.base.slice(0, 7)}
                    {detail.worktree.deps?.length ? ` · ${detail.worktree.deps.join(', ')} copied` : ''}
                  </dd>
                </>
              )}
              {agent.nativeSession && (
                <>
                  <dt>Session</dt>
                  <dd className="mono">{agent.nativeSession}</dd>
                </>
              )}
              {agent.limitedUntil && (
                <>
                  <dt>Rate limit</dt>
                  <dd>until {clock(agent.limitedUntil)}</dd>
                </>
              )}
            </dl>
            <div className="kicker">The prompt it was given</div>
            {detail?.systemPrompt ? (
              <More lines={12}>
                <pre className="code">{detail.systemPrompt}</pre>
              </More>
            ) : (
              <div className="muted">{detail ? 'The prompt is only kept while the goal runs here.' : 'Loading…'}</div>
            )}
          </div>
        )}
      </div>

      {canMessage && (
        <div className="composer">
          <textarea
            rows={2}
            placeholder={`Message ${agent.name}${paused ? ' (it reads it when you resume it)' : agent.state === 'done' ? ' (it picks up again to answer)' : ''}…`}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
            }}
          />
          <div className="row">
            <label className="check" title="Pauses its turn after the current step to deliver this now">
              <input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} /> Urgent
            </label>
            <span className="muted kbd-hint">Ctrl+Enter</span>
            <button className="btn primary small" disabled={!text.trim()} onClick={() => void send()}>
              Send
            </button>
          </div>
        </div>
      )}

      {openNative && (
        <Dialog title={`Open ${agent.name} in ${agent.harness}`} onClose={() => setOpenNative(undefined)}>
          <div>{openNative.note}</div>
          {openNative.command && <CopyText text={openNative.command} />}
          <div className="row">
            <button className="btn" onClick={() => setOpenNative(undefined)}>
              Close
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/** The one thing to know about the agent right now. */
function Now({ agent, problem }: { agent: Agent; problem?: MhEvent }) {
  if (agent.state === 'done')
    return (
      <div className="now done">
        <div className="kicker">Result</div>
        <More lines={5}>
          <Markdown text={agent.doneNote || 'It finished without a note.'} />
        </More>
      </div>
    );
  if (agent.state === 'crashed' || agent.state === 'ended' || agent.state === 'idle') {
    const why = problem?.type === 'agent.idle' ? 'It stopped without calling done. Message it to carry on.' : problem ? String(problem.data.reason ?? '') : '';
    return (
      <div className={`now ${agent.state === 'crashed' ? 'bad' : 'quiet'}`}>
        <div className="kicker">{agent.state === 'crashed' ? 'Crashed' : agent.state === 'idle' ? 'Stopped' : 'Ended'}</div>
        {why && <div>{why}</div>}
        {agent.doneNote && (
          <More lines={3}>
            <Markdown text={agent.doneNote} />
          </More>
        )}
      </div>
    );
  }
  if (agent.state === 'limited') return <div className="now warn">Rate limited{agent.limitedUntil ? ` until ${clock(agent.limitedUntil)}` : ''}. It continues by itself, or moves to a backup.</div>;
  if (agent.state === 'paused' || agent.pausing) return <div className="now paused">{agent.pausing ? 'Pausing after its current step…' : 'Paused. Messages wait until you resume it.'}</div>;
  return (
    <div className="now">
      <div className="kicker">{agent.state === 'waiting' ? 'Waiting' : agent.state === 'starting' ? 'Starting' : 'Now'}</div>
      <div>{agent.status || (agent.state === 'waiting' ? 'Waiting for a teammate.' : 'Working…')}</div>
    </div>
  );
}

function StepRun({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  const tools = items.filter(i => i.kind === 'tool').length;
  const failed = items.some(i => i.kind === 'tool' && i.ok === false);
  const last = [...items].reverse().find(i => i.kind === 'note' && i.text.startsWith('status: ')) as Extract<Item, { kind: 'note' }> | undefined;
  return (
    <div className={`steps${open ? ' open' : ''}`}>
      <button className="steps-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="count">
          {tools ? `${tools} tool call${tools > 1 ? 's' : ''}` : `${items.length} steps`}
          {failed && <span className="warn-text"> · one failed</span>}
        </span>
        {last && <span className="steps-who">{oneLine(last.text.slice(8), 80)}</span>}
      </button>
      {open && (
        <div className="steps-body">
          {items.map(i => (
            <StreamItem key={i.seq} item={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function StreamItem({ item }: { item: Item }) {
  switch (item.kind) {
    case 'say':
      return (
        <div className="item-say" title={clock(item.ts)}>
          <More lines={4}>
            <Markdown text={item.text} />
          </More>
        </div>
      );
    case 'done':
      return (
        <div className="item-done" title={clock(item.ts)}>
          <div className="kicker">Finished</div>
          <More lines={6}>
            <Markdown text={item.text} />
          </More>
        </div>
      );
    case 'msg':
      return (
        <div className={`item-msg ${item.dir}${item.who === 'you' ? ' you' : ''}`}>
          <div className="from">
            {item.dir === 'in' ? `from ${item.who}` : `to ${item.who}`}
            {item.decision ? ' · decision' : ''}
            {item.urgent ? ' · urgent' : ''} · {clock(item.ts)}
          </div>
          <More lines={5}>
            <Markdown text={item.text} />
          </More>
        </div>
      );
    case 'tool':
      return (
        <details className="item-tool">
          <summary title={clock(item.ts)}>
            <span className="tool">{item.tool}</span>
            <span className="arg">{oneLine(item.summary, 200)}</span>
            {item.ok === false && <span style={{ color: 'var(--crashed)' }}>✗</span>}
          </summary>
          <pre className="result">{item.summary}</pre>
          {item.result !== undefined && <pre className={`result${item.ok === false ? ' bad' : ''}`}>→ {item.result}</pre>}
        </details>
      );
    case 'note':
      return (
        <div className={`item-note${item.warn ? ' warn' : ''}`}>
          {clock(item.ts)} · {item.text}
        </div>
      );
  }
}
