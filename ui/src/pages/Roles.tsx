import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { modelLabel } from '../format.ts';
import type { ConfigView, RoleDef, Scope } from '../types.ts';
import { ChipList, Field, Toggle, useConfirm } from '../components/common.tsx';
import { EditorFooter, keyOf, ListItem, ScopePicker, Section, SetupLayout, useDraft, useLeaveGuard, type SetupProps } from './setup.tsx';

const blank = (config?: ConfigView): RoleDef => ({
  name: '',
  scope: config?.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal',
  file: '',
  harness: config?.harnesses.find(h => h.runnable)?.id ?? 'claude-code',
  model: '',
  effort: '',
  fallback: [],
  goodAt: '',
  instructions: '',
  helper: false,
  worktree: false,
  workflow: '',
  mcp: [],
  skills: [],
  autoApprove: 'read-only',
  approvals: '',
  permissionMode: '',
  allow: [],
  nativeSkills: false,
});

export function Roles({ config, selected, onSelect, onSave, onCommand }: SetupProps) {
  const roles = config?.roles ?? [];
  const isNew = selected === 'new' || selected?.startsWith('new:');
  const current = roles.find(r => keyOf(r) === selected) ?? (isNew ? undefined : roles[0]);
  const builtIn = !isNew && current?.scope === 'built-in';
  const template = useMemo(() => {
    // A built-in role (the cartographer) is edited as a copy for one of the folders.
    if (!isNew) return current ? (current.scope === 'built-in' ? { ...current, scope: blank(config).scope } : current) : blank(config);
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
            {r.harness} · {modelLabel(r)}
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
                onDelete={builtIn ? undefined : async () => {
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

interface ModelList {
  loading: boolean;
  models: string[];
  /** The efforts each model takes, and those any model takes when the harness has one set. */
  efforts: Record<string, string[]>;
  anyEffort?: string[];
  /** Names that fold a model and its effort together (Antigravity's gemini-3.8-flash-high). */
  variants: Record<string, { model: string; effort: string }>;
  error: string | null;
}

type Models = Omit<ModelList, 'loading'>;
const noModels = (l?: ModelList): Models => ({ models: l?.models ?? [], efforts: l?.efforts ?? {}, anyEffort: l?.anyEffort, variants: l?.variants ?? {}, error: null });

/** The "Other…" entry of the model picker: a model ID typed by hand. */
const OTHER = '\u0000other';

/**
 * The models each installed harness offers, asked once while the editor is open (the daemon keeps
 * a list for ten minutes; refresh asks the CLI again).
 */
function useModelLists(config?: ConfigView) {
  const [lists, setLists] = useState<Record<string, ModelList>>({});
  const asked = useRef(new Set<string>());
  const load = useCallback(async (harness: string, refresh = false) => {
    asked.current.add(harness);
    setLists(l => ({ ...l, [harness]: { ...noModels(l[harness]), loading: true } }));
    try {
      const r = await api.command<Models>({ cmd: 'harness.models', harness, refresh });
      setLists(l => ({ ...l, [harness]: { ...noModels(), ...r, efforts: r.efforts ?? {}, variants: r.variants ?? {}, error: r.error ?? null, loading: false } }));
    } catch (e) {
      setLists(l => ({ ...l, [harness]: { ...noModels(l[harness]), error: (e as Error).message, loading: false } }));
    }
  }, []);
  useEffect(() => {
    for (const h of config?.harnesses ?? []) if (h.runnable && !asked.current.has(h.id)) void load(h.id);
  }, [config?.harnesses, load]);
  /** Listed by the harness, known to its profile, or already used by a role. */
  const modelsOf = (harness: string) => [
    ...new Set([...(lists[harness]?.models ?? []), ...(config?.harnesses.find(x => x.id === harness)?.models ?? []), ...(config?.roles.filter(r => r.harness === harness).map(r => r.model).filter(Boolean) ?? [])]),
  ];
  return { lists, load, modelsOf };
}

function RoleForm({ config, draft, set, isNew, original, footer }: { config?: ConfigView; draft: RoleDef; set: <K extends keyof RoleDef>(k: K, v: RoleDef[K]) => void; isNew: boolean; original?: RoleDef; onCommand: SetupProps['onCommand']; footer: React.ReactNode }) {
  const harnesses = config?.harnesses ?? [];
  const h = harnesses.find(x => x.id === draft.harness);
  const { lists, load, modelsOf } = useModelLists(config);
  const list = lists[draft.harness];
  // A harness that can't run here still has its profile's models and efforts.
  useEffect(() => {
    if (!list && draft.harness) void load(draft.harness);
  }, [list, draft.harness, load]);
  // A name with its effort folded in (an older role on Antigravity) shows as the model and its effort.
  const variant = list?.variants[draft.model];
  const model = variant?.model ?? draft.model;
  const effort = draft.effort || variant?.effort || '';
  const models = modelsOf(draft.harness).filter(m => !list?.variants[m]);
  const efforts = list?.efforts[model] ?? list?.anyEffort ?? (list && !list.error ? [] : ['low', 'medium', 'high']);
  const [typing, setTyping] = useState(false);
  const listed = !model || models.includes(model);
  const setModel = (m: string) => {
    set('model', m);
    if (variant && !draft.effort) set('effort', variant.effort);
  };
  const backups = harnesses.flatMap(x => modelsOf(x.id).map(m => `${x.id}/${m}`));

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
              <ScopePicker config={config} value={draft.scope === 'built-in' ? 'repo' : draft.scope} onChange={(s: Scope) => set('scope', s)} />
            </Field>
          </div>
          <Field label="Good at" hint="One line. Leads read it when they choose whom to start.">
            <textarea rows={2} value={draft.goodAt} onChange={e => set('goodAt', e.target.value.replace(/\n/g, ' '))} placeholder="e.g. writing focused tests for a change and finding edge cases" />
          </Field>
        </Section>

        <Section title="Runs on">
          <div className="grid-2">
            <Field label="Harness" hint={h && !h.runnable ? 'Not installed here: agents in this role use a backup.' : undefined}>
              <select
                value={draft.harness}
                onChange={e => {
                  // A model belongs to its harness: the new one starts from its default.
                  set('harness', e.target.value);
                  set('model', '');
                  setTyping(false);
                }}
              >
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
                list?.loading ? (
                  `Asking ${h?.title ?? draft.harness} for its models…`
                ) : (
                  <>
                    {list?.error ? <span className="warn-text">{list.error} </span> : list ? `${list.models.length} listed by ${h?.title ?? draft.harness}. ` : null}
                    {h?.runnable && (
                      <button className="link" onClick={e => (e.preventDefault(), void load(draft.harness, true))}>
                        {list ? 'Ask again' : `List ${h.title}'s models`}
                      </button>
                    )}
                  </>
                )
              }
            >
              <select
                value={typing ? OTHER : model}
                onChange={e => {
                  setTyping(e.target.value === OTHER);
                  if (e.target.value !== OTHER) setModel(e.target.value);
                }}
              >
                <option value="">The harness's default</option>
                {models.map(m => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {!listed && (
                  <option value={model}>
                    {model}
                    {list && !list.loading && !list.error ? ' (not listed)' : ''}
                  </option>
                )}
                <option value={OTHER}>Other…</option>
              </select>
              {typing && <input type="text" autoFocus value={draft.model} onChange={e => set('model', e.target.value.trim())} placeholder="model ID, as the harness names it" />}
            </Field>
            <Field label="Effort" hint={efforts.length ? 'How hard it thinks. Set apart from the model, so one price covers every effort.' : `${h?.title ?? draft.harness} doesn't list efforts for this model.`}>
              <select
                value={effort}
                onChange={e => {
                  set('effort', e.target.value);
                  if (variant) set('model', variant.model);
                }}
              >
                <option value="">The harness's default</option>
                {efforts.map(x => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
                {effort && !efforts.includes(effort) && <option value={effort}>{effort} (the nearest level is used)</option>}
              </select>
            </Field>
          </div>
          <Field label="Backups, best first" hint="Used when the model isn't available here or its account is at its limit. harness/model, or just a model on the same harness. They run at the role's effort; add @low, @high… for one of their own.">
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
          <Field label="Who approves the rest" hint={`The settings say: ${config?.settings.effective.approvals ?? 'gatekeeper'}.`}>
            <select value={draft.approvals} onChange={e => set('approvals', e.target.value)}>
              <option value="">As in Settings</option>
              <option value="ask">Ask me</option>
              <option value="gatekeeper">The gatekeeper, then me</option>
              <option value="harness">The harness’s own, then the gatekeeper</option>
            </select>
          </Field>
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

        <Section title="Skills" hint="Guides it carries and reads when they fit, by name. A skill no role names goes to every role.">
          <ChipList values={draft.skills ?? []} onChange={v => set('skills', v)} placeholder="skill name, e.g. pdf-forms" suggestions={config?.skills.map(k => k.name) ?? []} />
          {(draft.skills ?? []).some(n => !config?.skills.some(k => k.name === n)) && (
            <div className="hint">Some of these names aren’t skills here: {(draft.skills ?? []).filter(n => !config?.skills.some(k => k.name === n)).join(', ')}.</div>
          )}
          <Toggle checked={!!draft.nativeSkills} onChange={v => set('nativeSkills', v)} label="Keep the harness’s own skills" hint="Your personal skills for this harness, and the repository’s in its own folder, as the harness loads them. Off: hidden, so every harness on the team has the same skills." />
        </Section>
        {!isNew && original && <div className="muted small mono file-path">{original.file}</div>}
      </div>
      {footer}
    </div>
  );
}
