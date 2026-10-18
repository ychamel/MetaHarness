import { useMemo, useState } from 'react';
import type { ConfigView, RoleDef, Scope } from '../types.ts';
import { ChipList, Field, Toggle, useConfirm } from '../components/common.tsx';
import { EditorFooter, keyOf, ListItem, ScopePicker, Section, SetupLayout, useDraft, useLeaveGuard, type SetupProps } from './setup.tsx';

const blank = (config?: ConfigView): RoleDef => ({
  name: '',
  scope: config?.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal',
  file: '',
  harness: config?.harnesses.find(h => h.runnable)?.id ?? 'claude-code',
  model: '',
  fallback: [],
  goodAt: '',
  instructions: '',
  helper: false,
  worktree: false,
  workflow: '',
  mcp: [],
  autoApprove: 'read-only',
  permissionMode: '',
  allow: [],
});

export function Roles({ config, selected, onSelect, onSave, onCommand }: SetupProps) {
  const roles = config?.roles ?? [];
  const isNew = selected === 'new' || selected?.startsWith('new:');
  const current = roles.find(r => keyOf(r) === selected) ?? (isNew ? undefined : roles[0]);
  const template = useMemo(() => {
    if (!isNew) return current ?? blank(config);
    const from = roles.find(r => `new:${keyOf(r)}` === selected);
    return from ? { ...from, name: `${from.name}-copy`, file: '' } : blank(config);
  }, [isNew, current, selected, roles, config]);
  const { draft, set, setDraft, dirty, revert } = useDraft<RoleDef>(template);
  const leave = useLeaveGuard(dirty);
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const go = async (key?: string) => (await leave()) && onSelect(key);

  const team = roles.filter(r => !r.helper);
  const helpers = roles.filter(r => r.helper);
  const item = (r: RoleDef) => (
    <ListItem
      key={keyOf(r)}
      on={!isNew && current ? keyOf(current) === keyOf(r) : false}
      title={r.name}
      scope={r.scope}
      onClick={() => void go(keyOf(r))}
      sub={
        <>
          <span className="mono">
            {r.harness} · {r.model || 'default model'}
          </span>
          {r.goodAt && <span className="clamp-2">{r.goodAt}</span>}
        </>
      }
    />
  );

  const save = async () => {
    setSaving(true);
    const prev = isNew ? undefined : current && { name: current.name, scope: current.scope };
    const next = await onSave({ cmd: 'role.save', ...draft, previous: prev });
    setSaving(false);
    if (next) onSelect(keyOf(draft));
  };

  return (
    <SetupLayout
      title="Roles"
      intro={
        <>
          The teammates a goal can use. Each runs on a harness and model you pick. Every agent reads the roles’ <i>good at</i> lines to decide whom to start, so make them specific. Saved changes apply to agents started from then on.
        </>
      }
      action={
        <button className="btn primary" onClick={() => void go('new')}>
          + New role
        </button>
      }
      list={
        <>
          <div className="list-group">Team roles</div>
          {team.map(item)}
          {helpers.length > 0 && <div className="list-group">Quick helpers</div>}
          {helpers.map(item)}
          {!roles.length && <div className="empty">No roles yet. Create one, or add files to .metaharness/roles/.</div>}
        </>
      }
      editor={
        !current && !isNew ? (
          <div className="empty">Pick a role, or create one.</div>
        ) : (
          <RoleForm
            key={selected ?? 'first'}
            config={config}
            draft={draft}
            set={set}
            isNew={!!isNew}
            original={isNew ? undefined : current}
            onCommand={onCommand}
            footer={
              <EditorFooter
                dirty={dirty}
                isNew={!!isNew}
                saving={saving}
                onSave={() => void save()}
                onRevert={() => (isNew ? void go(roles[0] && keyOf(roles[0])) : revert())}
                onDuplicate={() => current && void go(`new:${keyOf(current)}`)}
                onDelete={async () => {
                  if (!current) return;
                  if (await confirm({ title: `Delete the ${current.name} role?`, body: <>Its file goes: <span className="mono">{current.file}</span>. Agents already running keep going.</>, confirm: 'Delete', danger: true })) {
                    const next = await onSave({ cmd: 'role.delete', name: current.name, scope: current.scope });
                    if (next) {
                      setDraft(blank(config));
                      onSelect(undefined);
                    }
                  }
                }}
              />
            }
          />
        )
      }
    />
  );
}

