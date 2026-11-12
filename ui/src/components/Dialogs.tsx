import { AttachButton, Drafts, newDraft, startFiles, useAttachments, withAttachments } from './Attachments.tsx';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { ConfigView, Goal } from '../types.ts';
import { Dialog, Field, Toggle } from './common.tsx';
import { ago, modelLabel } from '../format.ts';
import { useBeginner } from '../beginner.ts';

/** Ways to start a request: a few prompts that make it clear enough for the team to start well. */
export const REQUEST_TEMPLATES: { label: string; text: string }[] = [
  { label: 'Fix a bug', text: ['Fix a bug.', 'What happens now: ', 'What should happen instead: ', 'How to see it (steps, a page or a command): ', 'Where it is, if you know: '].join('\n') },
  { label: 'Add a feature', text: ['Add a feature.', 'What it should do: ', 'Who uses it, and how: ', 'How I’ll know it works: ', 'Anything it must not change: '].join('\n') },
  { label: 'Explain some code', text: ['Explain how this works, in plain words, without changing any code.', 'What I want to understand: ', 'Where it is, if you know: ', 'Write the explanation to shared/explanation.md.'].join('\n') },
  { label: 'Clean up', text: ['Clean up code without changing what it does.', 'Which part: ', 'What bothers me about it: ', 'Keep every test passing.'].join('\n') },
];

/** Added to a request when the human wants to be asked before the team starts. */
export const ASK_FIRST = '\n\nBefore any work starts, ask me (send to human) what you need to know to get this right: one question at a time, with options where you can.';

