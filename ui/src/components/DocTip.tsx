import { useEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';
import type { FileDocs } from '../types.ts';

const docs = new Map<string, Promise<FileDocs>>();

/** A file's doc comments at a revision, fetched once: undefined while they're read, null when they can't be. */
export function useDocs(goal: string, rev: string | undefined, path: string | undefined, on = true): FileDocs | undefined | null {
  const [t, setT] = useState<{ k: string; d: FileDocs | null }>();
  const k = `${goal}\n${rev}\n${path}`;
  useEffect(() => {
    if (!on || !rev || !path) return;
    let alive = true;
    let p = docs.get(k);
    if (!p) {
      p = api.designDocs(goal, rev, path);
      p.catch(() => docs.delete(k));
      docs.set(k, p);
    }
    p.then(
      d => alive && setT({ k, d }),
      () => alive && setT({ k, d: null }),
    );
    return () => {
      alive = false;
    };
  }, [goal, rev, path, on, k]);
  return t?.k === k ? t.d : undefined;
}

/** What a hover is about: a file, or a definition in it. `doc` when it's known already (no fetch); `note` says what clicking does. */
export interface DocTarget {
  goal?: string;
  rev?: string;
  path?: string;
  name?: string;
  parent?: string;
  line?: number;
  kind?: string;
  doc?: string;
  note?: string;
}

/** The doc of the definition named, or the file's. */
export function docOf(d: FileDocs, t: { name?: string; parent?: string; line?: number }): string | undefined {
  if (!t.name) return d.doc;
  const hits = d.symbols.filter(s => s.name === t.name && (t.parent === undefined || s.parent === t.parent));
  return (hits.find(s => s.line === t.line) ?? hits[0])?.doc;
}

/** A doc as paragraphs, the first its summary: lines wrapped in the source join up, list items and tags keep their own line. */
function paragraphs(doc: string): string[] {
  return doc
    .split(/\n\s*\n/)
    .map(p => p.split('\n').map(l => l.trim()).reduce((a, l) => (!a ? l : /^([-*•]\s|\d+[.)]\s|@\w)/.test(l) ? `${a}\n${l}` : `${a} ${l}`), ''))
    .filter(Boolean);
}

const FN_KINDS = ['function', 'method'];

function DocCard({ t, at }: { t: DocTarget; at: DOMRect }) {
  const fetched = useDocs(t.goal ?? '', t.rev, t.path, t.doc === undefined && !!t.goal);
  // Nothing to read it from: a file not committed yet.
  const none = t.doc === undefined && (!t.goal || !t.rev || !t.path);
  const doc = t.doc !== undefined ? t.doc : fetched ? docOf(fetched, t) : undefined;
  const below = at.bottom + 220 < window.innerHeight;
  const style = { left: Math.max(8, Math.min(at.left, window.innerWidth - 388)), ...(below ? { top: at.bottom + 6 } : { bottom: window.innerHeight - at.top + 6 }) };
  const [summary, ...more] = doc ? paragraphs(doc) : [];
  return createPortal(
    <div className="doc-tip" style={style} role="tooltip">
      <div className="doc-tip-head mono">
        {t.name ? `${t.parent ? `${t.parent}.` : ''}${t.name}${FN_KINDS.includes(t.kind ?? '') ? '()' : ''}` : t.path?.split('/').pop()}
        {t.path && <span className="muted small"> {t.name ? t.path.split('/').pop() : t.path}</span>}
      </div>
      {summary ? (
        <>
          <div className="doc-summary">{summary}</div>
          {more.map((p, i) => (
            <div key={i} className="doc-more">
              {p}
            </div>
          ))}
        </>
      ) : none ? null : t.doc === undefined && fetched === undefined ? (
        <div className="muted small reading">Reading…</div>
      ) : (
        <div className="muted small">{fetched === null ? "Couldn't read it." : 'No description yet.'}</div>
      )}
      {t.note && <div className="muted small doc-note">{t.note}</div>}
    </div>,
    document.body,
  );
}

/**
 * Hovering what it wraps shows what the code says it's for, after a moment. It adds no box of its
 * own, so it fits round a row in a flex list; `inline` makes it a span of text instead (a name in
 * code), and `off` leaves what it wraps as it is.
 */
export function DocTip({ children, inline, off, ...t }: DocTarget & { children: ReactNode; inline?: boolean; off?: boolean }) {
  const [at, setAt] = useState<DOMRect>();
  const timer = useRef<number>(undefined);
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(undefined);
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [at]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const enter = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const el = inline ? e.currentTarget : (e.currentTarget.firstElementChild ?? e.currentTarget);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAt(el.getBoundingClientRect()), 450);
  };
  const leave = () => {
    clearTimeout(timer.current);
    setAt(undefined);
  };
  if (off) return children;
  return (
    <span className={inline ? 'doc-name' : 'doc-wrap'} onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave}>
      {children}
      {at && <DocCard t={t} at={at} />}
    </span>
  );
}
