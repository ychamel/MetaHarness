import { useState } from 'react';
import { modelLabel, money, STATE_LABEL } from '../format.ts';
import type { Agent, Goal } from '../types.ts';
import { Ctx, Dot, CacheClock } from './common.tsx';

/** Who spawned whom, with each agent's state, status line, cost and context. Quick helpers fold under their caller. */
export function TeamTree({ goal, selected, onSelect }: { goal: Goal; selected?: string; onSelect: (name: string) => void }) {
  const [openHelpers, setOpenHelpers] = useState<Set<string>>(new Set());
  const byParent = new Map<string, Agent[]>();
  for (const a of goal.agents) byParent.set(a.parent, [...(byParent.get(a.parent) ?? []), a]);
  const roots = goal.agents.filter(a => a.parent === 'human' || !goal.agents.some(p => p.name === a.parent));

  const row = (a: Agent, depth: number) => {
    const kids = byParent.get(a.name) ?? [];
    const helpers = kids.filter(k => k.quick);
    const team = kids.filter(k => !k.quick);
    const showHelpers = openHelpers.has(a.name);
    const finished = a.state === 'done' || a.state === 'ended';
    return (
      <div key={a.name}>
        <button className={`agent-row${selected === a.name ? ' on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(a.name)}>
          <Dot state={a.pausing ? 'paused' : a.state} />
          <span className="name">
            {a.name}
            {a.quick ? <span className="muted"> · helper</span> : null}
          </span>
          <span className="right">
            {a.awaitingApproval > 0 && <span className="badge warn" title="waiting for your approval">!</span>}
            {a.unread > 0 && <span className="badge" title="unread messages">{a.unread}</span>}
            <CacheClock agent={a} />
            <Ctx pct={a.contextPct} />
            <span>{money(a.cost)}</span>
          </span>
          <span className="meta">
            {a.role} · {a.harness} · {modelLabel(a)} · {a.pausing ? 'pausing…' : STATE_LABEL[a.state]}
          </span>
          {!finished && a.status && <span className="status">{a.status}</span>}
        </button>
        {helpers.length > 0 && (
          <button
            className="helpers-toggle"
            style={{ paddingLeft: 24 + depth * 14 }}
            onClick={() =>
              setOpenHelpers(s => {
                const n = new Set(s);
                if (n.has(a.name)) n.delete(a.name);
                else n.add(a.name);
                return n;
              })
            }
          >
            {showHelpers ? '▾' : '▸'} {helpers.length} helper{helpers.length > 1 ? 's' : ''}
          </button>
        )}
        {showHelpers && helpers.map(h => row(h, depth + 1))}
        {team.map(k => row(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="tree">
      {roots.map(a => row(a, 0))}
      {!roots.length && <div className="empty">No agents yet.</div>}
    </div>
  );
}
