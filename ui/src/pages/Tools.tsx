import { useMemo, useState } from 'react';
import type { ConfigView, McpDef, Scope } from '../types.ts';
import { Field, useConfirm } from '../components/common.tsx';
import { EditorFooter, keyOf, ListItem, ScopePicker, Section, SetupLayout, useDraft, useLeaveGuard, type SetupProps } from './setup.tsx';
import { SkillDetail, SkillItem, skillKey } from './Skills.tsx';

/** A server as the form edits it: lists and maps as lines of text. */
interface Draft {
  name: string;
  scope: Scope;
  kind: 'command' | 'url';
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

const toDraft = (name: string, scope: Scope, d: McpDef): Draft => ({
  name,
  scope,
  kind: d.url && !d.command ? 'url' : 'command',
  command: d.command ?? '',
  args: (d.args ?? []).join('\n'),
  env: Object.entries(d.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
  url: d.url ?? '',
  headers: Object.entries(d.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
});

const pairs = (text: string, sep: RegExp) =>
  Object.fromEntries(
    text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const m = sep.exec(l);
        return m ? [l.slice(0, m.index).trim(), l.slice(m.index + m[0].length).trim()] : [l, ''];
      }),
  );

function toDef(d: Draft): McpDef {
  if (d.kind === 'url') {
    const headers = pairs(d.headers, /:\s*/);
    return { url: d.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) };
  }
  const args = d.args.split('\n').map(a => a.trim()).filter(Boolean);
  const env = pairs(d.env, /=/);
  return { command: d.command.trim(), ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
}

/**
 * What roles carry besides MetaHarness's own tools: MCP servers they name under Tools (mcp.json in
 * each config folder), and skills they name under Skills (read-only here).
 */
export function Tools({ config, selected, onSelect, onSave }: SetupProps) {
  const servers = useMemo(() => config?.mcp ?? [], [config]);
  const skills = config?.skills ?? [];
  const isNew = selected === 'new';
  const skill = skills.find(k => skillKey(k) === selected) ?? (!selected && !servers.length ? skills[0] : undefined);
  const current = servers.find(s => keyOf(s) === selected) ?? (isNew || skill ? undefined : servers[0]);
  const scope0: Scope = config?.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal';
  const template = useMemo(() => (current && !isNew ? toDraft(current.name, current.scope, current.def) : toDraft('', scope0, { command: '' })), [current, isNew, scope0]);
  const { draft, set, dirty, revert } = useDraft<Draft>(template);
  const leave = useLeaveGuard(dirty);
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const go = async (key?: string) => (await leave()) && onSelect(key);
  const usedBy = config?.roles.filter(r => r.mcp.includes(draft.name)) ?? [];

  const save = async () => {
    setSaving(true);
    const next = await onSave({ cmd: 'mcp.save', name: draft.name, scope: draft.scope, def: toDef(draft), previous: current && !isNew ? { name: current.name, scope: current.scope } : undefined });
    // A server moved to the other folder leaves the old one's mcp.json.
    if (next && current && !isNew && current.scope !== draft.scope) await onSave({ cmd: 'mcp.save', name: current.name, scope: current.scope, def: null });
    setSaving(false);
    if (next) onSelect(`${draft.scope}/${draft.name}`);
  };

  return (
    <SetupLayout
      title="Tools & skills"
      intro={
        <>
          What roles carry besides MetaHarness’s own tools. <b>MCP servers</b>, such as Blender or a browser: a role names them under <i>Tools</i>, and a name that isn’t defined here is looked up in the harness’s own settings. <b>Skills</b>, guides with files that agents read when they decide they need one: folders with a <span className="mono">SKILL.md</span> in <span className="mono">.metaharness/skills</span>, <span className="mono">~/.metaharness/skills</span>, or the repository’s <span className="mono">.claude/skills</span> and <span className="mono">.agents/skills</span>. A role names the skills it carries under <i>Skills</i>; one no role names goes to every role.
        </>
      }
      action={
        <button className="btn primary" onClick={() => void go('new')}>
          + New server
        </button>
      }
      list={
        <>
          <div className="list-group">MCP servers</div>
          {servers.map(s => (
            <ListItem
              key={keyOf(s)}
              on={!isNew && current ? keyOf(current) === keyOf(s) : false}
              title={s.name}
              scope={s.scope}
              onClick={() => void go(keyOf(s))}
              sub={<span className="mono clamp-2">{s.def.url ?? [s.def.command, ...(s.def.args ?? [])].join(' ')}</span>}
            />
          ))}
          {!servers.length && <div className="empty">No servers defined. Roles can still name servers their harness already has.</div>}
          <div className="list-group">Skills</div>
          {skills.map(k => (
            <SkillItem key={skillKey(k)} skill={k} on={skill ? skillKey(skill) === skillKey(k) : false} onClick={() => void go(skillKey(k))} />
          ))}
          {!skills.length && <div className="empty">No skills yet. Add a folder with a SKILL.md to one of the skills folders.</div>}
        </>
      }
      editor={
        skill ? (
          <SkillDetail skill={skill} scopes={config?.scopes ?? []} onSave={onSave} />
        ) : !current && !isNew ? (
          <div className="empty">Pick a server, or add one.</div>
        ) : (
          <div className="editor">
            <div className="editor-scroll">
              <div className="editor-title">
                <h2>{isNew ? 'New server' : draft.name}</h2>
              </div>
              <Section title="Server">
                <div className="grid-2">
                  <Field label="Name" hint="What roles write under Tools.">
                    <input type="text" value={draft.name} onChange={e => set('name', e.target.value.replace(/\s+/g, '-'))} placeholder="e.g. blender" />
                  </Field>
                  <Field label="Saved in">
                    <ScopePicker config={config} value={draft.scope} onChange={s => set('scope', s)} />
                  </Field>
                </div>
                <div className="segmented">
                  <button className={draft.kind === 'command' ? 'on' : ''} onClick={() => set('kind', 'command')}>
                    Runs a command
                  </button>
                  <button className={draft.kind === 'url' ? 'on' : ''} onClick={() => set('kind', 'url')}>
                    At a URL
                  </button>
                </div>
                {draft.kind === 'command' ? (
                  <>
                    <Field label="Command">
                      <input type="text" className="mono" value={draft.command} onChange={e => set('command', e.target.value)} placeholder="uvx" />
                    </Field>
                    <Field label="Arguments" hint="One per line.">
                      <textarea className="mono" rows={3} value={draft.args} onChange={e => set('args', e.target.value)} placeholder="blender-mcp" />
                    </Field>
                    <Field label="Environment" hint="KEY=value, one per line.">
                      <textarea className="mono" rows={3} value={draft.env} onChange={e => set('env', e.target.value)} />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="URL">
                      <input type="text" className="mono" value={draft.url} onChange={e => set('url', e.target.value)} placeholder="http://localhost:9876/mcp" />
                    </Field>
                    <Field label="Headers" hint="Name: value, one per line.">
                      <textarea className="mono" rows={3} value={draft.headers} onChange={e => set('headers', e.target.value)} />
                    </Field>
                  </>
                )}
              </Section>
              {usedBy.length > 0 && (
                <Section title="Used by">
                  <div>{usedBy.map(r => <span key={r.name} className="tag">{r.name}</span>)}</div>
                </Section>
              )}
            </div>
            <EditorFooter
              dirty={dirty}
              isNew={isNew}
              saving={saving}
              onSave={() => void save()}
              onRevert={() => (isNew ? void go(servers[0] && keyOf(servers[0])) : revert())}
              onDelete={async () => {
                if (!current) return;
                if (await confirm({ title: `Remove ${current.name}?`, body: usedBy.length ? `${usedBy.map(r => r.name).join(', ')} still name${usedBy.length === 1 ? 's' : ''} it; the harness's own server of that name is used then, if there is one.` : 'It comes out of mcp.json.', confirm: 'Remove', danger: true }))
                  if (await onSave({ cmd: 'mcp.save', name: current.name, scope: current.scope, def: null })) onSelect(undefined);
              }}
            />
          </div>
        )
      }
    />
  );
}
