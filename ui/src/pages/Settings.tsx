import { useMemo, useState } from 'react';
import type { ApprovalMode, Scope, Settings as SettingsT } from '../types.ts';
import { Field, Toggle } from '../components/common.tsx';
import { EditorFooter, ScopePicker, Section, useDraft, type SetupProps } from './setup.tsx';
import type { ConfigView } from '../types.ts';

type Draft = Omit<SettingsT, 'models' | 'rules'>;
const MODES: [ApprovalMode, string, string][] = [
  ['ask', 'Ask me', 'Whatever the fixed rules don’t settle comes to your Inbox.'],
  ['gatekeeper', 'Gatekeeper', 'A cheap model in the gatekeeper role allows what’s safe, refuses what’s harmful, and asks you about the rest, with its reason.'],
  ['harness', 'Harness’s own', 'Each harness’s automatic approvals where it has them (Claude Code’s auto mode); the gatekeeper, then you, for the rest.'],
];

interface Props extends Pick<SetupProps, 'config' | 'onSave'> {
  /** Opens the gatekeeper's or assistant's role in Roles, writing out the built-in one first if there's no file. */
  onBuiltinRole: (which: 'gatekeeper' | 'assistant', scope: Scope, exists: boolean) => void;
}

/** How MetaHarness behaves: approvals and prompt-cache reminders (settings.json). */
export function Settings({ config, ...p }: Props) {
  if (!config) return <div className="page">Loading…</div>;
  return <SettingsForm config={config} {...p} />;
}