function RoleForm({ config, draft, set, isNew, original, onCommand, footer }: { config?: ConfigView; draft: RoleDef; set: <K extends keyof RoleDef>(k: K, v: RoleDef[K]) => void; isNew: boolean; original?: RoleDef; onCommand: SetupProps['onCommand']; footer: React.ReactNode }) {
  const harnesses = config?.harnesses ?? [];
  const h = harnesses.find(x => x.id === draft.harness);
  const [loaded, setLoaded] = useState<Record<string, { models: string[]; error: string | null }>>({});
  const [loading, setLoading] = useState(false);
  const models = [...new Set([...(loaded[draft.harness]?.models ?? []), ...(h?.models ?? []), ...(config?.roles.filter(r => r.harness === draft.harness).map(r => r.model).filter(Boolean) ?? [])])];
  const backups = harnesses.flatMap(x => [...new Set([...(loaded[x.id]?.models ?? []), ...x.models, ...(config?.roles.filter(r => r.harness === x.id).map(r => r.model).filter(Boolean) ?? [])])].map(m => `${x.id}/${m}`));
  const loadModels = async () => {
    setLoading(true);
    const r = (await onCommand({ cmd: 'harness.models', harness: draft.harness, refresh: true })) as { models: string[]; error: string | null } | undefined;
    setLoading(false);
    if (r) setLoaded(l => ({ ...l, [draft.harness]: r }));
  };

  return (
    <div className="editor">
      <div className="editor-scroll">
        <div className="editor-title">
          <h2>{isNew ? 'New role' : draft.name || 'Role'}</h2>
          {original?.overrides && <span className="hint">A {original.overrides} role with this name exists; this one is used here.</span>}
        </div>

        <Section title="Who it is">
          <div className="grid-2">
            <Field label="Name" hint="Agents are named after it: implementer-1, implementer-2…">
              <input type="text" value={draft.name} onChange={e => set('name', e.target.value.replace(/\s+/g, '-'))} placeholder="e.g. tester" />
            </Field>
            <Field label="Saved in">
              <ScopePicker config={config} value={draft.scope} onChange={(s: Scope) => set('scope', s)} />
            </Field>
          </div>
          <Field label="Good at" hint="One line. Leads read it when they choose whom to start.">
            <textarea rows={2} value={draft.goodAt} onChange={e => set('goodAt', e.target.value.replace(/\n/g, ' '))} placeholder="e.g. writing focused tests for a change and finding edge cases" />
          </Field>
        </Section>

        <Section title="Runs on">
          <div className="grid-2">
            <Field label="Harness" hint={h && !h.runnable ? 'Not installed here: agents in this role use a backup.' : undefined}>
              <select value={draft.harness} onChange={e => set('harness', e.target.value)}>
                {!h && <option value={draft.harness}>{draft.harness}</option>}
                {harnesses.map(x => (
                  <option key={x.id} value={x.id}>
                    {x.title}
                    {x.runnable ? '' : ' (not installed)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Model"
              hint={
                <>
                  {loaded[draft.harness]?.error ? <span className="warn-text">{loaded[draft.harness]!.error} </span> : null}
                  <button className="link" onClick={() => void loadModels()} disabled={loading}>
                    {loading ? 'Asking the harness…' : `List ${h?.title ?? draft.harness}'s models`}
                  </button>
                </>
              }
            >
              <input type="text" list="role-models" value={draft.model} onChange={e => set('model', e.target.value)} placeholder="the harness's default" />
              <datalist id="role-models">
                {models.map(m => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="Backups, best first" hint="Used when the model isn't available here or its account is at its limit. harness/model, or just a model on the same harness.">
            <ChipList values={draft.fallback} onChange={v => set('fallback', v)} placeholder="e.g. codex/gpt-6-sol" suggestions={backups} />
          </Field>
        </Section>

        <Section title="Instructions" hint="Added to the team guidelines in its prompt.">
          <textarea className="instructions" rows={10} value={draft.instructions} onChange={e => set('instructions', e.target.value)} placeholder={'You review someone else\'s work. Read the design in the shared folder first.\nReport findings with file and line, how serious each one is, and a suggested fix.'} />
        </Section>

        <Section title="How it works">
          <Toggle checked={draft.helper} onChange={v => set('helper', v)} label="Quick helper" hint="Answers one question and hands the answer straight back (spawn with quick: true). Gets the short helper guidelines." />
          <Toggle checked={draft.worktree} onChange={v => set('worktree', v)} label="Its own worktree by default" hint="A git worktree and branch of its own, for work in parallel. Otherwise it works in your checkout with the team." />
          <Field label="Workflow it follows" hint="Goes into its prompt. A goal's lead gets the goal's workflow instead.">
            <select value={draft.workflow} onChange={e => set('workflow', e.target.value)}>
              <option value="">None</option>
              {config?.workflows.map(w => (
                <option key={w.name} value={w.name}>
                  {w.name}
                </option>
              ))}
              {draft.workflow && !config?.workflows.some(w => w.name === draft.workflow) && <option value={draft.workflow}>{draft.workflow} (missing)</option>}
            </select>
          </Field>
        </Section>

        <Section title="Permissions">
          <Toggle checked={draft.autoApprove === 'read-only'} onChange={v => set('autoApprove', v ? 'read-only' : 'none')} label="Run read-only shell commands without asking" hint="ls, cat, git log, grep and the like. Anything that writes still waits for you." />
          <Field label="Also allowed without asking" hint="Claude Code style patterns, e.g. Bash(npm test*). Press Enter after each.">
            <ChipList values={draft.allow} onChange={v => set('allow', v)} placeholder="Bash(npm test*)" suggestions={['Bash(npm test*)', 'Bash(node --test*)', 'Bash(git add*)', 'Bash(git commit*)', 'Bash(git merge*)', 'Bash(git diff*)']} />
          </Field>
          <details className="advanced">
            <summary>Advanced</summary>
            <Field label="Harness permission mode" hint="Passed to the harness as is, e.g. acceptEdits for Claude Code. Leave empty for its default.">
              <input type="text" value={draft.permissionMode} onChange={e => set('permissionMode', e.target.value)} />
            </Field>
          </details>
        </Section>

        <Section title="Tools" hint="MCP servers it can use besides MetaHarness's own, by name.">
          <ChipList values={draft.mcp} onChange={v => set('mcp', v)} placeholder="server name, e.g. blender" suggestions={config?.mcp.map(m => m.name) ?? []} />
          {draft.mcp.some(n => !config?.mcp.some(m => m.name === n)) && (
            <div className="hint">Names not defined under Tools are looked up in the harness's own MCP settings on each machine.</div>
          )}
        </Section>
        {!isNew && original && <div className="muted small mono file-path">{original.file}</div>}
      </div>
      {footer}
    </div>
  );
}
