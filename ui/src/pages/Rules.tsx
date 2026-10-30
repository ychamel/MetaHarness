import { useMemo, useState } from 'react';
import type { ChangeKind, ConfigView, RuleDef, RuleWhen, Scope } from '../types.ts';
import { ChipList, Field, Markdown, Toggle, useConfirm } from '../components/common.tsx';
import { EditorFooter, keyOf, ListItem, ScopePicker, Section, SetupLayout, useDraft, useLeaveGuard, type SetupProps } from './setup.tsx';

const WHEN: { id: RuleWhen; label: string; hint: string }[] = [
  { id: 'start', label: 'At the start', hint: 'In the agent’s prompt, from its first turn (and again in a fresh session).' },
  { id: 'path', label: 'Looking at files', hint: 'When a tool call names a path in the repository: a read, a search, a listing, a command.' },
  { id: 'new-file', label: 'Creating a file', hint: 'When the agent writes a file that didn’t exist. Once per session.' },
  { id: 'commit', label: 'Committing', hint: 'When a commit of the agent’s (not a merge) changes matching files.' },
  { id: 'done', label: 'Calling done', hint: 'The first done comes back with this text; the next one goes through.' },
];
const CHANGES: ChangeKind[] = ['added', 'modified', 'deleted', 'renamed'];

const blank = (config?: ConfigView): RuleDef => ({
  name: '',
  scope: config?.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal',
  file: '',
  when: 'start',
  description: '',
  body: '',
  roles: ['all'],
  paths: ['**'],
  changes: [...CHANGES],
  edited: false,
  on: true,
  fileOff: false,
});

