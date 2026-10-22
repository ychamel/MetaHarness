import { useState } from 'react';
import type { ConfigView, Goal } from '../types.ts';
import { Dialog, Field, Toggle } from './common.tsx';
import { modelLabel } from '../format.ts';

/** What a goal starts from: the request, who leads, and (optionally) the workflow the lead follows. */
export function NewGoalForm({ config, onStart, onCancel, initialWorkflow = '', autoFocus }: { config?: ConfigView; onStart: (b: Record<string, unknown>) => Promise<boolean>; onCancel?: () => void; initialWorkflow?: string; autoFocus?: boolean }) {
  const leads = config?.roles.filter(r => !r.helper) ?? [];
  const [request, setRequest] = useState('');
  const [lead, setLead] = useState('');
  const [workflow, setWorkflow] = useState(initialWorkflow);
  const [busy, setBusy] = useState(false);
  const leadName = lead || (leads.find(r => r.name === 'architect') ?? leads[0])?.name || '';
  const leadDef = leads.find(r => r.name === leadName);
  const wf = config?.workflows.find(w => w.name === workflow);
  const start = async () => {
    if (!request.trim() || busy) return;
    setBusy(true);
    const ok = await onStart({ cmd: 'goal.start', request: request.trim(), lead: leadName || undefined, workflow: workflow || undefined });
    setBusy(false);
    if (ok) setRequest('');
  };
  return (
    <div className="new-goal">
      <textarea
        autoFocus={autoFocus}
        rows={4}
        value={request}
        onChange={e => setRequest(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void start()}
        placeholder="What should the team do? e.g. Add per-user rate limiting to /api/upload, with tests."
        aria-label="What should the team do?"
      />
      <div className="new-goal-opts">
        <Field label="Lead" hint={leadDef ? `${leadDef.harness} · ${modelLabel(leadDef)}${leadDef.goodAt ? ` — ${leadDef.goodAt}` : ''}` : undefined}>
          <select value={leadName} onChange={e => setLead(e.target.value)}>
            {leads.map(r => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Workflow" hint={wf ? `${wf.goodAt || 'No description.'}${wf.roles.length ? ` Roles: ${wf.roles.join(', ')}.` : ''}` : 'The lead reads the workflows and picks one.'}>
          <select value={workflow} onChange={e => setWorkflow(e.target.value)}>
            <option value="">Let the lead choose</option>
            {config?.workflows.map(w => (
              <option key={w.name} value={w.name}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row end">
        <span className="muted kbd-hint">Ctrl+Enter to start</span>
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={!request.trim() || busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Start the goal'}
        </button>
      </div>
    </div>
  );
}

export function StartGoalDialog({ config, initialWorkflow, onClose, onStart }: { config?: ConfigView; initialWorkflow?: string; onClose: () => void; onStart: (b: Record<string, unknown>) => Promise<boolean> }) {
  return (
    <Dialog title="New goal" onClose={onClose} wide>
      <NewGoalForm config={config} onStart={onStart} onCancel={onClose} initialWorkflow={initialWorkflow} autoFocus />
    </Dialog>
  );
}

export function SpawnDialog({ config, goal, parent, onClose, onSpawn }: { config?: ConfigView; goal: Goal; parent?: string; onClose: () => void; onSpawn: (b: Record<string, unknown>) => void }) {
  const roles = config?.roles ?? [];
  const [role, setRole] = useState(roles.find(r => r.name === 'scout')?.name ?? roles[0]?.name ?? '');
  const [brief, setBrief] = useState('');
  const [under, setUnder] = useState(parent ?? 'human');
  const [name, setName] = useState('');
  const def = roles.find(r => r.name === role);
  const [worktree, setWorktree] = useState<boolean>();
  const live = goal.agents.filter(a => !['ended', 'crashed'].includes(a.state) && !a.quick);
  return (
    <Dialog title="Start an agent" onClose={onClose} wide>
      <Field label="Role" hint={def ? `${def.harness} · ${modelLabel(def)}${def.goodAt ? ` — ${def.goodAt}` : ''}` : undefined}>
        <select value={role} onChange={e => setRole(e.target.value)}>
          {roles.map(r => (
            <option key={r.name} value={r.name}>
              {r.name}
              {r.helper ? ' (quick helper)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Brief" hint="What to do, what's done already, where to look, and what you want back.">
        <textarea autoFocus rows={5} value={brief} onChange={e => setBrief(e.target.value)} />
      </Field>
      <div className="grid-2">
        <Field label="Reports to">
          <select value={under} onChange={e => setUnder(e.target.value)}>
            <option value="human">You (its result comes to you)</option>
            {live.map(a => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name (optional)">
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder={`${role}-n`} />
        </Field>
      </div>
      <Toggle checked={worktree ?? def?.worktree ?? false} onChange={setWorktree} label="Its own git worktree and branch" hint="For work in parallel with others. Otherwise it works in your checkout." />
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!brief.trim() || !role}
          onClick={() => onSpawn({ cmd: 'agent.spawn', goal: goal.id, role, brief: brief.trim(), parent: under, name: name.trim() || undefined, worktree })}
        >
          Start
        </button>
      </div>
    </Dialog>
  );
}

/** A message to one agent, the lead, everyone on the goal, or every agent in a role (as `mh send`). */
export function MessageDialog({ goal, onClose, onSend }: { goal: Goal; onClose: () => void; onSend: (b: Record<string, unknown>) => Promise<boolean> }) {
  const live = goal.agents.filter(a => !['ended', 'crashed'].includes(a.state));
  const roles = [...new Set(live.map(a => a.role))];
  const [to, setTo] = useState('lead');
  const [text, setText] = useState('');
  const [urgent, setUrgent] = useState(false);
  const send = async () => {
    if (text.trim() && (await onSend({ cmd: 'agent.message', goal: goal.id, to, text: text.trim(), urgent }))) onClose();
  };
  return (
    <Dialog title="Message the team" onClose={onClose} wide>
      <Field label="To">
        <select value={to} onChange={e => setTo(e.target.value)}>
          <option value="lead">The lead ({goal.lead})</option>
          <option value="all">Everyone still working</option>
          <optgroup label="Everyone in a role">
            {roles.map(r => (
              <option key={`r:${r}`} value={r}>
                every {r}
              </option>
            ))}
          </optgroup>
          <optgroup label="One agent">
            {live.map(a => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>
      <textarea autoFocus rows={5} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void send()} placeholder="A new requirement, an answer, a change of plan…" aria-label="Message" />
      <Toggle checked={urgent} onChange={setUrgent} label="Urgent" hint="Pauses their turn after the current step to deliver it now, instead of at the next natural break." />
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!text.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
    </Dialog>
  );
}
