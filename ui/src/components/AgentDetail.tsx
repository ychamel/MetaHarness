import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { clock, isOwnTool, money, oneLine, STATE_LABEL } from '../format.ts';
import type { Agent, AgentDetail as Detail, Goal, Manifest, MhEvent } from '../types.ts';
import { CopyText, Ctx, Dialog, Dot } from './common.tsx';

type Item =
  | { kind: 'say'; seq: number; ts: string; text: string }
  | { kind: 'done'; seq: number; ts: string; text: string }
  | { kind: 'msg'; seq: number; ts: string; dir: 'in' | 'out'; who: string; text: string; urgent: boolean }
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
        out.push({ kind: 'msg', seq: e.seq, ts: e.ts, dir: 'out', who: d.to === 'human' ? 'you' : d.to, text: d.text, urgent: !!d.urgent });
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
      case 'inbox.item':
        // A decision it asked for is already in the stream as its message to you.
        if (d.kind === 'approval') out.push({ kind: 'note', seq: e.seq, ts: e.ts, text: `asked you (${d.kind}): ${oneLine(d.text, 200)}`, warn: true });
        break;
      case 'agent.paused':
      case 'agent.resumed':
      case 'agent.paused_between_steps':
      case 'agent.interrupted':
      case 'agent.moved':
      case 'agent.limited':
      case 'agent.crashed':
      case 'agent.ended':
      case 'agent.idle':
      case 'git.commit':
      case 'git.merge':
      case 'git.conflict':
      case 'shared.write':
      case 'shared.clash':
        out.push({ kind: 'note', seq: e.seq, ts: e.ts, text: noteText(e), warn: ['agent.crashed', 'git.conflict', 'shared.clash', 'agent.limited'].includes(e.type) });
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
    case 'agent.crashed': return `crashed: ${d.reason}`;
    case 'agent.ended': return `ended: ${d.reason}`;
    case 'agent.idle': return 'stopped without calling done';
    case 'git.commit': return `committed ${String(d.sha).slice(0, 7)} on ${d.branch}: ${d.summary}`;
    case 'git.merge': return `merged ${d.from} into ${d.into}`;
    case 'git.conflict': return `${d.op} conflict on ${d.branch}: ${(d.files as string[]).join(', ')}`;
    case 'shared.write': return `wrote shared/${d.path} (v${d.version})`;
    case 'shared.clash': return `changed shared/${d.path}, which is ${d.owner}'s`;
    default: return e.type;
  }
}

interface Props {
  goal: Goal;
  agent: Agent;
  events: MhEvent[];
  manifest?: Manifest;
  onCommand: (body: Record<string, unknown>, confirm?: string) => Promise<unknown>;
  onSpawnUnder: (name: string) => void;
}

export function AgentDetail({ goal, agent, events, manifest, onCommand, onSpawnUnder }: Props) {
  const items = useMemo(() => streamOf(events, agent.name), [events, agent.name]);
  const [detail, setDetail] = useState<Detail>();
  const [text, setText] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [openNative, setOpenNative] = useState<{ command?: string; note: string }>();
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDetail(undefined);
    void api.agent(goal.id, agent.name).then(setDetail, () => {});
  }, [goal.id, agent.name]);
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [items.length]);

  const live = goal.live && goal.status !== 'ended' && !['ended', 'crashed'].includes(agent.state);
  const paused = agent.state === 'paused' || agent.pausing;
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
          <span className="pill">{agent.pausing ? 'pausing…' : STATE_LABEL[agent.state]}</span>
        </h2>
        <div className="sub">
          {agent.role} · {agent.harness} · {agent.model}
          {agent.parent !== 'human' ? ` · spawned by ${agent.parent}` : ' · started by you'}
        </div>
        {agent.status && !['done', 'ended'].includes(agent.state) && <div className="status-line">“{agent.status}”</div>}
        <div className="row muted" style={{ fontSize: 12.5 }}>
          {manifest?.reportsCost !== false && <span>{money(agent.cost)}</span>}
          {agent.contextPct != null && (
            <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
              <Ctx pct={agent.contextPct} /> context {agent.contextPct}%
            </span>
          )}
          {agent.branch && <span className="mono">{agent.branch}</span>}
          {agent.limitedUntil && <span>rate limited until {clock(agent.limitedUntil)}</span>}
        </div>
        {live && (
          <div className="row">
            {paused ? (
              <button className="btn small" onClick={() => onCommand({ cmd: 'agent.resume', goal: goal.id, agent: agent.name })}>
                ▶ Resume
              </button>
            ) : (
              <button className="btn small" onClick={() => onCommand({ cmd: 'agent.pause', goal: goal.id, agent: agent.name })} title="Stops after its current step; messages wait">
                ⏸ Pause
              </button>
            )}
            <button className="btn small danger" onClick={() => onCommand({ cmd: 'agent.stop', goal: goal.id, agent: agent.name }, `Stop ${agent.name}? Its session ends; whoever spawned it is told.`)}>
              Stop
            </button>
            <button className="btn small" onClick={() => void onCommand({ cmd: 'agent.open_native', goal: goal.id, agent: agent.name }).then(r => setOpenNative(r as { command?: string; note: string }))}>
              Open in {agent.harness}
            </button>
            {!agent.quick && (
              <button className="btn small" onClick={() => onSpawnUnder(agent.name)}>
                + Helper
              </button>
            )}
          </div>
        )}
      </div>

      <div
        className="scroll"
        ref={scroller}
        onScroll={() => {
          const s = scroller.current!;
          stick.current = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
        }}
      >
        <details className="block">
          <summary>Brief</summary>
          <div className="content">
            <pre>{agent.brief}</pre>
          </div>
        </details>
        <details className="block">
          <summary>Prompt and where it works</summary>
          <div className="content">
            <dl className="kv" style={{ padding: '0 0 8px' }}>
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
            </dl>
            {detail?.systemPrompt ? <pre>{detail.systemPrompt}</pre> : <div className="muted">{detail ? 'The prompt is only kept while the goal runs here.' : 'Loading…'}</div>}
          </div>
        </details>
        {agent.doneNote && agent.state !== 'done' && (
          <details className="block" open>
            <summary>Note</summary>
            <div className="content">
              <pre>{agent.doneNote}</pre>
            </div>
          </details>
        )}

        <div className="stream">
          {items.map(i => <StreamItem key={i.seq} item={i} />)}
          {!items.length && <div className="empty">Nothing yet.</div>}
          <div ref={bottom} />
        </div>
      </div>

      {live && (
        <div className="composer">
          <textarea
            rows={2}
            placeholder={`Message ${agent.name}${paused ? ' (it waits until you resume it)' : ''}… (Ctrl+Enter to send)`}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
            }}
          />
          <div className="row">
            <label className="check" title="Pauses its turn between steps to deliver this now">
              <input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} /> Urgent
            </label>
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

function StreamItem({ item }: { item: Item }) {
  switch (item.kind) {
    case 'say':
      return <div className="item-say" title={clock(item.ts)}>{item.text}</div>;
    case 'done':
      return (
        <div className="item-done" title={clock(item.ts)}>
          <b>Done.</b> {item.text}
        </div>
      );
    case 'msg':
      return (
        <div className={`item-msg ${item.dir}`}>
          <div className="from">
            {item.dir === 'in' ? `from ${item.who}` : `to ${item.who}`}
            {item.urgent ? ' · urgent' : ''} · {clock(item.ts)}
          </div>
          {item.text}
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
      return <div className={`item-note${item.warn ? ' warn' : ''}`}>{clock(item.ts)} · {item.text}</div>;
  }
}