/** What a goal starts from: the request, who leads, and (optionally) the workflow the lead follows. */
export function NewGoalForm({ config, onStart, onCancel, initialWorkflow = '', initialRequest = '', extra, autoFocus }: {
  config?: ConfigView;
  onStart: (b: Record<string, unknown>) => Promise<boolean>;
  onCancel?: () => void;
  initialWorkflow?: string;
  initialRequest?: string;
  /** Sent along with goal.start, e.g. the room it comes from. */
  extra?: Record<string, unknown>;
  autoFocus?: boolean;
}) {
  const leads = config?.roles.filter(r => !r.helper) ?? [];
  const [request, setRequest] = useState(initialRequest);
  const [lead, setLead] = useState('');
  const [workflow, setWorkflow] = useState(initialWorkflow);
  const [busy, setBusy] = useState(false);
  const beginner = useBeginner();
  const [askFirst, setAskFirst] = useState(beginner);
  const leadName = lead || (leads.find(r => r.name === 'architect') ?? leads[0])?.name || '';
  const leadDef = leads.find(r => r.name === leadName);
  const wf = config?.workflows.find(w => w.name === workflow);
  const [draft] = useState(newDraft);
  const attachments = useAttachments(draft);
  const start = async () => {
    if (!request.trim() || busy) return;
    setBusy(true);
    const lines = await attachments.upload();
    const ok = lines && (await onStart({ cmd: 'goal.start', request: request.trim() + (askFirst ? ASK_FIRST : ''), lead: leadName || undefined, workflow: workflow || undefined, ...startFiles(draft, lines), ...extra }));
    setBusy(false);
    if (ok) {
      setRequest('');
      attachments.clear();
    }
  };
  return (
    <div className="new-goal">
      <div className="templates" role="group" aria-label="Start from">
        <span className="muted small">Start from:</span>
        {REQUEST_TEMPLATES.map(t => (
          <button key={t.label} type="button" className="btn ghost small" onClick={() => setRequest(r => (r.trim() ? `${r.trimEnd()}\n\n${t.text}` : t.text))}>
            {t.label}
          </button>
        ))}
      </div>
      <textarea
        autoFocus={autoFocus}
        rows={4}
        value={request}
        onChange={e => setRequest(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void start()}
        onPaste={attachments.onPaste}
        placeholder="What should the team do? e.g. Add per-user rate limiting to /api/upload, with tests."
        aria-label="What should the team do?"
      />
      <div className="attach-area" ref={attachments.zone}>
        <Drafts a={attachments} />
        <AttachButton a={attachments} />
      </div>
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
            {(() => {
              // Grouped by folder when there are any.
              const all = config?.workflows ?? [];
              const option = (name: string) => (
                <option key={name} value={name}>
                  {name}
                </option>
              );
              const folders = [...new Set(all.map(w => w.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
              const rest = all.filter(w => !w.folder).map(w => w.name);
              if (!folders.length) return rest.map(option);
              return (
                <>
                  {folders.map(f => (
                    <optgroup key={f} label={f}>
                      {all.filter(w => w.folder === f).map(w => option(w.name))}
                    </optgroup>
                  ))}
                  {rest.length > 0 && <optgroup label="Other">{rest.map(option)}</optgroup>}
                </>
              );
            })()}
          </select>
        </Field>
      </div>
      <Toggle checked={askFirst} onChange={setAskFirst} label="Ask me questions before starting" hint="The lead asks you what it needs to know first, one question at a time, so the team doesn’t guess." />
      <div className="row end">
        <span className="muted kbd-hint">Ctrl+Enter to start</span>
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn primary" disabled={!request.trim() || busy} onClick={() => void start()}>
          {attachments.busy ? 'Uploading…' : busy ? 'Starting…' : 'Start the goal'}
        </button>
      </div>
    </div>
  );
}

/** A goal or room a new goal continues from: what it was, and what the new goal is for. */
export interface ContinueFrom {
  id: string;
  label: string;
  kind: 'goal' | 'room' | 'prototype';
  /** A prototype: the version to build. */
  version?: number;
  action?: 'implement' | 'review' | 'continue';
  /** Documents to take along (relative to its shared folder); unset: the main one. */
  files?: string[];
}

const ACTIONS: Record<NonNullable<ContinueFrom['action']>, { title: string; request: string }> = {
  implement: { title: 'Implement', request: 'Implement the design in the imported files.' },
  review: { title: 'Review', request: 'Review what the previous goal did: bugs, gaps and design problems.' },
  continue: { title: 'Continue from', request: '' },
};

/** The document a goal is most likely continued from: its latest design, plan or report of its own. */
export function keyDoc(docs: { path: string }[]): string | undefined {
  const own = docs.filter(d => !d.path.startsWith('imported/') && /\.md$/i.test(d.path));
  const named = (d: { path: string }) => /(design|plan|spec|report|review|audit|proposal|brief)[^/]*\.md$/i.test(d.path);
  const top = own.filter(d => !d.path.includes('/'));
  // Its own top-level design or report first; files in folders are mostly notes and logs.
  return (top.find(named) ?? own.find(named) ?? top[0] ?? own[0])?.path;
}

export function StartGoalDialog({ config, initialWorkflow, initialRequest, from, onClose, onStart }: { config?: ConfigView; initialWorkflow?: string; initialRequest?: string; from?: ContinueFrom; onClose: () => void; onStart: (b: Record<string, unknown>) => Promise<boolean> }) {
  const action = from?.action ? ACTIONS[from.action] : undefined;
  const [files, setFiles] = useState<string[]>();
  const extra = !from ? undefined : from.kind === 'prototype' ? { prototype: from.id, version: from.version } : from.kind === 'room' ? { fromRoom: from.id } : { from: from.id, files: files ?? [] };
  return (
    <Dialog title={!from ? 'New goal' : from.kind === 'prototype' ? `Build for production: ${from.label.slice(0, 60)}` : from.kind === 'room' ? 'New goal from the room' : `${action?.title ?? 'Continue from'}: ${from.label.slice(0, 60)}`} onClose={onClose} wide>
      {from?.kind === 'room' && <div className="dialog-body muted small">The room's board, its design if one was written, and the whole chat are copied into the new goal's shared folder, and the lead is pointed at them.</div>}
      {from?.kind === 'prototype' && <div className="dialog-body muted small">A goal of its own, whatever happens to the room. It can read and play v{from.version}, and gets what it changed, its builder's notes and shortcuts, how it went and the values you kept. Prototypes cut corners, so it reimplements what this one proves to your project's standards.</div>}
      {from?.kind === 'goal' && <DocPicker goal={from.id} preset={from.files} picked={files} onPick={setFiles} />}
      <NewGoalForm config={config} onStart={onStart} onCancel={onClose} initialWorkflow={initialWorkflow} initialRequest={initialRequest ?? action?.request} extra={extra} autoFocus />
    </Dialog>
  );
}

/** The documents of the goal being continued, to copy into the new one; the lead also gets its outcome. */
function DocPicker({ goal, preset, picked, onPick }: { goal: string; preset?: string[]; picked?: string[]; onPick: (f: string[]) => void }) {
  const [docs, setDocs] = useState<{ path: string; size: number; at: string }[]>();
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    api.command<{ docs: { path: string; size: number; at: string }[] }>({ cmd: 'goal.docs', goal }).then(
      r => {
        if (!alive) return;
        setDocs(r.docs);
        const main = keyDoc(r.docs);
        onPick(preset ?? (main ? [main] : []));
      },
      () => alive && setDocs([]),
    );
    return () => {
      alive = false;
    };
    // Read once per goal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal]);
  const on = new Set(picked ?? []);
  const shown = all ? docs : docs?.filter((d, i) => i < 8 || on.has(d.path));
  return (
    <div className="dialog-body doc-picker">
      <div className="muted small">Its outcome goes to the lead. Documents to copy into the new goal's shared folder (as <span className="mono">imported/…</span>), so they outlast the old goal:</div>
      {!docs ? (
        <div className="muted small">Reading its shared folder…</div>
      ) : !docs.length ? (
        <div className="muted small">It left no documents.</div>
      ) : (
        <div className="doc-list">
          {shown!.map(d => (
            <label key={d.path} className="check small">
              <input type="checkbox" checked={on.has(d.path)} onChange={e => onPick(e.target.checked ? [...on, d.path] : [...on].filter(p => p !== d.path))} />
              <span className="mono">{d.path}</span>
              <span className="muted">{ago(d.at)}</span>
            </label>
          ))}
          {!all && docs.length > shown!.length && (
            <button className="btn ghost small" onClick={() => setAll(true)}>
              All {docs.length}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** What to do next with a finished goal or room: each opens a new goal that continues it. */
export function ContinueButtons({ from, onContinue, small }: { from: Omit<ContinueFrom, 'action'>; onContinue: (f: ContinueFrom) => void; small?: boolean }) {
  const cls = `btn${small ? ' small' : ''}`;
  if (from.kind === 'room')
    return (
      <button className={cls} onClick={() => onContinue(from)} title="A goal that carries out what the room settled, with its board copied in">
        → Goal
      </button>
    );
  return (
    <>
      <button className={cls} onClick={() => onContinue({ ...from, action: 'implement' })} title="A new goal that implements its design: the documents are copied in">
        Implement
      </button>
      <button className={cls} onClick={() => onContinue({ ...from, action: 'review' })} title="A new goal that reviews what it did">
        Review
      </button>
      <button className={cls} onClick={() => onContinue({ ...from, action: 'continue' })} title="A new goal of your own that starts from it">
        Continue…
      </button>
    </>
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
export function MessageDialog({ goal, initial = '', onClose, onSend }: { goal: Goal; initial?: string; onClose: () => void; onSend: (b: Record<string, unknown>) => Promise<boolean> }) {
  const live = goal.agents.filter(a => !['ended', 'crashed'].includes(a.state));
  const roles = [...new Set(live.map(a => a.role))];
  const [to, setTo] = useState('lead');
  const [text, setText] = useState(initial);
  const [urgent, setUrgent] = useState(false);
  const attachments = useAttachments(goal.id);
  const send = async () => {
    if (!text.trim() && !attachments.drafts.length) return;
    const lines = await attachments.upload();
    if (lines && (await onSend({ cmd: 'agent.message', goal: goal.id, to, text: withAttachments(text, lines), urgent }))) onClose();
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
      <div className="attach-area" ref={attachments.zone} onPaste={attachments.onPaste}>
        <textarea autoFocus rows={5} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void send()} placeholder="A new requirement, an answer, a change of plan…" aria-label="Message" />
        <Drafts a={attachments} />
        <AttachButton a={attachments} />
      </div>
      <Toggle checked={urgent} onChange={setUrgent} label="Urgent" hint="Pauses their turn after the current step to deliver it now, instead of at the next natural break." />
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={(!text.trim() && !attachments.drafts.length) || attachments.busy} onClick={() => void send()}>
          {attachments.busy ? 'Uploading…' : 'Send'}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * Undo a finished goal (goal.undo): first what it would undo, then, once confirmed, every file
 * back as it was before the goal, saved as one new commit. Refusals (uncommitted changes, another
 * branch, a team still at work) are shown as the daemon words them.
 */
export function UndoGoalButton({ goal }: { goal: string }) {
  const [step, setStep] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'confirm'; commits: { sha: string; summary: string }[] } | { kind: 'said'; text: string; ok: boolean }>({ kind: 'idle' });
  const run = async (confirm: boolean) => {
    setStep({ kind: 'busy' });
    try {
      const r = await api.command<{ commits: { sha: string; summary: string }[]; undone?: string }>({ cmd: 'goal.undo', goal, confirm });
      if (r.undone) setStep({ kind: 'said', ok: true, text: `Undone as commit ${r.undone}. The goal’s work is still in the history, so this can be undone too.` });
      else if (!r.commits.length) setStep({ kind: 'said', ok: true, text: 'Nothing to undo: the project has no commits since this goal started.' });
      else setStep({ kind: 'confirm', commits: r.commits });
    } catch (e) {
      setStep({ kind: 'said', ok: false, text: (e as Error).message });
    }
  };
  if (step.kind === 'idle' || step.kind === 'busy')
    return (
      <button className="btn small ghost" disabled={step.kind === 'busy'} onClick={() => void run(false)} title="Put the project back as it was before this goal, as a new commit">
        {step.kind === 'busy' ? 'Checking…' : 'Undo this goal'}
      </button>
    );
  if (step.kind === 'said')
    return (
      <span className={`undo-said small${step.ok ? '' : ' bad'}`} role="status">
        {step.text}{' '}
        <button className="btn ghost small" onClick={() => setStep({ kind: 'idle' })}>
          OK
        </button>
      </span>
    );
  return (
    <div className="undo-confirm" role="group" aria-label="Undo this goal">
      <div className="small">
        This puts every file back as it was before the goal, as one new commit. It undoes {step.commits.length === 1 ? 'this commit' : `these ${step.commits.length} commits`}:
      </div>
      <ul className="small mono">
        {step.commits.slice(0, 12).map(c => (
          <li key={c.sha}>
            {c.sha} {c.summary}
          </li>
        ))}
        {step.commits.length > 12 && <li>…and {step.commits.length - 12} more</li>}
      </ul>
      <div className="row">
        <button className="btn small danger" onClick={() => void run(true)}>
          Undo {step.commits.length === 1 ? 'it' : `all ${step.commits.length}`}
        </button>
        <button className="btn small ghost" onClick={() => setStep({ kind: 'idle' })}>
          Keep it
        </button>
      </div>
    </div>
  );
}
