import { useState } from 'react';
import { ago } from '../format.ts';
import type { InboxItem } from '../types.ts';

const KIND: Record<InboxItem['kind'], string> = {
  approval: 'needs your approval',
  decision: 'asks you to decide',
  question: 'asks',
  done: 'finished',
  stopped: 'stopped',
  crash: 'crashed',
};

/** Approvals, decisions, questions and results waiting for you, oldest first. */
export function Inbox({ items, onResolve, onSelectAgent }: { items: InboxItem[]; onResolve: (item: string, decision: 'approve' | 'deny' | 'dismiss', reply?: string) => void; onSelectAgent: (name: string) => void }) {
  return (
    <div className="inbox">
      <div className="section-title">
        Inbox {items.length > 0 && <span className="badge">{items.length}</span>}
      </div>
      <div className="scroll">
        {items.map(i => (
          <Item key={i.id} item={i} onResolve={onResolve} onSelectAgent={onSelectAgent} />
        ))}
        {!items.length && <div className="empty">Nothing for you right now.</div>}
      </div>
    </div>
  );
}

function Item({ item, onResolve, onSelectAgent }: { item: InboxItem; onResolve: (item: string, decision: 'approve' | 'deny' | 'dismiss', reply?: string) => void; onSelectAgent: (name: string) => void }) {
  const [reply, setReply] = useState('');
  const [open, setOpen] = useState(false);
  // About six lines fit; past that it folds.
  const long = item.text.length > 200 || item.text.split('\n').length > 5;
  const r = reply.trim() || undefined;
  return (
    <div className={`inbox-item ${item.kind}`}>
      <div className="head">
        <b style={{ cursor: 'pointer' }} onClick={() => onSelectAgent(item.agent)}>
          {item.agent}
        </b>
        {KIND[item.kind]} · {ago(item.ts)}
      </div>
      <div className={`body${open ? ' open' : long ? ' clipped' : ''}`}>{item.text}</div>
      {long && (
        <button className="btn ghost small" onClick={() => setOpen(o => !o)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
      {item.kind === 'approval' && (
        <>
          <input type="text" placeholder="Note or reason (optional)" value={reply} onChange={e => setReply(e.target.value)} />
          <div className="actions">
            <button className="btn primary small" onClick={() => onResolve(item.id, 'approve', r)}>
              Approve
            </button>
            <button className="btn small" onClick={() => onResolve(item.id, 'deny', r)}>
              Deny
            </button>
          </div>
        </>
      )}
      {item.kind === 'decision' && (
        <>
          <input type="text" placeholder="What to change (to send it back)" value={reply} onChange={e => setReply(e.target.value)} />
          <div className="actions">
            <button className="btn primary small" onClick={() => onResolve(item.id, 'approve', r)}>
              Approve
            </button>
            <button className="btn small" disabled={!r} onClick={() => onResolve(item.id, 'deny', r)}>
              Send back
            </button>
          </div>
        </>
      )}
      {item.kind === 'question' && (
        <>
          <input type="text" placeholder="Your answer" value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => e.key === 'Enter' && r && onResolve(item.id, 'dismiss', r)} />
          <div className="actions">
            <button className="btn primary small" disabled={!r} onClick={() => onResolve(item.id, 'dismiss', r)}>
              Answer
            </button>
            <button className="btn small" onClick={() => onResolve(item.id, 'dismiss')}>
              Dismiss
            </button>
          </div>
        </>
      )}
      {(item.kind === 'done' || item.kind === 'stopped' || item.kind === 'crash') && (
        <>
          <input type="text" placeholder="Reply to follow up (optional)" value={reply} onChange={e => setReply(e.target.value)} />
          <div className="actions">
            <button className="btn small" onClick={() => onResolve(item.id, 'dismiss', r)}>
              {r ? 'Send and clear' : 'Clear'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
