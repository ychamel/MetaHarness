import { useEffect, useRef, useState } from 'react';
import { ago, BUSY, money } from '../format.ts';
import type { Goal, GoalSummary } from '../types.ts';

interface Props {
  goals: GoalSummary[];
  goal?: Goal;
  inboxCount: number;
  connected: boolean;
  onPick: (id: string) => void;
  onNewGoal: () => void;
  onSpawn: () => void;
  onCommand: (body: Record<string, unknown>, confirm?: string) => void;
}

export function Header({ goals, goal, inboxCount, connected, onPick, onNewGoal, onSpawn, onCommand }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const agents = goal?.agents ?? [];
  const working = agents.filter(a => BUSY.includes(a.state)).length;
  const paused = agents.filter(a => a.state === 'paused' || a.pausing).length;
  const live = goal?.live && goal.status !== 'ended';
  const allPaused = live && paused > 0 && paused === agents.filter(a => !['ended', 'crashed'].includes(a.state)).length;

  return (
    <header className="header">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 16 16" aria-hidden>
          <circle cx="4" cy="8" r="3" fill="var(--accent)" />
          <circle cx="12" cy="4" r="2.5" fill="var(--done)" />
          <circle cx="12" cy="12" r="2.5" fill="var(--waiting)" />
        </svg>
        MetaHarness
      </div>

      <div className="goal-picker" ref={ref}>
        <button onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}>
          {goal ? <span className={`pill ${goal.status}`}>{goal.status}</span> : null}
          <span className="title">{goal ? goal.request : goals.length ? 'Pick a goal' : 'No goals yet'}</span>
          <span className="muted">▾</span>
        </button>
        {open && (
          <div className="menu" role="listbox">
            {goals.map(g => (
              <button
                key={g.id}
                className={`menu-item${g.id === goal?.id ? ' on' : ''}`}
                onClick={() => {
                  onPick(g.id);
                  setOpen(false);
                }}
              >
                <span className={`pill ${g.status}`}>{g.status}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.request}</span>
                <span className="sub">
                  {g.agents} agents · {money(g.cost)} · {ago(g.createdAt)}
                </span>
              </button>
            ))}
            {!goals.length && <div className="empty">Start one with “New goal”.</div>}
          </div>
        )}
      </div>

      {goal && (
        <div className="stats">
          <span>
            <b>{money(goal.cost)}</b>
          </span>
          <span>
            <b>{agents.length}</b> agents{working ? ` (${working} working)` : ''}
          </span>
          <span>
            Inbox <b>{inboxCount}</b>
          </span>
          {goal.branch && <span className="mono">{goal.branch}</span>}
          {!connected && goal.live && <span style={{ color: 'var(--limited)' }}>reconnecting…</span>}
        </div>
      )}

      <div className="spacer" />
      {live && (
        <>
          <button className="btn" onClick={onSpawn}>
            + Agent
          </button>
          <button className="btn" onClick={() => onCommand({ cmd: allPaused ? 'goal.resume' : 'goal.pause', goal: goal!.id })}>
            {allPaused ? '▶ Resume all' : '⏸ Pause all'}
          </button>
          <button className="btn danger" onClick={() => onCommand({ cmd: 'goal.end', goal: goal!.id }, 'End this goal? Every agent on it stops, and its merged worktrees are cleaned up.')}>
            End goal
          </button>
        </>
      )}
      <button className="btn primary" onClick={onNewGoal}>
        New goal
      </button>
    </header>
  );
}
