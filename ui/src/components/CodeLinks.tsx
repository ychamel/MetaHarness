import { createContext, useContext, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { CodeGraph } from '../types.ts';
import { indexGraph, placeRefs, refsOf, type CodeIndex, type Ref } from '../codeData.ts';
import { DocTip, type DocTarget } from './DocTip.tsx';

const graphs = new Map<string, Promise<CodeGraph>>();
const ready = new Map<string, CodeGraph>();

/** The code graph at a commit or tree, fetched once (and there at once when it was). */
export function useGraph(goal: string, rev: string | undefined): { g?: CodeGraph; error?: string } {
  const k = `${goal}\n${rev}`;
  const [s, setS] = useState<{ g?: CodeGraph; error?: string; k?: string }>({});
  useEffect(() => {
    if (!rev || ready.has(k)) return;
    let alive = true;
    let p = graphs.get(k);
    if (!p) {
      p = api.designCode(goal, rev).then(r => (ready.set(k, r.graph), r.graph));
      p.catch(() => graphs.delete(k));
      graphs.set(k, p);
    }
    p.then(
      g => alive && setS({ g, k }),
      e => alive && setS({ error: (e as Error).message, k }),
    );
    return () => {
      alive = false;
    };
  }, [goal, rev, k]);
  if (rev && ready.has(k)) return { g: ready.get(k) };
  return s.k === k ? s : {};
}

const indexes = new WeakMap<CodeGraph, CodeIndex>();

/** A graph's index, made once. */
export function indexOf(g: CodeGraph): CodeIndex {
  let ix = indexes.get(g);
  if (!ix) indexes.set(g, (ix = indexGraph(g)));
  return ix;
}

/** What links the names in the code shown into the code graph: the goal, and what following or hovering one does. Without it, code stays plain. */
export interface CodeLinks {
  goal: string;
  /** `ix` is the graph at the code's revision, which may not be the one the view draws. */
  onFollow: (r: Ref, ix: CodeIndex) => void;
  onHover: (r: Ref | undefined, ix: CodeIndex) => void;
}

export const CodeLinksContext = createContext<CodeLinks | undefined>(undefined);

/** A span of a line wrapped in something of its own. */
export type Wrap = { s: number; e: number; wrap: (inner: ReactNode) => ReactNode };

/** The names on a line of a file at a revision that link into the graph, as wraps; undefined outside a CodeLinksContext or before the graph is read. */
export function useCodeLinks(rev: string | undefined, path: string): ((n: number, text: string) => Wrap[]) | undefined {
  const cx = useContext(CodeLinksContext);
  const { g } = useGraph(cx?.goal ?? '', cx ? rev : undefined);
  const refs = useMemo(() => (g ? refsOf(indexOf(g), path) : undefined), [g, path]);
  return useMemo(() => {
    if (!cx || !g || !refs?.size) return undefined;
    const ix = indexOf(g);
    return (n: number, text: string) =>
      placeRefs(text, refs.get(n) ?? []).map(r => ({
        s: r.s,
        e: r.e,
        wrap: (inner: ReactNode) => (
          <RefName key={`r${r.s}`} r={r} ix={ix} rev={rev} cx={cx}>
            {inner}
          </RefName>
        ),
      }));
  }, [cx, g, refs, rev]);
}

/** What a name stands for, for its hover card: the definition's doc, and a line on what it does here and what clicking does. */
function targetOf(ix: CodeIndex, r: Ref): DocTarget {
  const clsName = (id: string) => ix.cls.get(id)?.name ?? id;
  const guess = r.edge.g ? ' Guessed by its name: the receiver has no declared type.' : '';
  switch (r.kind) {
    case 'call':
    case 'handler': {
      const f = ix.fn.get(r.id)!;
      const sig = r.kind === 'handler' ? ix.sig.get(r.edge.f) : undefined;
      const what = sig ? `Handles ${clsName(sig.cls)}.${sig.name} when it's emitted.` : `Called here.${guess}`;
      return { path: f.file, name: f.name, parent: clsName(f.cls), line: f.line, kind: 'function', doc: f.doc ?? '', note: `${what} Click to open it.` };
    }
    case 'new': {
      const c = ix.cls.get(r.id)!;
      return { path: c.file, name: c.name, line: c.line, kind: 'class', doc: c.doc ?? '', note: `A ${c.name} is made here. Click to open it.` };
    }
    case 'emit':
    case 'connect': {
      const s = ix.sig.get(r.id)!;
      const n = (ix.out.get(s.id) ?? []).filter(e => e.k === 'listen').length;
      const what = r.kind === 'emit' ? `Emitted here; ${n === 1 ? 'one function handles' : `${n || 'no'} functions handle`} it.` : `Connected here to ${ix.fn.get(r.edge.t)?.name ?? 'a function'}.`;
      return { path: ix.cls.get(s.cls)?.file, name: s.name, parent: clsName(s.cls), line: s.line, kind: 'signal', note: `${what} Click for the signal.` };
    }
    case 'read':
    case 'write': {
      const f = ix.field.get(r.id)!;
      return { path: ix.cls.get(f.cls)?.file, name: f.name, parent: clsName(f.cls), line: f.line, kind: 'variable', note: `${clsName(f.cls)}'s state, ${r.kind === 'write' ? 'changed' : 'read'} here. Click for ${clsName(f.cls)}.` };
    }
  }
}

function RefName({ r, ix, rev, cx, children }: { r: Ref; ix: CodeIndex; rev: string | undefined; cx: CodeLinks; children: ReactNode }) {
  const t = targetOf(ix, r);
  const follow = () => (cx.onHover(undefined, ix), cx.onFollow(r, ix));
  return (
    <DocTip inline goal={cx.goal} rev={rev} {...t}>
      <span
        className={`code-ref ref-${r.kind}${r.edge.g ? ' guess' : ''}`} role="link" tabIndex={0}
        onClick={follow} onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && follow()}
        onMouseEnter={() => cx.onHover(r, ix)} onMouseLeave={() => cx.onHover(undefined, ix)}
      >
        {children}
      </span>
    </DocTip>
  );
}
