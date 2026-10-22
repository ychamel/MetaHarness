import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ConfigView, Scope } from '../types.ts';
import { ScopeBadge, useConfirm } from '../components/common.tsx';
import { Splitter } from '../components/Splitter.tsx';

/** What every Setup page gets from the app. */
export interface SetupProps {
  config?: ConfigView;
  selected?: string;
  onSelect: (key?: string) => void;
  /** Runs a config command; resolves with the new config, or undefined when it failed (the app says why). */
  onSave: (b: Record<string, unknown>) => Promise<ConfigView | undefined>;
  onCommand: (b: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
}

/** An item's key in the address: scope/name. */
export const keyOf = (x: { scope: Scope | 'built-in'; name: string }) => `${x.scope}/${x.name}`;

/**
 * A copy of an item being edited, and whether it differs from what's saved. `reset` takes a new
 * saved version (after a save, or when another item is picked).
 */
export function useDraft<T>(saved: T) {
  const [draft, setDraft] = useState<T>(saved);
  const [base, setBase] = useState<T>(saved);
  const savedJson = JSON.stringify(saved);
  useEffect(() => {
    setDraft(JSON.parse(savedJson));
    setBase(JSON.parse(savedJson));
  }, [savedJson]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const set = useCallback(<K extends keyof T>(k: K, v: T[K]) => setDraft(d => ({ ...d, [k]: v })), []);
  return { draft, set, setDraft, dirty, revert: () => setDraft(base) };
}

/** Before leaving an edited item: keep editing, or drop the changes. */
export function useLeaveGuard(dirty: boolean) {
  const confirm = useConfirm();
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return async () => !dirty || (await confirm({ title: 'Discard your changes?', body: 'What you changed here isn’t saved yet.', confirm: 'Discard', danger: true }));
}

export function SetupLayout({ title, intro, list, editor, action }: { title: string; intro: ReactNode; list: ReactNode; editor: ReactNode; action?: ReactNode }) {
  return (
    <div className="page setup">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <div className="muted intro">{intro}</div>
        </div>
        {action}
      </div>
      <div className="setup-body">
        <div className="setup-list">{list}</div>
        <Splitter pane="setup" grow="right" min={180} max={640} label="List" />
        <div className="setup-editor">{editor}</div>
      </div>
    </div>
  );
}

export function ListItem({ on, title, scope, sub, extra, onClick }: { on: boolean; title: string; scope?: Scope | 'built-in'; sub?: ReactNode; extra?: ReactNode; onClick: () => void }) {
  return (
    <button className={`list-item${on ? ' on' : ''}`} onClick={onClick}>
      <span className="list-item-top">
        <b>{title}</b>
        {extra}
        <span className="spacer" />
        {scope && <ScopeBadge scope={scope} />}
      </span>
      {sub && <span className="list-item-sub">{sub}</span>}
    </button>
  );
}

/** Where to save: this repository's .metaharness, or the personal one that every project reads. */
export function ScopePicker({ config, value, onChange }: { config?: ConfigView; value: Scope; onChange: (s: Scope) => void }) {
  const scopes = config?.scopes ?? [];
  if (scopes.length < 2) return <span className="muted small">{scopes[0]?.dir}</span>;
  return (
    <div className="segmented" role="radiogroup" aria-label="Save to">
      {scopes.map(s => (
        <button key={s.scope} role="radio" aria-checked={value === s.scope} className={value === s.scope ? 'on' : ''} onClick={() => onChange(s.scope)} title={s.dir}>
          {s.scope === 'repo' ? 'This repository' : 'Personal (every project)'}
        </button>
      ))}
    </div>
  );
}

export function EditorFooter({ dirty, isNew, onSave, onRevert, onDelete, onDuplicate, saving }: { dirty: boolean; isNew: boolean; saving: boolean; onSave: () => void; onRevert: () => void; onDelete?: () => void; onDuplicate?: () => void }) {
  return (
    <div className="editor-footer">
      {onDelete && !isNew && (
        <button className="btn ghost danger" onClick={onDelete}>
          Delete
        </button>
      )}
      {onDuplicate && !isNew && (
        <button className="btn ghost" onClick={onDuplicate}>
          Duplicate
        </button>
      )}
      <span className="spacer" />
      {dirty && <span className="muted small">Unsaved changes</span>}
      {(dirty || isNew) && (
        <button className="btn" onClick={onRevert}>
          {isNew ? 'Cancel' : 'Revert'}
        </button>
      )}
      <button className="btn primary" disabled={(!dirty && !isNew) || saving} onClick={onSave}>
        {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
      </button>
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="form-section">
      <div className="form-section-head">
        <h3>{title}</h3>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="form-section-body">{children}</div>
    </section>
  );
}
