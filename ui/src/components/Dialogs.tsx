import { useState } from 'react';
import type { Goal, Snapshot } from '../types.ts';
import { Dialog } from './common.tsx';

export function StartGoalDialog({ snapshot, onClose, onStart }: { snapshot?: Snapshot; onClose: () => void; onStart: (b: Record<string, unknown>) => void }) {
  const roles = snapshot?.roles.filter(r => !r.helper) ?? [];
  const [request, setRequest] = useState('');
  const [lead, setLead] = useState(roles.find(r => r.name === 'architect')?.name ?? roles[0]?.name ?? '');
  const [workflow, setWorkflow] = useState('');
  return (
    <Dialog title="New goal" onClose={onClose}>
      <label className="field">
        What should the team do?
        <textarea autoFocus rows={5} value={request} onChange={e => setRequest(e.target.value)} placeholder="Add per-user rate limiting to /api/upload" />
      </label>
      <label className="field">
        Lead
        <select value={lead} onChange={e => setLead(e.target.value)}>
          {roles.map(r => (
            <option key={r.name} value={r.name}>
              {r.name} — {r.harness} · {r.model}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Workflow
        <select value={workflow} onChange={e => setWorkflow(e.target.value)}>
          <option value="">Let the lead choose</option>
          {snapshot?.workflows.map(w => (
            <option key={w.name} value={w.name}>
              {w.name}{w.goodAt ? ` — ${w.goodAt}` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="muted" style={{ fontSize: 12.5 }}>
        The team works in the daemon's repository, on the branch checked out there.
      </div>
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!request.trim()} onClick={() => onStart({ cmd: 'goal.start', request: request.trim(), lead: lead || undefined, workflow: workflow || undefined })}>
          Start
        </button>
      </div>
    </Dialog>
  );
}

export function SpawnDialog({ snapshot, goal, parent, onClose, onSpawn }: { snapshot?: Snapshot; goal: Goal; parent?: string; onClose: () => void; onSpawn: (b: Record<string, unknown>) => void }) {
  const roles = snapshot?.roles ?? [];
  const [role, setRole] = useState(roles.find(r => r.name === 'scout')?.name ?? roles[0]?.name ?? '');
  const [brief, setBrief] = useState('');
  const [under, setUnder] = useState(parent ?? 'human');
  const [name, setName] = useState('');
  const [worktree, setWorktree] = useState(false);
  const live = goal.agents.filter(a => !['ended', 'crashed'].includes(a.state) && !a.quick);
  return (
    <Dialog title="Start an agent" onClose={onClose}>
      <label className="field">
        Role
        <select value={role} onChange={e => setRole(e.target.value)}>
          {roles.map(r => (
            <option key={r.name} value={r.name}>
              {r.name} — {r.harness} · {r.model}{r.goodAt ? ` · ${r.goodAt}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Brief: what to do, what's done already, where to look, what you want back
        <textarea autoFocus rows={5} value={brief} onChange={e => setBrief(e.target.value)} />
      </label>
      <label className="field">
        Reports to
        <select value={under} onChange={e => setUnder(e.target.value)}>
          <option value="human">You (its result comes to your Inbox)</option>
          {live.map(a => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Name (optional)
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder={`${role}-n`} />
      </label>
      <label className="check">
        <input type="checkbox" checked={worktree} onChange={e => setWorktree(e.target.checked)} /> Its own git worktree and branch
      </label>
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!brief.trim() || !role}
          onClick={() => onSpawn({ cmd: 'agent.spawn', goal: goal.id, role, brief: brief.trim(), parent: under, name: name.trim() || undefined, worktree: worktree || undefined })}
        >
          Start
        </button>
      </div>
    </Dialog>
  );
}
