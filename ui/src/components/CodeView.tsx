import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { DiffFile } from '../types.ts';
import { marksOf } from '../designData.ts';

const sources = new Map<string, Promise<string>>();

/** A file's text at a revision, fetched once: undefined while it's read, null when it can't be. */
export function useSource(goal: string, rev: string | undefined, path: string | undefined): string | undefined | null {
  const [t, setT] = useState<{ k: string; text: string | null }>();
  const k = `${goal}\n${rev}\n${path}`;
  useEffect(() => {
    if (!rev || !path) return;
    let alive = true;
    let p = sources.get(k);
    if (!p) {
      p = api.designSource(goal, rev, path).then(r => r.text);
      p.catch(() => sources.delete(k));
      sources.set(k, p);
    }
    p.then(
      text => alive && setT({ k, text }),
      () => alive && setT({ k, text: null }),
    );
    return () => {
      alive = false;
    };
  }, [goal, rev, path, k]);
  return t?.k === k ? t.text : undefined;
}

const diffs = new Map<string, Promise<DiffFile | undefined>>();

/** One file's diff between two revisions, fetched once: null while it's read, undefined when the file didn't change. */
export function useFileDiff(goal: string, from: string | undefined, to: string | undefined, path: string, on: boolean): DiffFile | undefined | null {
  const [f, setF] = useState<{ k: string; f: DiffFile | undefined }>();
  const k = `${goal}\n${from}\n${to}\n${path}`;
  useEffect(() => {
    if (!on || !from || !to) return;
    let alive = true;
    let p = diffs.get(k);
    if (!p) {
      p = api.diff(goal, { from, to, paths: [path] }).then(d => d.files.find(x => x.path === path) ?? d.files[0]);
      p.catch(() => diffs.delete(k));
      diffs.set(k, p);
    }
    p.then(x => alive && setF({ k, f: x }), () => alive && setF({ k, f: undefined }));
    return () => {
      alive = false;
    };
  }, [goal, from, to, path, on, k]);
  return f?.k === k ? f.f : null;
}

/**
 * Code as it is, with the edits marked on it: added lines green, changed ones yellow (hover one for
 * what it was), and a red line where lines were removed (hover it for them). `gone`: the code shown
 * was removed, all of it. Opens scrolled to the first edit.
 */
export function MarkedCode({ goal, rev, path, range, lines, gone, label, lineClass, extra }: {
  goal: string;
  /** The revision whose text is shown. */
  rev: string | undefined;
  path: string;
  /** The edits to mark, ending at `rev`. */
  range?: { from: string; to: string };
  /** Just these lines; the whole file without. */
  lines?: [number, number];
  gone?: boolean;
  /** Whose edits these are, in a few words. */
  label?: string;
  lineClass?: (n: number) => string | undefined;
  extra?: (n: number) => ReactNode;
}) {
  const text = useSource(goal, rev, path);
  const diff = useFileDiff(goal, range?.from, range?.to, path, !!range && !gone);
  const marks = useMemo(() => (diff && !diff.binary ? marksOf(diff.patch) : undefined), [diff]);
  const box = useRef<HTMLPreElement>(null);
  const scrolled = useRef('');
  useLayoutEffect(() => {
    const el = box.current;
    const k = `${rev}\n${path}\n${lines}`;
    if (!el || !marks || scrolled.current === k) return;
    scrolled.current = k;
    const first = el.querySelector<HTMLElement>('.code-line.add, .code-line.chg, .code-gap');
    if (first) el.scrollTop = Math.max(0, first.offsetTop - 48);
  });
  if (text === undefined) return <div className="muted small">Reading the code…</div>;
  if (text === null) return <div className="muted small">Couldn't read {path}{rev ? ` at ${rev.slice(0, 7)}` : ''}.</div>;
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  const a = Math.max(1, lines?.[0] ?? 1);
  const z = Math.min(all.length, lines?.[1] ?? all.length, a + 3000);
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (let n = a; n <= z; n++) {
    const m = marks?.line.get(n);
    if (m?.kind === 'add') added++;
    if (m?.kind === 'chg') changed++;
    removed += marks?.gone.get(n)?.length ?? 0;
  }
  const tail = !lines || z === all.length ? marks?.gone.get(z + 1) : undefined;
  removed += tail?.length ?? 0;
  const gap = (n: number, ls: string[]) => (
    <div key={`g${n}`} className="code-gap" tabIndex={0} title="">
      <span className="code-was" role="tooltip">
        {ls.map((l, i) => (
          <span key={i}>
            <span className="code-was-sign">−</span>
            {l || ' '}
            {'\n'}
          </span>
        ))}
      </span>
    </div>
  );
  return (
    <div className="marked-code">
      <div className="code-head small">
        {gone ? (
          <span className="mk del">Removed: this is what it was</span>
        ) : marks ? (
          added + changed + removed ? (
            <>
              {added > 0 && <span className="mk add">+{added} added</span>}
              {changed > 0 && <span className="mk chg">~{changed} changed</span>}
              {removed > 0 && <span className="mk del">−{removed} removed</span>}
              {label && <span className="muted">· {label} · hover a mark for what was there</span>}
            </>
          ) : (
            <span className="muted">Unchanged{label ? ` in ${label.replace(/^what /, '').replace(/ changed$/, '')}` : ''}.</span>
          )
        ) : range && diff === null ? (
          <span className="muted">Reading the edits…</span>
        ) : null}
      </div>
      <pre className="code-view" ref={box}>
        {Array.from({ length: z - a + 1 }, (_, i) => a + i).map(n => {
          const m = marks?.line.get(n);
          const g = marks?.gone.get(n);
          return [
            g && gap(n, g),
            <div key={n} className={['code-line', gone ? 'del' : m?.kind, lineClass?.(n)].filter(Boolean).join(' ')} tabIndex={m?.kind === 'chg' ? 0 : undefined}>
              <span className="code-n">{n}</span>
              <span className="code-t">{all[n - 1] || ' '}</span>
              {extra?.(n)}
              {m?.kind === 'chg' && (
                <span className="code-was" role="tooltip">
                  <span className="code-was-sign">was</span>
                  {m.was || ' '}
                </span>
              )}
            </div>,
          ];
        })}
        {tail && gap(z + 1, tail)}
      </pre>
    </div>
  );
}
