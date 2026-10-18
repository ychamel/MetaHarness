import { useMemo, useState } from 'react';
import type { ConfigView, WorkflowDef } from '../types.ts';
import { Field, Markdown, useConfirm } from '../components/common.tsx';
import { EditorFooter, keyOf, ListItem, ScopePicker, Section, SetupLayout, useDraft, useLeaveGuard, type SetupProps } from './setup.tsx';

const blank = (config?: ConfigView): WorkflowDef => ({
  name: '',
  scope: config?.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal',
  file: '',
  goodAt: '',
  body: '1. \n2. \n3. ',
});

/** Workflows a workflow hands on to: names of other workflows it mentions in `backticks`. */
const chainsTo = (body: string, names: string[]) => [...new Set([...body.matchAll(/`([\w.-]+)`/g)].map(m => m[1]).filter(n => names.includes(n)))];

export function Workflows({ config, selected, onSelect, onSave, onStartWith }: SetupProps & { onStartWith: (workflow: string) => void }) {
  const workflows = config?.workflows ?? [];
  const names = workflows.map(w => w.name);
  const isNew = selected === 'new' || selected?.startsWith('new:');
  const current = workflows.find(w => keyOf(w) === selected) ?? (isNew ? undefined : workflows[0]);
  const template = useMemo(() => {
    if (!isNew) return current ?? blank(config);
    const from = workflows.find(w => `new:${keyOf(w)}` === selected);
    return from ? { ...from, name: `${from.name}-copy`, file: '' } : blank(config);
  }, [isNew, current, selected, workflows, config]);
  const { draft, set, dirty, revert } = useDraft<WorkflowDef>(template);
  const leave = useLeaveGuard(dirty);
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const go = async (key?: string) => (await leave()) && onSelect(key);
  const roles = config?.roles.filter(r => r.workflow === draft.name) ?? [];
  const chains = chainsTo(draft.body, names.filter(n => n !== draft.name));
  const from = workflows.filter(w => w.name !== draft.name && chainsTo(w.body, [draft.name]).length);

  const save = async () => {
    setSaving(true);
    const next = await onSave({ cmd: 'workflow.save', ...draft, previous: isNew || !current ? undefined : { name: current.name, scope: current.scope } });
    setSaving(false);
    if (next) onSelect(keyOf(draft));
  };

  return (
    <SetupLayout
      title="Workflows"
      intro={<>How to run one kind of task, step by step. A goal’s lead follows one; when you don’t pick, it reads each workflow’s <i>good at</i> line and chooses. A workflow can hand on to another by naming it.</>}
      action={
        <button className="btn primary" onClick={() => void go('new')}>
          + New workflow
        </button>
      }
      list={
        <>
          {workflows.map(w => (
            <ListItem key={keyOf(w)} on={!isNew && current ? keyOf(current) === keyOf(w) : false} title={w.name} scope={w.scope} onClick={() => void go(keyOf(w))} sub={w.goodAt && <span className="clamp-2">{w.goodAt}</span>} />
          ))}
          {!workflows.length && <div className="empty">No workflows yet. Leads then plan on their own.</div>}
        </>
      }
      editor={
        !current && !isNew ? (
          <div className="empty">Pick a workflow, or create one.</div>
        ) : (
          <div className="editor">
            <div className="editor-scroll">
              <div className="editor-title">
                <h2>{isNew ? 'New workflow' : draft.name}</h2>
                {!isNew && !dirty && (
                  <button className="btn small" onClick={() => onStartWith(draft.name)}>
                    Start a goal with it
                  </button>
                )}
              </div>
              <Section title="What it's for">
                <div className="grid-2">
                  <Field label="Name">
                    <input type="text" value={draft.name} onChange={e => set('name', e.target.value.replace(/\s+/g, '-'))} placeholder="e.g. bugfix" />
                  </Field>
                  <Field label="Saved in">
                    <ScopePicker config={config} value={draft.scope} onChange={s => set('scope', s)} />
                  </Field>
                </div>
                <Field label="Good at" hint="One line. The lead reads it when it picks a workflow.">
                  <textarea rows={2} value={draft.goodAt} onChange={e => set('goodAt', e.target.value.replace(/\n/g, ' '))} placeholder="e.g. a bug with a clear reproduction: find the cause, fix it, add a test" />
                </Field>
              </Section>
              <Section
                title="Steps"
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
                  <textarea className="instructions" rows={14} value={draft.body} onChange={e => set('body', e.target.value)} />
                )}
                <div className="hint">
                  Write it for the lead. To ask you to approve something: “send to human with <code>decision: true</code>, then <code>wait</code>”. To hand on: “Continue with the <code>implementation</code> workflow”.
                </div>
              </Section>
              {(chains.length > 0 || from.length > 0 || roles.length > 0) && (
                <Section title="Connections">
                  <dl className="kv">
                    {chains.length > 0 && (
                      <>
                        <dt>Hands on to</dt>
                        <dd>{chains.map(c => <button key={c} className="tag" onClick={() => { const w = workflows.find(x => x.name === c); if (w) void go(keyOf(w)); }}>{c}</button>)}</dd>
                      </>
                    )}
                    {from.length > 0 && (
                      <>
                        <dt>Comes after</dt>
                        <dd>{from.map(w => <button key={w.name} className="tag" onClick={() => void go(keyOf(w))}>{w.name}</button>)}</dd>
                      </>
                    )}
                    {roles.length > 0 && (
                      <>
                        <dt>Roles that follow it</dt>
                        <dd>{roles.map(r => <span key={r.name} className="tag">{r.name}</span>)}</dd>
                      </>
                    )}
                  </dl>
                </Section>
              )}
              {!isNew && current && <div className="muted small mono file-path">{current.file}</div>}
            </div>
            <EditorFooter
              dirty={dirty}
              isNew={!!isNew}
              saving={saving}
              onSave={() => void save()}
              onRevert={() => (isNew ? void go(workflows[0] && keyOf(workflows[0])) : revert())}
              onDuplicate={() => current && void go(`new:${keyOf(current)}`)}
              onDelete={async () => {
                if (!current) return;
                if (await confirm({ title: `Delete the ${current.name} workflow?`, body: <>Its file goes: <span className="mono">{current.file}</span>.{roles.length ? ` ${roles.map(r => r.name).join(', ')} still name${roles.length === 1 ? 's' : ''} it.` : ''}</>, confirm: 'Delete', danger: true })) {
                  if (await onSave({ cmd: 'workflow.delete', name: current.name, scope: current.scope })) onSelect(undefined);
                }
              }}
            />
          </div>
        )
      }
    />
  );
}
