import { useEffect, useState } from 'react';
import type { ConfigView, GuideDef, Scope } from '../types.ts';
import { Markdown, ScopeBadge, useConfirm } from '../components/common.tsx';
import { ScopePicker, useLeaveGuard } from './setup.tsx';

/** The team guidelines (methodology) every agent gets, and the short ones for quick helpers. */
export function Guidelines({ config, onSave }: { config?: ConfigView; onSave: (b: Record<string, unknown>) => Promise<ConfigView | undefined> }) {
  if (!config) return <div className="page"><div className="empty">Loading…</div></div>;
  return (
    <div className="page setup">
      <div className="page-head">
        <div>
          <h1>Guidelines</h1>
          <div className="muted intro">How every agent should work with the rest of the team. It opens each agent’s prompt, before its role’s own instructions. A repository’s guidelines replace your personal ones there.</div>
        </div>
      </div>
      <div className="guides">
        <GuideEditor which="methodology" title="Team guidelines" sub="Given to every agent that isn't a quick helper." guide={config.methodology} config={config} onSave={onSave} />
        <GuideEditor which="helper-methodology" title="Quick-helper guidelines" sub="Given to quick helpers instead: answer the brief, nothing more." guide={config.helperMethodology} config={config} onSave={onSave} />
      </div>
    </div>
  );
}

function GuideEditor({ which, title, sub, guide, config, onSave }: { which: string; title: string; sub: string; guide: GuideDef; config: ConfigView; onSave: (b: Record<string, unknown>) => Promise<ConfigView | undefined> }) {
  const [text, setText] = useState(guide.text);
  const [scope, setScope] = useState<Scope>(guide.from === 'built-in' ? (config.scopes.at(-1)?.scope ?? 'repo') : guide.from);
  const [preview, setPreview] = useState(true);
  const [saving, setSaving] = useState(false);
  const confirm = useConfirm();
  useEffect(() => setText(guide.text), [guide.text]);
  const dirty = text.trim() !== guide.text.trim() || (guide.from !== 'built-in' && scope !== guide.from && text.trim() !== (guide.files[scope] ?? '').trim());
  useLeaveGuard(dirty);
  const save = async (t: string, s: Scope) => {
    setSaving(true);
    await onSave({ cmd: 'guide.save', which, scope: s, text: t });
    setSaving(false);
  };
  return (
    <section className="panel guide">
      <div className="guide-head">
        <div>
          <h2>{title}</h2>
          <div className="muted small">{sub}</div>
        </div>
        <span className="spacer" />
        {guide.from === 'built-in' ? <span className="scope built-in">built-in</span> : <ScopeBadge scope={guide.from} />}
        <span className="segmented small">
          <button className={preview ? 'on' : ''} onClick={() => setPreview(true)}>
            Read
          </button>
          <button className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>
            Edit
          </button>
        </span>
      </div>
      {preview && !dirty ? (
        <div className="preview">
          <Markdown text={text} />
        </div>
      ) : (
        <textarea className="instructions" rows={16} value={text} onChange={e => setText(e.target.value)} />
      )}
      {(!preview || dirty) && (
        <div className="editor-footer flat">
          {guide.from !== 'built-in' && (
            <button
              className="btn ghost"
              onClick={async () => {
                if (await confirm({ title: 'Go back to the built-in text?', body: <>This removes <span className="mono">{guide.from === 'repo' ? 'the repository’s' : 'your personal'}</span> file; {Object.keys(guide.files).length > 1 ? 'the other folder’s file applies then' : 'the built-in guidelines apply then'}.</>, confirm: 'Remove the file', danger: true }))
                  await save('', guide.from as Scope);
              }}
            >
              Use {Object.keys(guide.files).length > 1 ? 'the other folder’s' : 'the built-in'} text
            </button>
          )}
          <span className="spacer" />
          <span className="muted small">Save to</span>
          <ScopePicker config={config} value={scope} onChange={setScope} />
          {dirty && (
            <button className="btn" onClick={() => setText(guide.text)}>
              Revert
            </button>
          )}
          <button className="btn primary" disabled={!dirty || saving || !text.trim()} onClick={() => void save(text, scope)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </section>
  );
}
