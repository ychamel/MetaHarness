import type { Scope, SkillDef, SkillSource, SkillWhen } from '../types.ts';
import { Field, Markdown, Toggle } from '../components/common.tsx';
import { ListItem, Section, SetupLayout, type SetupProps } from './setup.tsx';

const WHEN: { id: SkillWhen; label: string; hint: string }[] = [
  { id: 'start', label: 'Listed at the start', hint: 'Named in the agent’s prompt with its description; the agent reads it when it fits.' },
  { id: 'path', label: 'Suggested when looking at files', hint: 'A note names the skill when a tool call touches matching paths. Once per session.' },
  { id: 'new-file', label: 'Suggested when creating a file', hint: 'A note names the skill when the agent creates a matching file. Once per session.' },
  { id: 'commit', label: 'Suggested when committing', hint: 'A note names the skill when a commit of the agent’s changes matching files.' },
];

const SOURCE: Record<SkillSource, string> = {
  'built-in': 'built-in',
  personal: 'personal',
  repo: 'repository',
  '.claude': 'repository · .claude',
  '.agents': 'repository · .agents',
};

const keyOf = (s: SkillDef) => s.name;

function size(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** Skills: guides with files that agents read through the skill tool, on every harness (design §18). */
export function Skills({ config, selected, onSelect, onSave }: SetupProps) {
  const skills = config?.skills ?? [];
  const current = skills.find(s => keyOf(s) === selected) ?? skills[0];
  const switchScope: Scope = current?.switchedBy ?? (config?.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal');
  const toggle = (on: boolean) => current && void onSave({ cmd: 'settings.save', scope: switchScope, patch: { skills: { [current.name]: on } } });

  return (
    <SetupLayout
      title="Skills"
      intro={
        <>
          Guides for particular kinds of work, each a folder with a <span className="mono">SKILL.md</span> and the files it uses. Agents on every harness read them with the <span className="mono">skill</span> tool: a summary first, then a section or file. Add one as a folder in <span className="mono">.metaharness/skills</span> (this repository) or <span className="mono">~/.metaharness/skills</span> (every project); the repository’s <span className="mono">.claude/skills</span> and <span className="mono">.agents/skills</span> count too. <span className="mono">when:</span>, <span className="mono">paths:</span>, <span className="mono">roles:</span> and <span className="mono">harness:</span> in its front matter say who gets it and when.
        </>
      }
      list={
        <>
          {WHEN.map(w => {
            const mine = skills.filter(s => s.when === w.id);
            if (!mine.length) return null;
            return (
              <div key={w.id}>
                <div className="list-group">{w.label}</div>
                {mine.map(s => (
                  <ListItem
                    key={keyOf(s)}
                    on={current ? keyOf(current) === keyOf(s) : false}
                    title={s.name}
                    extra={
                      <>
                        {!s.on && <span className="tag muted">off</span>}
                        <span className={`scope ${s.source.startsWith('.') ? 'repo' : s.source}`}>{SOURCE[s.source]}</span>
                      </>
                    }
                    onClick={() => onSelect(keyOf(s))}
                    sub={s.description && <span className="clamp-2">{s.description}</span>}
                  />
                ))}
              </div>
            );
          })}
          {!skills.length && <div className="empty">No skills yet. Agents get their role, the guidelines, the rules and their brief.</div>}
        </>
      }
      editor={
        !current ? (
          <div className="empty">Add a skill folder, and it shows here.</div>
        ) : (
          <div className="editor">
            <div className="editor-scroll">
              <div className="editor-title">
                <h2>{current.name}</h2>
                {current.overrides && <span className="hint">Replaces the {SOURCE[current.overrides]} skill of this name.</span>}
              </div>
              <Section title="On or off">
                <Toggle
                  checked={current.on}
                  onChange={toggle}
                  label={current.on ? 'Agents can read this skill' : 'Off: agents don’t see it'}
                  hint={`Saved in ${switchScope === 'repo' ? 'this repository’s' : 'your personal'} settings.json.`}
                />
              </Section>
              <Section title="What it's for">
                <div>{current.description || <span className="muted">No description. Agents decide from it whether to read the skill, so add one to its front matter.</span>}</div>
              </Section>
              <Section title="Who gets it, and when">
                <div>{WHEN.find(w => w.id === current.when)?.hint}</div>
                <div className="grid-2">
                  <Field label="For">
                    <span className="chips">{current.roles.map(r => <span key={r} className="chip ro">{r}</span>)}</span>
                  </Field>
                  <Field label="Harnesses">
                    <span className="chips">{current.harness.length ? current.harness.map(h => <span key={h} className="chip ro">{h}</span>) : <span className="muted">every harness</span>}</span>
                  </Field>
                  {current.when !== 'start' && (
                    <Field label="Paths">
                      <span className="chips">{current.paths.map(p => <span key={p} className="chip ro mono">{p}</span>)}</span>
                    </Field>
                  )}
                </div>
              </Section>
              <Section title="SKILL.md">
                <div className="preview">
                  <Markdown text={current.body} />
                </div>
              </Section>
              {current.files.length > 0 && (
                <Section title="Files">
                  <ul className="file-list mono small">
                    {current.files.map(f => (
                      <li key={f.path}>
                        {f.path} <span className="muted">({size(f.bytes)})</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              <div className="muted small mono file-path">{current.file}</div>
            </div>
          </div>
        )
      }
    />
  );
}
