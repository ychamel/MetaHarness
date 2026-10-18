import { useMemo, useState } from 'react';
import type { ApprovalMode, Scope, Settings as SettingsT } from '../types.ts';
import { Field, Toggle } from '../components/common.tsx';
import { EditorFooter, ScopePicker, Section, useDraft, type SetupProps } from './setup.tsx';
import type { ConfigView } from '../types.ts';

type Draft = Omit<SettingsT, 'models'>;
const MODES: [ApprovalMode, string, string][] = [
  ['ask', 'Ask me', 'Whatever the fixed rules don’t settle comes to your Inbox.'],
  ['gatekeeper', 'Gatekeeper', 'A cheap model in the gatekeeper role allows what’s safe, refuses what’s harmful, and asks you about the rest, with its reason.'],
  ['harness', 'Harness’s own', 'Each harness’s automatic approvals where it has them (Claude Code’s auto mode); the gatekeeper, then you, for the rest.'],
];

interface Props extends Pick<SetupProps, 'config' | 'onSave'> {
  /** Opens the gatekeeper role in Roles, writing out the built-in one first if there's no file. */
  onGatekeeper: (scope: Scope, exists: boolean) => void;
}

/** How MetaHarness behaves: approvals and prompt-cache reminders (settings.json). */
export function Settings({ config, ...p }: Props) {
  if (!config) return <div className="page">Loading…</div>;
  return <SettingsForm config={config} {...p} />;
}

function SettingsForm({ config, onSave, onGatekeeper }: Props & { config: ConfigView }) {
  const eff = config.settings.effective;
  const [scope, setScope] = useState<Scope>(config.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal');
  const saved = useMemo<Draft>(() => ({ approvals: eff.approvals, gatekeeper: eff.gatekeeper, cacheReminders: eff.cacheReminders, cacheRemindSec: eff.cacheRemindSec, cacheRemindMinTokens: eff.cacheRemindMinTokens, defaultCacheMinutes: eff.defaultCacheMinutes }), [eff]);
  const { draft, set, dirty, revert } = useDraft<Draft>(saved);
  const [busy, setBusy] = useState(false);
  const from = (k: keyof Draft) => [...config.settings.files].reverse().find(f => f.values[k] !== undefined)?.scope;
  const where = (k: keyof Draft) => {
    const s = from(k);
    return s ? `from ${s === 'repo' ? 'this repository' : 'your personal'} settings` : 'the default';
  };
  const gk = config.roles.find(r => r.name === draft.gatekeeper);

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
            How approvals are decided and when you hear about expiring prompt caches. Saved in <span className="mono">settings.json</span>; this repository’s settings win over your personal ones.
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
                <div className="grid-2">
                  <Field label="Gatekeeper role" hint={gk ? `${gk.harness} · ${gk.model || 'its default model'}${gk.fallback.length ? `, backups ${gk.fallback.join(', ')}` : ''}` : 'Built in: Claude haiku, with Codex and Antigravity backups.'}>
                    <select value={draft.gatekeeper} onChange={e => set('gatekeeper', e.target.value)}>
                      {!config.roles.some(r => r.name === draft.gatekeeper) && <option value={draft.gatekeeper}>{draft.gatekeeper} (built in)</option>}
                      {config.roles.map(r => (
                        <option key={`${r.scope}/${r.name}`} value={r.name}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="field">
                    <span className="field-label">&nbsp;</span>
                    <button className="btn small" onClick={() => onGatekeeper(scope, !!gk)}>
                      {gk ? 'Edit the gatekeeper role' : 'Make a gatekeeper role to change its model or rules'}
                    </button>
                  </div>
                </div>
              )}
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
          </div>
          <EditorFooter dirty={dirty} isNew={false} saving={busy} onSave={() => void save()} onRevert={revert} />
        </div>
      </div>
    </div>
  );
}
