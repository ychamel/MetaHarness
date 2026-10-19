import type { Scope, SkillDef, SkillSource } from '../types.ts';
import { Field, Markdown, Toggle } from '../components/common.tsx';
import { ListItem, Section } from './setup.tsx';

/**
 * Skills in the Tools & skills library (design §18): guides with files that agents read through
 * the skill tool. Read-only here: a skill is a folder written in an editor. Roles say which ones
 * they carry; rules can point at one.
 */

const SOURCE: Record<SkillSource, string> = {
  'built-in': 'built-in',
  personal: 'personal',
  repo: 'repository',
  '.claude': 'repository · .claude',
  '.agents': 'repository · .agents',
};

/** A skill's key in the address, apart from servers' scope/name. */
export const skillKey = (s: SkillDef) => `skill/${s.name}`;

function size(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function SkillItem({ skill, on, onClick }: { skill: SkillDef; on: boolean; onClick: () => void }) {
  return (
    <ListItem
      on={on}
      title={skill.name}
      extra={
        <>
          {!skill.on && <span className="tag muted">off</span>}
          <span className={`scope ${skill.source.startsWith('.') ? 'repo' : skill.source}`}>{SOURCE[skill.source]}</span>
        </>
      }
      onClick={onClick}
      sub={skill.description && <span className="clamp-2">{skill.description}</span>}
    />
  );
}

export function SkillDetail({ skill, scopes, onSave }: { skill: SkillDef; scopes: { scope: Scope }[]; onSave: (b: Record<string, unknown>) => unknown }) {
  const switchScope: Scope = skill.switchedBy ?? (scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal');
  return (
    <div className="editor">
      <div className="editor-scroll">
        <div className="editor-title">
          <h2>{skill.name}</h2>
          {skill.overrides && <span className="hint">Replaces the {SOURCE[skill.overrides]} skill of this name.</span>}
        </div>
        <Section title="On or off">
          <Toggle
            checked={skill.on}
            onChange={on => void onSave({ cmd: 'settings.save', scope: switchScope, patch: { skills: { [skill.name]: on } } })}
            label={skill.on ? 'Agents can read this skill' : 'Off: agents don’t see it'}
            hint={`Saved in ${switchScope === 'repo' ? 'this repository’s' : 'your personal'} settings.json.`}
          />
        </Section>
        <Section title="What it's for">
          <div>{skill.description || <span className="muted">No description. Agents decide from it whether to read the skill, so add one to its front matter.</span>}</div>
        </Section>
        <Section title="Who carries it">
          <div className="grid-2">
            <Field label="Roles" hint="A role’s Skills setting names the skills it carries.">
              <span className="chips">{skill.carriedBy.length ? skill.carriedBy.map(r => <span key={r} className="chip ro">{r}</span>) : <span className="muted">every role (none names it)</span>}</span>
            </Field>
            <Field label="Harnesses" hint="harness: in its front matter.">
              <span className="chips">{skill.harness.length ? skill.harness.map(h => <span key={h} className="chip ro">{h}</span>) : <span className="muted">every harness</span>}</span>
            </Field>
          </div>
          <Field label="Rules pointing at it" hint="A rule with this skill reminds agents of it at a moment MetaHarness can see.">
            <span className="chips">{skill.pointedBy.length ? skill.pointedBy.map(r => <span key={r} className="chip ro">{r}</span>) : <span className="muted">none: agents see it in their prompt’s skill list</span>}</span>
          </Field>
        </Section>
        <Section title="SKILL.md">
          <div className="preview">
            <Markdown text={skill.body} />
          </div>
        </Section>
        {skill.files.length > 0 && (
          <Section title="Files">
            <ul className="file-list mono small">
              {skill.files.map(f => (
                <li key={f.path}>
                  {f.path} <span className="muted">({size(f.bytes)})</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <div className="muted small mono file-path">{skill.file}</div>
      </div>
    </div>
  );
}