function SettingsForm({ config, onSave, onBuiltinRole }: Props & { config: ConfigView }) {
  const eff = config.settings.effective;
  const [scope, setScope] = useState<Scope>(config.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal');
  const saved = useMemo<Draft>(() => ({ approvals: eff.approvals, gatekeeper: eff.gatekeeper, assistant: eff.assistant, cacheReminders: eff.cacheReminders, cacheRemindSec: eff.cacheRemindSec, cacheRemindMinTokens: eff.cacheRemindMinTokens, defaultCacheMinutes: eff.defaultCacheMinutes, limitCheckMinutes: eff.limitCheckMinutes, contextHandoffPct: eff.contextHandoffPct, stallMinutes: eff.stallMinutes }), [eff]);
  const { draft, set, dirty, revert } = useDraft<Draft>(saved);
  const [busy, setBusy] = useState(false);
  const from = (k: keyof Draft) => [...config.settings.files].reverse().find(f => f.values[k] !== undefined)?.scope;
  const where = (k: keyof Draft) => {
    const s = from(k);
    return s ? `from ${s === 'repo' ? 'this repository' : 'your personal'} settings` : 'the default';
  };

  const save = async () => {
    setBusy(true);
    const patch = Object.fromEntries((Object.keys(draft) as (keyof Draft)[]).filter(k => draft[k] !== saved[k]).map(k => [k, draft[k]]));
    await onSave({ cmd: 'settings.save', scope, patch });
    setBusy(false);
  };

  return (
    <div className="page setup">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="muted intro">
            How approvals are decided, when you hear about expiring prompt caches, how often plan limits are checked, and how agents are kept going. Saved in <span className="mono">settings.json</span>; this repository’s settings win over your personal ones.
          </div>
        </div>
      </div>
      <div className="settings-body">
        <div className="editor">
          <div className="editor-scroll">
            <Section title="Save to">
              <ScopePicker config={config} value={scope} onChange={setScope} />
            </Section>

            <Section title="Approvals" hint={where('approvals')}>
              <div className="choice-list" role="radiogroup">
                {MODES.map(([mode, label, hint]) => (
                  <label key={mode} className={`choice${draft.approvals === mode ? ' on' : ''}`}>
                    <input type="radio" name="approvals" checked={draft.approvals === mode} onChange={() => set('approvals', mode)} />
                    <span>
                      <b>{label}</b>
                      <span className="hint">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="hint">
                Either way, MetaHarness itself still refuses pushes and history rewrites, runs read-only commands without asking, and lets each role’s <i>allow</i> list through. A role can choose its own mode.
              </div>
              {draft.approvals !== 'ask' && (
                <RolePick
                  config={config}
                  label="Gatekeeper role"
                  value={draft.gatekeeper}
                  builtIn="Built in: Claude haiku, with Codex and Antigravity backups."
                  onChange={v => set('gatekeeper', v)}
                  onEdit={exists => onBuiltinRole('gatekeeper', scope, exists)}
                />
              )}
            </Section>

            <Section title="Assistant" hint={where('assistant')}>
              <div className="hint">The Ask panel answers questions about your goals and helps with setup. It only reads; changes it suggests wait for you to apply them. Each conversation starts fresh.</div>
              <RolePick
                config={config}
                label="Assistant role"
                value={draft.assistant}
                builtIn="Built in: Codex gpt-6-luna, with Claude haiku and Antigravity backups."
                onChange={v => set('assistant', v)}
                onEdit={exists => onBuiltinRole('assistant', scope, exists)}
              />
            </Section>

            <Section title="Prompt caches" hint={where('cacheReminders')}>
              <Toggle
                checked={draft.cacheReminders}
                onChange={v => set('cacheReminders', v)}
                label="Remind before a cache expires"
                hint="An agent’s spawner hears shortly before its cache expires, so it can send follow-up work while it’s cheap. You hear about the lead’s."
              />
              <div className="grid-3">
                <Field label="Remind this long before" hint="seconds">
                  <input type="number" min={10} value={draft.cacheRemindSec} onChange={e => set('cacheRemindSec', Number(e.target.value))} />
                </Field>
                <Field label="Only above" hint="tokens of context">
                  <input type="number" min={0} step={1000} value={draft.cacheRemindMinTokens} onChange={e => set('cacheRemindMinTokens', Number(e.target.value))} />
                </Field>
                <Field label="Default cache life" hint="minutes, when neither the harness nor Harnesses says">
                  <input type="number" min={1} value={draft.defaultCacheMinutes} onChange={e => set('defaultCacheMinutes', Number(e.target.value))} />
                </Field>
              </div>
            </Section>

            <Section title="Plan limits" hint={where('limitCheckMinutes')}>
              <div className="grid-3">
                <Field label="Check every" hint="minutes; 0 checks only when you ask">
                  <input type="number" min={0} value={draft.limitCheckMinutes} onChange={e => set('limitCheckMinutes', Number(e.target.value))} />
                </Field>
              </div>
              <div className="hint">Each harness is asked where its plan’s windows stand (Claude Code’s /usage, Codex’s rate limits, Antigravity’s /quota) without running a turn, so it costs nothing. Agents also report them as they work.</div>
            </Section>

            <Section title="Keeping agents going" hint={where('contextHandoffPct')}>
              <div className="grid-3">
                <Field label="Fresh session at" hint="% of the context window; 0 never">
                  <input type="number" min={0} max={100} value={draft.contextHandoffPct} onChange={e => set('contextHandoffPct', Number(e.target.value))} />
                </Field>
                <Field label="Report stuck agents after" hint="minutes of waiting; 0 never">
                  <input type="number" min={0} value={draft.stallMinutes} onChange={e => set('stallMinutes', Number(e.target.value))} />
                </Field>
              </div>
              <div className="hint">
                An agent whose context is this full writes notes, then continues in a fresh session from a handoff: the goal, its brief, what it did, its team and where its work is. Between turns, its next message starts the fresh session, so no turn is spent on it. Antigravity doesn’t report its context, so it relies on its own compaction.
              </div>
              <div className="hint">
                Agents waiting on each other, or on a teammate who has finished, or a team where nobody is doing anything, are reported to the lead, since it’s usually a gap in the plan. If the lead has finished, or the whole team stays stuck after the lead was told, you hear.
              </div>
            </Section>
          </div>
          <EditorFooter dirty={dirty} isNew={false} saving={busy} onSave={() => void save()} onRevert={revert} />
        </div>
      </div>
    </div>
  );
}

/** Which role fills a built-in job (gatekeeper, assistant), and a way to edit it. */
function RolePick({ config, label, value, builtIn, onChange, onEdit }: { config: ConfigView; label: string; value: string; builtIn: string; onChange: (v: string) => void; onEdit: (exists: boolean) => void }) {
  const role = config.roles.find(r => r.name === value);
  return (
    <div className="grid-2">
      <Field label={label} hint={role ? `${role.harness} · ${role.model || 'its default model'}${role.fallback.length ? `, backups ${role.fallback.join(', ')}` : ''}` : builtIn}>
        <select value={value} onChange={e => onChange(e.target.value)}>
          {!role && <option value={value}>{value} (built in)</option>}
          {config.roles.map(r => (
            <option key={`${r.scope}/${r.name}`} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="field">
        <span className="field-label">&nbsp;</span>
        <button className="btn small" onClick={() => onEdit(!!role)}>
          {role ? `Edit the ${value} role` : `Make a ${value} role to choose its model`}
        </button>
      </div>
    </div>
  );
}
