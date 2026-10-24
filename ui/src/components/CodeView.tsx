import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { DiffFile, Highlights } from '../types.ts';
import { marksOf } from '../designData.ts';
import { DocTip, useDocs } from './DocTip.tsx';
import { useCodeLinks, type Wrap } from './CodeLinks.tsx';

type Source = { text: string; highlights?: Highlights };
const sources = new Map<string, Promise<Source>>();

/** A file's text at a revision, coloured by its language pack when it has one; fetched once: undefined while it's read, null when it can't be. */
export function useSource(goal: string, rev: string | undefined, path: string | undefined): Source | undefined | null {
  const [t, setT] = useState<{ k: string; src: Source | null }>();
  const k = `${goal}\n${rev}\n${path}`;
  useEffect(() => {
    if (!rev || !path) return;
    let alive = true;
    let p = sources.get(k);
    if (!p) {
      p = api.designSource(goal, rev, path).then(r => ({ text: r.text, ...(r.highlights ? { highlights: r.highlights } : {}) }));
      p.catch(() => sources.delete(k));
      sources.set(k, p);
    }
    p.then(
      src => alive && setT({ k, src }),
      () => alive && setT({ k, src: null }),
    );
    return () => {
      alive = false;
    };
  }, [goal, rev, path, k]);
  return t?.k === k ? t.src : undefined;
}

/** A line's text in its colours: each span a `tk-<kind>`, the rest plain; each wrap puts its columns from s to e in something of its own (a definition's name, a linked call). */
function coloured(line: string, spans: number[] | undefined, kinds: string[], wraps: Wrap[] = []): ReactNode {
  if (!line) return ' ';
  if (!spans?.length && !wraps.length) return line;
  const segs: [number, number, number][] = [];
  let at = 0;
  for (let i = 0; i < (spans?.length ?? 0); i += 3) {
    const [s, e, k] = [spans![i], spans![i + 1], spans![i + 2]];
    if (s > at) segs.push([at, s, -1]);
    segs.push([s, e, k]);
    at = e;
  }
  if (at < line.length) segs.push([at, line.length, -1]);
  const piece = (s: number, e: number, k: number) =>
    k < 0 ? (
      line.slice(s, e)
    ) : (
      <span key={s} className={`tk-${kinds[k]}`}>
        {line.slice(s, e)}
      </span>
    );
  if (!wraps.length) return segs.map(([s, e, k]) => piece(s, e, k));
  // Pieces cut where wraps start and end, then gathered: those in a wrap go in it.
  const ws = [...wraps].sort((a, b) => a.s - b.s);
  const groups: { w: number; kids: ReactNode[] }[] = [];
  for (const [s, e, k] of segs) {
    for (let a = s; a < e; ) {
      const i = ws.findIndex(x => x.e > a);
      const w = i >= 0 && ws[i].s <= a ? i : -1;
      const b = Math.min(e, w >= 0 ? ws[w].e : i >= 0 ? ws[i].s : e);
      const last = groups.at(-1);
      if (last?.w === w) last.kids.push(piece(a, b, k));
      else groups.push({ w, kids: [piece(a, b, k)] });
      a = b;
    }
  }
  return groups.map((g, j) => (g.w < 0 ? g.kids : <Fragment key={`w${j}`}>{ws[g.w].wrap(g.kids)}</Fragment>));
}

/** Where a definition's name sits on its line: [start, end) columns. */
function nameAt(line: string, name: string): [number, number] | undefined {
  const m = new RegExp(`(^|[^\\w$])(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\w$])`).exec(line);
  return m ? [m.index + m[1].length, m.index + m[1].length + name.length] : undefined;
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
 * was removed, all of it. Opens scrolled to the first edit, or to `at`. Inside a CodeLinksContext,
 * the names the code graph knows (calls, signals, objects made, other classes' state) link on.
 */
export function MarkedCode({ goal, rev, path, range, lines, gone, label, at, lineClass, extra }: {
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
  /** A line to open at, marked. */
  at?: number;
  lineClass?: (n: number) => string | undefined;
  extra?: (n: number) => ReactNode;
}) {
  const src = useSource(goal, rev, path);
  const hl = src?.highlights;
  // Each definition's name, hovered, says what it's for.
  const docs = useDocs(goal, rev, path);
  const defs = useMemo(() => new Map((docs?.symbols ?? []).map(s => [s.line, s] as const).reverse()), [docs]);
  const links = useCodeLinks(rev, path);
  const diff = useFileDiff(goal, range?.from, range?.to, path, !!range && !gone);
  const marks = useMemo(() => (diff && !diff.binary ? marksOf(diff.patch) : undefined), [diff]);
  const box = useRef<HTMLPreElement>(null);
  const scrolled = useRef('');
  useLayoutEffect(() => {
    const el = box.current;
    const k = `${rev}\n${path}\n${lines}\n${at}`;
    if (!el || scrolled.current === k) return;
    const first = el.querySelector<HTMLElement>(at ? '.code-line.at' : '.code-line.add, .code-line.chg, .code-gap');
    if (at ? !first : !marks) return;
    scrolled.current = k;
    if (first) el.scrollTop = Math.max(0, el.scrollTop + first.getBoundingClientRect().top - el.getBoundingClientRect().top - 48);
  });
  if (src === undefined) return <div className="muted small">Reading the code…</div>;
  if (src === null) return <div className="muted small">Couldn't read {path}{rev ? ` at ${rev.slice(0, 7)}` : ''}.</div>;
  const all = src.text.split('\n');
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
  /** A line's wraps: the name of a definition on it (hovered, what it's for), and the names that link on. */
  const wrapsOf = (n: number): Wrap[] => {
    const own = defName(n);
    const refs = links?.(n, all[n - 1]) ?? [];
    return own ? [own, ...refs.filter(r => r.e <= own.s || r.s >= own.e)] : refs;
  };
  const defName = (n: number): Wrap | undefined => {
    const d = defs.get(n);
    const pos = d && nameAt(all[n - 1], d.name);
    if (!d || !pos) return undefined;
    return {
      s: pos[0],
      e: pos[1],
      wrap: (inner: ReactNode) => (
        <DocTip key="doc" goal={goal} rev={rev} path={path} name={d.name} parent={d.parent} line={d.line} kind={d.kind} doc={d.doc ?? ''} inline>
          {inner}
        </DocTip>
      ),
    };
  };
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
            <div key={n} className={['code-line', gone ? 'del' : m?.kind, n === at && 'at', lineClass?.(n)].filter(Boolean).join(' ')} tabIndex={m?.kind === 'chg' ? 0 : undefined}>
              <span className="code-n">{n}</span>
              <span className="code-t">{coloured(all[n - 1], hl?.lines[n - 1], hl?.kinds ?? [], wrapsOf(n))}</span>
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
