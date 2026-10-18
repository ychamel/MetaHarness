import { useState } from 'react';
import { ago } from '../format.ts';
import type { InboxItem } from '../types.ts';
import { Markdown, More } from './common.tsx';

type Resolve = (item: string, decision: 'approve' | 'deny' | 'dismiss', reply?: string) => void;

/** Approvals, decisions and questions block an agent until you answer; the rest are updates. */
export const ACTIONABLE: InboxItem['kind'][] = ['approval', 'decision', 'question'];

const KIND: Record<InboxItem['kind'], string> = {
  approval: 'wants to run',
  decision: 'asks you to decide',
  question: 'asks you',
  done: 'finished',
  stopped: 'stopped',
  crash: 'crashed',
};

/** What's waiting on you, most prominent: an agent can't go on until you answer. */
export function NeedsYou({ items, onResolve, onSelectAgent, goalLabel }: { items: InboxItem[]; onResolve: Resolve; onSelectAgent: (name: string, goal: string) => void; goalLabel?: (goal: string) => string }) {
  if (!items.length) return null;
  return (
    <section className="needs-you" aria-label="Needs you">
      <div className="needs-head">
        <span className="pulse" aria-hidden />
        <b>Needs you</b>
        <span className="muted">
          {items.length} waiting on your answer
        </span>
      </div>
      <div className="needs-list">
        {items.map(i => (
          <InboxCard key={i.id} item={i} onResolve={onResolve} onSelectAgent={onSelectAgent} goalLabel={goalLabel?.(i.goal)} />
        ))}
      </div>
    </section>
  );
}

/** Results and stops: worth reading, nothing waits on them. */
export function Updates({ items, onResolve, onSelectAgent }: { items: InboxItem[]; onResolve: Resolve; onSelectAgent: (name: string, goal: string) => void }) {
  return (
    <div className="inbox">
      <div className="section-title">
        Updates {items.length > 0 && <span className="badge quiet">{items.length}</span>}
        <span className="spacer" />
        {items.length > 1 && (
          <button className="btn ghost small" onClick={() => items.forEach(i => onResolve(i.id, 'dismiss'))}>
            Clear all
          </button>
        )}
      </div>
      <div className="scroll">
        {items.map(i => (
          <InboxCard key={i.id} item={i} onResolve={onResolve} onSelectAgent={onSelectAgent} compact />
        ))}
        {!items.length && <div className="empty">Results from agents that report to you show up here.</div>}
      </div>
    </div>
  );
}

export function InboxCard({ item, onResolve, onSelectAgent, goalLabel, compact }: { item: InboxItem; onResolve: Resolve; onSelectAgent: (name: string, goal: string) => void; goalLabel?: string; compact?: boolean }) {
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const r = reply.trim() || undefined;
  return (
    <div className={`inbox-item ${item.kind}${compact ? ' compact' : ''}`}>
      <div className="head">
        <button className="name-link" onClick={() => onSelectAgent(item.agent, item.goal)}>
          {item.agent}
        </button>
        <span>{KIND[item.kind]}</span>
        <span className="spacer" />
        {goalLabel && <span className="goal-label" title={goalLabel}>{goalLabel}</span>}
        <span className="muted">{ago(item.ts)}</span>
      </div>
      <More lines={compact ? 3 : 6} className="body">
        {item.kind === 'approval' ? <pre className="code">{item.text}</pre> : <Markdown text={item.text} />}
      </More>
      {item.kind === 'approval' && (
        <>
          {replying && <input type="text" autoFocus placeholder="Note or reason for the agent (optional)" value={reply} onChange={e => setReply(e.target.value)} />}
          <div className="actions">
            <button className="btn primary small" onClick={() => onResolve(item.id, 'approve', r)}>
              Approve
            </button>
            <button className="btn small" onClick={() => onResolve(item.id, 'deny', r)}>
              Deny
            </button>
            {!replying && (
              <button className="btn ghost small" onClick={() => setReplying(true)}>
                Add a note
              </button>
            )}
          </div>
        </>
      )}
      {item.kind === 'decision' && (
        <>
          <textarea rows={2} placeholder="What to change, to send it back (optional when approving)" value={reply} onChange={e => setReply(e.target.value)} />
          <div className="actions">
            <button className="btn primary small" onClick={() => onResolve(item.id, 'approve', r)}>
              Approve
            </button>
            <button className="btn small" disabled={!r} onClick={() => onResolve(item.id, 'deny', r)} title={r ? '' : 'Say what to change first'}>
              Send back
            </button>
          </div>
        </>
      )}
      {item.kind === 'question' && (
        <>
          <textarea
            rows={2}
            placeholder="Your answer (Ctrl+Enter to send)"
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && r && onResolve(item.id, 'dismiss', r)}
          />
          <div className="actions">
            <button className="btn primary small" disabled={!r} onClick={() => onResolve(item.id, 'dismiss', r)}>
              Answer
            </button>
            <button className="btn ghost small" onClick={() => onResolve(item.id, 'dismiss')}>
              Dismiss
            </button>
          </div>
        </>
      )}
      {!ACTIONABLE.includes(item.kind) && (
        <>
          {replying && <input type="text" autoFocus placeholder="Follow up: it picks up again to answer" value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => e.key === 'Enter' && r && onResolve(item.id, 'dismiss', r)} />}
          <div className="actions">
            {replying ? (
              <button className="btn primary small" disabled={!r} onClick={() => onResolve(item.id, 'dismiss', r)}>
                Send
              </button>
            ) : (
              <button className="btn ghost small" onClick={() => setReplying(true)}>
                Follow up
              </button>
            )}
            <button className="btn ghost small" onClick={() => onResolve(item.id, 'dismiss')}>
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
}