/** Rules: notes MetaHarness hands agents at moments it can see (design §18). */
export function Rules({ config, selected, onSelect, onSave }: SetupProps) {
  const rules = config?.rules ?? [];
  const isNew = selected === 'new' || selected?.startsWith('new:');
  const current = rules.find(r => keyOf(r) === selected) ?? (isNew ? undefined : rules[0]);
  const builtIn = !isNew && current?.scope === 'built-in';
  const template = useMemo(() => {
    if (!isNew) return current ? (current.scope === 'built-in' ? { ...current, scope: blank(config).scope } : current) : blank(config);
    const from = rules.find(r => `new:${keyOf(r)}` === selected);
    return from ? { ...from, name: `${from.name}-copy`, file: '', scope: blank(config).scope } : blank(config);
  }, [isNew, current, selected, rules, config]);
  const { draft, set, dirty, revert } = useDraft<RuleDef>(template);
  const leave = useLeaveGuard(dirty);
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const go = async (key?: string) => (await leave()) && onSelect(key);
  const roleNames = ['all', 'team', 'helpers', 'lead', ...(config?.roles.map(r => r.name) ?? [])];
  const switchScope: Scope = current?.switchedBy ?? (config?.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal');

  const save = async () => {
    setSaving(true);
    const next = await onSave({ cmd: 'rule.save', ...draft, previous: isNew || !current || builtIn ? undefined : { name: current.name, scope: current.scope } });
    setSaving(false);
    if (next) onSelect(keyOf(draft));
  };
  const toggle = (on: boolean) => current && void onSave({ cmd: 'settings.save', scope: switchScope, patch: { rules: { [current.name]: on } } });

  return (
    <SetupLayout
      title="Rules"
      intro={
        <>
          Short notes MetaHarness hands agents at moments it can see: when they start, look at files, create one, commit, or call done. The built-in ones keep code clean and mapped. Turn any of them off, change them, or add your own.
        </>
      }
      action={
        <button className="btn primary" onClick={() => void go('new')}>
          + New rule
        </button>
      }
      list={
        <>
          {WHEN.map(w => {
            const mine = rules.filter(r => r.when === w.id);
            if (!mine.length) return null;
            return (
              <div key={w.id}>
                <div className="list-group">{w.label}</div>
                {mine.map(r => (
                  <ListItem
                    key={keyOf(r)}
                    on={!isNew && current ? keyOf(current) === keyOf(r) : false}
                    title={r.name}
                    scope={r.scope}
                    extra={!r.on && <span className="tag muted">off</span>}
                    onClick={() => void go(keyOf(r))}
                    sub={r.description && <span className="clamp-2">{r.description}</span>}
                  />
                ))}
              </div>
            );
          })}
          {!rules.length && <div className="empty">No rules. Agents get their role, the guidelines and their brief.</div>}
        </>
      }
      editor={
        !current && !isNew ? (
          <div className="empty">Pick a rule, or create one.</div>
        ) : (
          <div className="editor">
            <div className="editor-scroll">
              <div className="editor-title">
                <h2>{isNew ? 'New rule' : draft.name}</h2>
                {current?.overrides && !isNew && <span className="hint">Replaces the {current.overrides} rule of this name.</span>}
              </div>
              {!isNew && current && (
                <Section title="On or off">
                  <Toggle
                    checked={current.on}
                    onChange={toggle}
                    label={current.on ? 'Agents get this rule' : 'Off: agents don’t get it'}
                    hint={`Saved in ${switchScope === 'repo' ? 'this project’s' : 'your personal'} settings.json${current.fileOff ? '. Its file also says off: true.' : '.'}`}
                  />
                </Section>
              )}
              <Section title="What it's for">
                {builtIn && <div className="hint">Built into MetaHarness. Saving writes a copy into the folder you pick, which replaces it there.</div>}
                <div className="grid-2">
                  <Field label="Name">
                    <input type="text" value={draft.name} onChange={e => set('name', e.target.value.replace(/\s+/g, '-'))} placeholder="e.g. api-style" />
                  </Field>
                  <Field label="Saved in">
                    <ScopePicker config={config} value={draft.scope === 'built-in' ? 'repo' : draft.scope} onChange={s => set('scope', s)} />
                  </Field>
                </div>
                <Field label="Description" hint="One line. Agents see it in their prompt, so they know the note will come and why.">
                  <input type="text" value={draft.description} onChange={e => set('description', e.target.value)} placeholder="e.g. how handlers in src/api are written" />
                </Field>
              </Section>
              <Section title="When">
                <div className="segmented wrap" role="radiogroup" aria-label="When">
                  {WHEN.map(w => (
                    <button key={w.id} role="radio" aria-checked={draft.when === w.id} className={draft.when === w.id ? 'on' : ''} onClick={() => set('when', w.id)}>
                      {w.label}
                    </button>
                  ))}
                </div>
                <div className="hint">{WHEN.find(w => w.id === draft.when)?.hint}</div>
                <Field label="For" hint="all, team (not quick helpers), helpers, lead, or role names. !name leaves one out.">
                  <ChipList values={draft.roles} onChange={v => set('roles', v.length ? v : ['all'])} placeholder="e.g. implementer" suggestions={roleNames} />
                </Field>
                {(draft.when === 'path' || draft.when === 'new-file' || draft.when === 'commit') && (
                  <Field label="Paths" hint="Globs in the repository: ** any depth, * within a folder. !glob leaves some out.">
                    <ChipList values={draft.paths} onChange={v => set('paths', v.length ? v : ['**'])} placeholder="e.g. src/api/**" suggestions={['**', 'src/**', '!**/*.test.*']} />
                  </Field>
                )}
                {draft.when === 'commit' && (
                  <>
                    <Field label="Changes that count">
                      <span className="chips">
                        {CHANGES.map(c => (
                          <label key={c} className="check">
                            <input type="checkbox" checked={draft.changes.includes(c)} onChange={e => set('changes', e.target.checked ? [...draft.changes, c] : draft.changes.filter(x => x !== c))} /> {c}
                          </label>
                        ))}
                      </span>
                    </Field>
                    <Field label="Unless the commit also changes" hint="e.g. ARCHITECTURE.md: then the note isn’t needed.">
                      <input type="text" value={draft.unlessChanged ?? ''} onChange={e => set('unlessChanged', e.target.value || undefined)} placeholder="a file in the repository" />
                    </Field>
                  </>
                )}
                {draft.when === 'done' && <Toggle checked={draft.edited} onChange={v => set('edited', v)} label="Only for agents that changed files" hint="Reviewers and reporters that only read finish without it." />}
              </Section>
              <Section title="Points at a skill" hint="Optional. The note then names the skill and what it’s for, so the agent reads it when it fits.">
                <select value={draft.skill ?? ''} onChange={e => set('skill', e.target.value || undefined)}>
                  <option value="">No skill</option>
                  {config?.skills.map(k => (
                    <option key={k.name} value={k.name}>
                      {k.name}: {k.description.slice(0, 80)}
                    </option>
                  ))}
                  {draft.skill && !config?.skills.some(k => k.name === draft.skill) && <option value={draft.skill}>{draft.skill} (missing)</option>}
                </select>
                {draft.skill && <div className="hint">Only agents whose role carries {draft.skill} get this rule.</div>}
              </Section>
              <Section
                title="What the agent reads"
                hint={
                  <span className="segmented small">
                    <button className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>
                      Edit
                    </button>
                    <button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
                      Preview
                    </button>
                  </span>
                }
              >
                {preview ? (
                  <div className="preview">
                    <Markdown text={draft.body} />
                  </div>
                ) : (
                  <textarea className="instructions" rows={10} value={draft.body} onChange={e => set('body', e.target.value)} placeholder={'Handlers in src/api take a request and return a response; they never touch the database directly.'} />
                )}
                <div className="hint">
                  {draft.body.length > 1500
                    ? 'This is long for a note that arrives mid-work. A guide this size makes a better skill (a folder with a SKILL.md): agents read it when they need it, and this rule can point at it.'
                    : draft.skill
                      ? 'Optional with a skill: anything to say before pointing at it.'
                      : 'Keep it short: it arrives in the middle of the agent’s work. Point to files for anything long.'}
                </div>
              </Section>
              <details className="advanced" open={!!(draft.sections || draft.include || draft.requires || draft.missing)}>
                <summary>Files it uses</summary>
                <div className="grid-2">
                  {draft.when === 'path' && (
                    <Field label="Sections from" hint="A repository file, e.g. ARCHITECTURE.md: its sections whose heading is a path come along.">
                      <input type="text" value={draft.sections ?? ''} onChange={e => set('sections', e.target.value || undefined)} placeholder="ARCHITECTURE.md" />
                    </Field>
                  )}
                  <Field label="Include" hint="A repository file whose text follows the rule's, when it exists.">
                    <input type="text" value={draft.include ?? ''} onChange={e => set('include', e.target.value || undefined)} placeholder="CONVENTIONS.md" />
                  </Field>
                  <Field label="Only if this file exists">
                    <input type="text" value={draft.requires ?? ''} onChange={e => set('requires', e.target.value || undefined)} placeholder="ARCHITECTURE.md" />
                  </Field>
                  <Field label="Only if this file is missing">
                    <input type="text" value={draft.missing ?? ''} onChange={e => set('missing', e.target.value || undefined)} />
                  </Field>
                </div>
              </details>
              {!isNew && current && <div className="muted small mono file-path">{current.file}</div>}
            </div>
            <EditorFooter
              dirty={dirty}
              isNew={!!isNew}
              saving={saving}
              onSave={() => void save()}
              onRevert={() => (isNew ? void go(rules[0] && keyOf(rules[0])) : revert())}
              onDuplicate={() => current && void go(`new:${keyOf(current)}`)}
              onDelete={
                builtIn || !current
                  ? undefined
                  : async () => {
                      const back = current.overrides ? ` The ${current.overrides} rule of this name applies again.` : '';
                      if (await confirm({ title: `Delete the ${current.name} rule?`, body: <>Its file goes: <span className="mono">{current.file}</span>.{back}</>, confirm: 'Delete', danger: true })) {
                        if (await onSave({ cmd: 'rule.delete', name: current.name, scope: current.scope })) onSelect(undefined);
                      }
                    }
              }
            />
          </div>
        )
      }
    />
  );
}
