import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { applyNodeChanges, Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.ts';
import type { CodeEdge, CodeFn, CodeGraph, DesignScopeView, DesignSnapshot, Goal } from '../types.ts';
import {
  between, canvasOf, changeFocusOf, classesIn, classLinks, codeChange, edgeKey, edgeSentence, engineWhen, fnLabel, fnsChanged, groupClasses, indexGraph, isRestId, makeTree, ownerOf, parentOf, railClasses, routeTo,
  searchCode, stacksTo, stateOf, stepsDown, stepsUp,
  type CodeChange, type CodeIndex, type Link, type LinkKind, type Meeting, type Step, type Touch, type Tree,
} from '../codeData.ts';
import { areaLabel, symbolEnd } from '../designData.ts';
import { Splitter } from '../components/Splitter.tsx';
import { ChangedFiles, PanelButton, SymbolCode, ToggleMenu, useCommitChange, type CommitDef, type Peek } from './Design.tsx';
import { MarkedCode } from '../components/CodeView.tsx';
import { KIND_STYLE, SystemsCanvas, type Act } from './SystemsCanvas.tsx';

/** Where the Systems lens is: what's looked at and how it's split, what's selected and traced, and a connection opened. */
export interface SystemsNav {
  /** The trace drawn wide, in place of the canvas. */
  tool?: 'map' | 'trace';
  /** What's looked at: classes, groups (`group:<area>|<key>`) and areas (`area:<path>`). */
  focus?: string[];
  /** Whether what the scope changed is looked at too: on unless turned off. */
  changes?: boolean;
  /** Groups and areas opened in place (a frame around their cards, nothing else changed). */
  open?: string[];
  /** Cards pinned in a frame and functions pinned on a class, and the frames and classes showing only what's pinned. */
  pins?: string[];
  tuck?: string[];
  /** Cards split into what they hold, and units kept whole. */
  expand?: string[];
  fold?: string[];
  /** Areas drawn though nothing links them to the focus, and areas put away as chips. */
  show?: string[];
  hide?: string[];
  /** The route from the engine: on unless turned off. */
  route?: boolean;
  sel?: string;
  trace?: string;
  up?: boolean;
  /** A connection clicked on the canvas (its two cards and kind), drawn on its own when `linkOpen`, and the pair of classes picked in it. */
  link?: { from: string; to: string; kind: LinkKind };
  linkOpen?: boolean;
  pick?: string;
  /** A connection picked between two systems looked at: `<a|b>|<kind>|<middle class>` or `<ab|ba>|<kind>`. */
  bpick?: string;
  /** A definition shown with its diff that has no function in the graph here (one removed). */
  def?: DefSel;
}

/** A definition and the diff it's shown with. */
interface DefSel {
  file: string;
  name: string;
  kind: string;
  parent?: string;
  line?: number;
  end?: number;
  side: 'new' | 'old';
  from: string;
  to: string;
  /** Where it changed, in words. */
  label: string;
}

type Range = { from: string; to: string };

interface Props {
  goal: Goal;
  view: DesignScopeView;
  snap: DesignSnapshot;
  nav: SystemsNav;
  onNav: (n: SystemsNav) => void;
  /** The lens switch, drawn first in the toolbar, and the scope bar the toolbar goes in. */
  lens: ReactNode;
  scopeBar: (tools: ReactNode) => ReactNode;
  /** The panel opened by hand with nothing selected; otherwise it shows only for a selection. */
  panel: boolean;
  onPanel: (open: boolean) => void;
  /** What's lit on the map (a commit, a file or a definition), whether a commit is kept lit, and lighting some. */
  peek?: Peek;
  /** The commit kept lit. */
  lock?: string;
  onUnlock: () => void;
  onPeek: (paths?: string[]) => void;
  /** The kept commit's panel, drawn with this lens's ways to a definition or a file; and showing or hiding it. */
  commit?: (h: { onDef: (d: CommitDef) => void; onFile: (path: string) => void }) => ReactNode;
  onCommitPanel: (open: boolean) => void;
}

const graphs = new Map<string, Promise<CodeGraph>>();

/** The code graph at a commit or tree, fetched once. */
function useGraph(goal: string, rev: string | undefined): { g?: CodeGraph; error?: string } {
  const [s, setS] = useState<{ g?: CodeGraph; error?: string; rev?: string }>({});
  useEffect(() => {
    if (!rev) return;
    let alive = true;
    const k = `${goal}\n${rev}`;
    let p = graphs.get(k);
    if (!p) {
      p = api.designCode(goal, rev).then(r => r.graph);
      p.catch(() => graphs.delete(k));
      graphs.set(k, p);
    }
    p.then(
      g => alive && setS({ g, rev }),
      e => alive && setS({ error: (e as Error).message, rev }),
    );
    return () => {
      alive = false;
    };
  }, [goal, rev]);
  return s.rev === rev ? s : {};
}

/**
 * The graphs before and after the scope, and the scope's change, kept as they were until the new
 * ones have all arrived: the canvas changes once, in place, instead of blanking while they load.
 */
function useGraphs(goal: string, to: string | undefined, from: string | undefined, change: DesignScopeView['change']) {
  const after = useGraph(goal, to);
  const before = useGraph(goal, from);
  const ready = !!after.g && (!from || !!before.g || !!before.error);
  const last = useRef<{ after?: CodeGraph; before?: CodeGraph; change?: DesignScopeView['change'] }>({});
  if (ready && (last.current.after !== after.g || last.current.before !== before.g || last.current.change !== change)) last.current = { after: after.g, before: from ? before.g : undefined, change };
  return { ...last.current, loading: !ready && !after.error, error: last.current.after ? undefined : after.error };
}

type Kinds = Record<'call' | 'signal' | 'new' | 'state', boolean>;
const KIND_KEY = 'mh.systems.kinds';
const DEFAULT_KINDS: Kinds = { call: true, signal: true, new: true, state: false };
const KINDS: [keyof Kinds, string, string][] = [
  ['call', 'Calls', 'A function calling one in another class'],
  ['signal', 'Signals', 'A signal emitted in one class and handled in another (the bus between them left out)'],
  ['new', 'Creates', 'One class making objects of another'],
  ['state', 'State', "Reading or writing another class's variables and constants"],
];

function useKinds(): [Kinds, (k: keyof Kinds, v: boolean) => void] {
  const [k, setK] = useState<Kinds>(() => {
    try {
      return { ...DEFAULT_KINDS, ...JSON.parse(localStorage.getItem(KIND_KEY) ?? '{}') };
    } catch {
      return DEFAULT_KINDS;
    }
  });
  const set = (key: keyof Kinds, v: boolean) =>
    setK(o => {
      const n = { ...o, [key]: v };
      try {
        localStorage.setItem(KIND_KEY, JSON.stringify(n));
      } catch {
        // Kept for this visit only.
      }
      return n;
    });
  return [k, set];
}

const linkKinds = (k: Kinds) => new Set<LinkKind>([...(k.call ? ['call' as const] : []), ...(k.signal ? ['signal' as const] : []), ...(k.new ? ['new' as const] : []), ...(k.state ? ['read' as const, 'write' as const] : [])]);

/** An id for an area's unit, apart from class ids. */
const areaNode = (a: string) => `area:${a}`;
const isArea = (id: string) => id.startsWith('area:');

const without = (l: string[] | undefined, ...xs: string[]) => (l ?? []).filter(x => !xs.includes(x));
const plus = (l: string[] | undefined, x: string) => [...new Set([...(l ?? []), x])];

/**
 * The Systems lens of the Design view (design §14): how the code runs, on one canvas. With
 * nothing looked at it's the whole game, area by area, from the engine. Looking at a class, a
 * group or an area (or at what the scope changed) draws it in full, with what's one step from it
 * and chips for the rest; a function selected there shows its trace in the panel. Looking at two
 * systems shows where they meet.
 */
export default function Systems({ goal, view, snap, nav, onNav, lens, scopeBar, panel, onPanel, peek, lock, onUnlock, onPeek, commit, onCommitPanel }: Props) {
  const locked = !!lock;
  const tool = nav.tool ?? 'map';
  const [kinds, setKind] = useKinds();
  const [showChange, setShowChange] = useState(true);
  const [hl, setHl] = useState<string>();
  const gs = useGraphs(goal.id, view.scope?.to, showChange && view.scope ? view.scope.from : undefined, view.change);
  const ix = useMemo(() => (gs.after ? indexGraph(gs.after) : undefined), [gs.after]);
  const bix = useMemo(() => (gs.before ? indexGraph(gs.before) : undefined), [gs.before]);
  const links = useMemo(() => (ix ? classLinks(ix) : []), [ix]);
  const chg = useMemo(() => (ix && showChange && bix ? codeChange(bix, ix, gs.change) : undefined), [ix, bix, showChange, gs.change]);
  // The functions lit: the definitions hovered, what the commit changed in its files, or what the scope changed in a file hovered.
  const peekKey = JSON.stringify(peek ?? null);
  const commitChg = useCommitChange(goal.id, peek?.sha);
  const lockChg = useCommitChange(goal.id, lock);
  const litFns = useMemo(() => {
    if (!ix || !peek) return undefined;
    const files = new Set(peek.paths);
    if (peek.defs) {
      const want = new Set(peek.defs.map(d => `${d.file}\n${d.name}`));
      return new Set(ix.g.fns.filter(f => want.has(`${f.file}\n${f.name}`)).map(f => f.id));
    }
    if (peek.sha) return commitChg ? new Set([...fnsChanged(ix, commitChg)].filter(f => files.has(ix.fn.get(f)?.file ?? ''))) : undefined;
    return new Set([...(chg?.edited ?? []), ...(chg?.newFns ?? [])].filter(f => files.has(ix.fn.get(f)?.file ?? '')));
  }, [ix, peekKey, commitChg, chg]); // eslint-disable-line react-hooks/exhaustive-deps
  // Their classes: a definition's own, or every class in the files.
  const lit = useMemo(() => {
    if (!ix || !peek) return undefined;
    if (peek.defs && litFns?.size) return new Set([...litFns].map(f => ix.fn.get(f)!.cls));
    const files = new Set(peek.paths);
    return new Set(ix.g.classes.filter(c => files.has(c.file)).map(c => c.id));
  }, [ix, peekKey, litFns]); // eslint-disable-line react-hooks/exhaustive-deps
  const tree = useMemo(() => (ix ? makeTree(groupClasses(ix, links)) : undefined), [ix, links]);
  const rails = useMemo(() => (ix ? railClasses(ix, links) : new Set<string>()), [ix, links]);
  const changeFocus = useMemo(() => (ix && tree && chg ? changeFocusOf(ix, tree, chg) : []), [ix, tree, chg]);
  const changesOn = changeFocus.length > 0 && nav.changes !== false;
  const focusKey = (nav.focus ?? []).join('\n');
  const focus = useMemo(() => [...new Set([...(changesOn ? changeFocus : []), ...(nav.focus ?? [])])], [changesOn, changeFocus, focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const lk = linkKinds(kinds);
  const lkKey = [...lk].join();
  // Two systems looked at: where they meet is drawn class by class.
  const meet = useMemo(
    () => (ix && tree && focus.length === 2 ? between(ix, links, new Set(classesIn(ix, tree, focus[0])), new Set(classesIn(ix, tree, focus[1]))) : undefined),
    [ix, tree, links, focus],
  );
  const canvas = useMemo(
    () =>
      ix && tree
        ? canvasOf(ix, tree, links, rails, {
            focus, open: nav.open ?? [], pins: nav.pins ?? [], tuck: nav.tuck ?? [], expand: nav.expand ?? [], fold: nav.fold ?? [], show: nav.show ?? [], hide: nav.hide ?? [], kinds: lk,
            ...(meet ? { single: new Set(meet.meetings.filter(m => m.how !== 'shared').slice(0, 12).map(m => m.mid)) } : {}),
          })
        : undefined,
    [ix, tree, links, rails, focus, nav.open, nav.pins, nav.tuck, nav.expand, nav.fold, nav.show, nav.hide, lkKey, meet], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const route = useMemo(() => (ix && tree && nav.route !== false && focus.length ? routeTo(ix, tree, focus, chg) : []), [ix, tree, focus, chg, nav.route]);
  const hist = useRef<SystemsNav[]>([]);
  const navRef = useRef(nav);
  navRef.current = nav;
  const set = (n: Partial<SystemsNav>) => onNav({ ...nav, ...n });
  /** A change of what's looked at, remembered for Back. */
  const go = (n: Partial<SystemsNav>) => {
    hist.current = [...hist.current.slice(-40), nav];
    onNav({ ...nav, ...n, tool: 'map', link: undefined, linkOpen: undefined });
  };
  const back = () => {
    const prev = hist.current.pop();
    if (prev) onNav(prev);
  };
  const side = !!nav.sel || !!nav.link || !!nav.def || panel || !!commit;
  const sideRef = useRef(side);
  sideRef.current = side;
  /** Puts the panel away: what's selected is let go. */
  const closeSide = () => (onPanel(false), onCommitPanel(false), (navRef.current.sel || navRef.current.link || navRef.current.def) && onNav({ ...navRef.current, sel: undefined, link: undefined, def: undefined }));
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      const n = navRef.current;
      // Esc lets go of one thing at a time: a connection drawn on its own, what's selected, the commit kept lit, the panel, then what was looked at.
      if (n.linkOpen || n.tool === 'trace') onNav({ ...n, linkOpen: undefined, tool: 'map' });
      else if (n.sel || n.link || n.def) onNav({ ...n, sel: undefined, link: undefined, def: undefined });
      else if (lockedRef.current) onUnlock();
      else if (sideRef.current) closeSide();
      else back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (a: Act, unit: string) => {
    if (!ix || !tree) return;
    // The rest of a frame, clicked: what was folded onto it comes back.
    if (isRestId(unit)) return go({ tuck: without(nav.tuck, unit.slice(5)) });
    switch (a) {
      case 'select':
        return set({ sel: unit, link: undefined, def: undefined });
      case 'focus':
        if (unit.startsWith('chip:')) unit = areaNode(unit.slice(5));
        return go({ focus: [unit], changes: false, open: [], pins: [], tuck: [], expand: [], fold: [], show: [], sel: unit });
      case 'add':
        return go({ focus: plus(nav.focus, unit), sel: unit });
      case 'unfocus':
        if (unit === '*') return go({ focus: [], changes: false, open: [], pins: [], tuck: [], expand: [], fold: [], show: [], sel: undefined });
        if (nav.focus?.includes(unit)) return go({ focus: without(nav.focus, unit), ...(nav.sel === unit ? { sel: undefined } : {}) });
        return go({ changes: false, focus: focus.filter(f => f !== unit) });
      case 'expand':
        if (unit.startsWith('chip:')) {
          // Drawing a chip brings back what was hidden in its area too.
          const a = unit.slice(5);
          const inArea = (h: string) => h === areaNode(a) || tree.group.get(h)?.area === a || ix.cls.get(h)?.area === a;
          return go({ show: plus(nav.show, areaNode(a)), hide: (nav.hide ?? []).filter(h => !inArea(h)) });
        }
        return go({ expand: plus(nav.expand, unit), fold: without(nav.fold, unit) });
      case 'shrink': {
        const p = parentOf(ix, tree, unit);
        if (p) return go({ fold: plus(nav.fold, p), expand: without(nav.expand, p, unit) });
        return go({ hide: plus(nav.hide, unit), show: without(nav.show, unit) });
      }
      case 'open':
        return go({ open: plus(nav.open, unit), fold: without(nav.fold, unit) });
      case 'close':
        return go({ open: without(nav.open, unit), tuck: without(nav.tuck, unit) });
      case 'pin':
        return set({ pins: plus(nav.pins, unit) });
      case 'unpin':
        return set({ pins: without(nav.pins, unit) });
      case 'tuck':
        return go({ tuck: plus(nav.tuck, unit) });
      case 'untuck':
        return go({ tuck: without(nav.tuck, unit) });
      case 'hide':
        return go({ hide: plus(nav.hide, unit), show: without(nav.show, unit), expand: without(nav.expand, unit), ...(nav.sel === unit ? { sel: undefined } : {}) });
    }
  };
  /** Looks at a function: its class on the canvas, its trace in the panel. */
  const lookAt = (fn: string) => {
    const c = ix?.fn.get(fn)?.cls;
    if (c && canvas && !canvas.units.some(u => u.id === canvas.where.get(c) && (u.role === 'focus' || u.parent))) go({ focus: [c], changes: false, sel: fn, trace: fn, up: false, def: undefined });
    else set({ sel: fn, trace: fn, up: false, link: undefined, def: undefined });
  };
  /** A step of the trace clicked: lit on the canvas, its class brought in if it isn't drawn. */
  const stepTo = (id: string) => {
    if (!ix || !canvas) return;
    const c = ownerOf(ix, id);
    setHl(id);
    if (!c) return;
    const w = canvas.where.get(c);
    if (!w || w.startsWith('chip:') || w.startsWith('rail:')) go({ focus: plus(nav.focus, c), sel: nav.sel });
  };

  const toolbar = scopeBar(
    <>
      {lens}
      {ix && <Search ix={ix} onPick={(id, kind) => (kind === 'class' ? act('focus', id) : kind === 'function' ? lookAt(id) : set({ sel: id }))} />}
      <ToggleMenu
        label="Links"
        items={[
          ...KINDS.map(([k, label, title]) => ({
            key: k, title, on: kinds[k], onChange: (v: boolean) => setKind(k, v),
            label: (
              <>
                <span className="kind-mark" style={{ borderColor: KIND_STYLE[k === 'state' ? 'write' : k].stroke, borderStyle: k === 'call' || k === 'new' ? 'solid' : 'dashed' }} />
                {label}
              </>
            ),
          })),
          { key: 'changes', label: 'Changes in this scope', title: 'Changes in this scope: mark what it added, changed or removed in how the code runs', on: showChange, onChange: setShowChange },
        ]}
      />
      {ix && <Coverage ix={ix} />}
      {gs.loading && ix && <span className="muted small nowrap reading">reading this scope…</span>}
      <PanelButton open={side} onToggle={() => (side ? closeSide() : locked ? onCommitPanel(true) : onPanel(true))} />
    </>,
  );

  if (gs.error) return withToolbar(toolbar, <div className="empty warn-text">{gs.error}</div>);
  if (!ix || !tree || !canvas) return withToolbar(toolbar, <div className="empty">Reading how the code runs…</div>);
  if (!ix.g.classes.length) {
    return withToolbar(toolbar, <div className="empty">No code here that MetaHarness can follow yet. The Systems lens reads GDScript for now (a language pack with a code reader); the Areas lens still shows every file.</div>);
  }
  // A heading naming more than its path (`## scripts/core/ + scripts/main.gd`) leaves a path for a title: the folder's name reads better.
  const titles = new Map(snap.map.areas.map(a => [a.path, a.title.includes('/') ? a.path.split('/').pop() || a.path : a.title]));
  const summaries = new Map(snap.map.areas.map(a => [a.path, a.summary]));
  const sel = nav.sel;
  const un = (id: string) => unitName(ix, tree, titles, id);
  // Diffs in the panel: over the scope, and in the commit kept lit.
  const range: Range | undefined = view.scope?.from && view.scope.to ? { from: view.scope.from, to: view.scope.to } : undefined;
  const lockRange: Range | undefined = lock ? { from: `${lock}^1`, to: lock } : undefined;
  const lockLabel = lock ? `what ${lock.slice(0, 7)} changed` : '';
  const lockFiles = new Set(lockChg ? [...lockChg.files.added, ...lockChg.files.changed, ...lockChg.files.removed] : []);
  /** A class's code with its edits marked: the commit kept lit's if it touched the file (the file as that commit left it), else the scope's. */
  const classCode = (id: string) => {
    const c = ix.cls.get(id)!;
    const inLock = !!lockRange && lockFiles.has(c.file);
    const r = inLock ? lockRange : range && chg?.touched.has(id) ? range : undefined;
    return (
      <MarkedCode
        key={`${id}\n${r?.to}`} goal={goal.id} rev={r?.to ?? view.scope?.to} path={c.file} range={r}
        lines={inLock || c.kind !== 'inner' ? undefined : [c.line, c.end]} label={inLock ? lockLabel : 'what this scope changed'}
      />
    );
  };
  /** A function's code the same way; at the scope's end its calls link on. */
  const fnCode = (id: string): FnCode => {
    const f = ix.fn.get(id)!;
    const s = lockChg && [...lockChg.symbols.changed, ...lockChg.symbols.added].find(x => x.file === f.file && x.name === f.name && (x.kind === 'function' || x.kind === 'method'));
    if (lockRange && s?.line) return { rev: lock!, range: lockRange, lines: [s.line, symbolEnd(undefined, s)!], label: lockLabel, links: false };
    return { rev: view.scope?.to, range: range && (chg?.edited.has(id) || chg?.newFns.has(id)) ? range : undefined, lines: [f.line, f.end], label: 'what this scope changed', links: true };
  };
  /** The files of some classes that the kept commit or the scope changed, each with its code a click away. */
  const unitFiles = (cs: string[]) => {
    const out = new Map<string, { path: string; range: Range; label: string }>();
    for (const id of cs) {
      const c = ix.cls.get(id);
      if (!c || out.has(c.file)) continue;
      if (lockRange && lockFiles.has(c.file)) out.set(c.file, { path: c.file, range: lockRange, label: lockLabel });
      else if (range && chg?.touched.has(id)) out.set(c.file, { path: c.file, range, label: 'what this scope changed' });
    }
    return <FilesCode key={cs.join()} goal={goal.id} files={[...out.values()]} />;
  };
  const showGone = (f: CodeFn) =>
    range && set({ sel: undefined, link: undefined, def: { file: f.file, name: f.name, kind: 'function', line: f.line, end: f.end, side: 'old', ...range, label: 'Removed in this scope' } });
  return (
    <>
      {toolbar}
      <div className={`design-body${side ? '' : ' no-side'}`}>
        <div className="view">
          {tool === 'trace' ? (
            <TraceView ix={ix} bix={bix} chg={chg} root={nav.trace} up={!!nav.up} sel={sel} onNav={set} onBack={() => set({ tool: 'map' })} />
          ) : nav.link && nav.linkOpen ? (
            <LinkView goal={goal.id} ix={ix} t={tree} links={links} link={nav.link} pick={nav.pick} sel={nav.sel} chg={chg} name={un} onNav={set} />
          ) : (
            <SystemsCanvas
              goal={goal.id} ix={ix} t={tree} canvas={canvas} nav={nav} chg={chg} titles={titles} summaries={summaries} focus={nav.focus ?? []} changeFocus={changeFocus} changesOn={changesOn}
              scopeTitle={view.scope?.title} route={route} hl={hl} lit={lit} litFns={litFns} peekLocked={locked} canBack={hist.current.length > 0} onBack={back} onNav={set} onAct={act} onChanges={on => go({ changes: on })}
            />
          )}
        </div>
        {side && <Splitter pane="design-side" grow="left" min={280} max={820} label="Systems panel" />}
        {side && (
        <aside className="design-side">
          <div className="area-panel scroll">
            {sel && ix.fn.has(sel) ? (
              <FnPanel goal={goal} ix={ix} bix={bix} chg={chg} id={sel} up={!!nav.up} docked={tool !== 'trace'} code={fnCode(sel)} onNav={set} onAct={act} onStep={stepTo} onHover={setHl} />
            ) : sel && ix.cls.has(sel) ? (
              <ClassPanel ix={ix} links={links} chg={chg} id={sel} code={classCode(sel)} onNav={set} onAct={act} onFn={lookAt} />
            ) : sel && tree.group.has(sel) ? (
              <>
                <GroupPanel ix={ix} t={tree} chg={chg} id={sel} titles={titles} onNav={set} onAct={act} />
                {unitFiles(classesIn(ix, tree, sel))}
              </>
            ) : sel && ix.sig.has(sel) ? (
              <SignalPanel ix={ix} id={sel} onNav={set} onFn={lookAt} />
            ) : sel && isArea(sel) ? (
              <>
                <AreaInfo ix={ix} t={tree} snap={snap} area={sel.slice(5)} chg={chg} onNav={set} onAct={act} />
                {unitFiles(classesIn(ix, tree, sel))}
              </>
            ) : nav.def ? (
              <DefPanel goal={goal.id} d={nav.def} onClose={() => set({ def: undefined })} />
            ) : !nav.link && commit ? (
              commit({
                // A function still there: its own panel (its diff at the top); one removed, or another kind of definition: with its diff.
                onDef: d => {
                  const f = d.sign !== '−' && (d.kind === 'function' || d.kind === 'method') ? ix.g.fns.find(x => x.file === d.file && x.name === d.name) : undefined;
                  if (f) return lookAt(f.id);
                  if (lockRange)
                    set({
                      sel: undefined, link: undefined,
                      def: { file: d.file, name: d.name, kind: d.kind, parent: d.parent, line: d.line, end: d.end, side: d.sign === '−' ? 'old' : 'new', ...lockRange, label: `${d.sign === '−' ? 'Removed' : d.sign === '+' ? 'Added' : 'Changed'} in ${lock!.slice(0, 7)}` },
                    });
                },
                onFile: path => {
                  const cs = ix.g.classes.filter(c => c.file === path).map(c => c.id);
                  if (cs.length === 1) act('focus', cs[0]);
                  else if (cs.length) go({ focus: cs, changes: false, sel: cs[0] });
                },
              })
            ) : nav.link ? (
              <LinkPanel ix={ix} t={tree} links={links} link={nav.link} pick={nav.pick} name={un} open={!!nav.linkOpen} onNav={set} onFn={lookAt} />
            ) : (
              <StartPanel
                ix={ix} bix={bix} chg={chg} view={view} onNav={set} onFn={lookAt} onGone={showGone} onAct={act} onPeek={onPeek} onHover={setHl}
                between={meet && focus.length === 2 ? <BetweenPanel ix={ix} res={meet} a={focus[0]} b={focus[1]} bpick={nav.bpick} name={un} onNav={set} onFn={lookAt} /> : undefined}
              />
            )}
          </div>
        </aside>
        )}
      </div>
    </>
  );
}

/** A unit's name: an area's title, a group's name, a class's. */
function unitName(ix: CodeIndex, t: Tree, titles: Map<string, string>, id: string): string {
  if (isArea(id)) return titles.get(id.slice(5)) ?? areaLabel(id.slice(5));
  if (id.startsWith('group:')) return t.group.get(id)?.name ?? id;
  return ix.cls.get(id)?.name ?? id;
}

function withToolbar(toolbar: ReactNode, body: ReactNode) {
  return (
    <>
      {toolbar}
      {body}
    </>
  );
}

function Coverage({ ix }: { ix: CodeIndex }) {
  const s = ix.g.stats;
  const pct = s.calls ? Math.round(((s.resolved + s.guessed) / s.calls) * 100) : 100;
  return (
    <span className="muted small nowrap" title={`${s.resolved} calls followed by their declared types, ${s.guessed} by name only, ${s.unresolved} not followed (their receiver has no type). ${s.files} files read; tests left out.`}>
      {pct}% of {s.calls} calls followed
    </span>
  );
}

function Search({ ix, onPick }: { ix: CodeIndex; onPick: (id: string, kind: 'class' | 'function' | 'signal') => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => searchCode(ix, q, 14), [ix, q]);
  return (
    <div className="sys-search">
      <input
        type="search" className="small" placeholder="Find a class, function or signal…" value={q} aria-label="Find in the code"
        onChange={e => (setQ(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (e.key === 'Enter' && hits[0]) (onPick(hits[0].id, hits[0].kind), setQ(''), setOpen(false));
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && hits.length > 0 && (
        <div className="sys-hits" role="listbox">
          {hits.map(h => (
            <button key={h.kind + h.id} className="def-row" role="option" aria-selected={false} onMouseDown={() => (onPick(h.id, h.kind), setQ(''), setOpen(false))}>
              <span className="sym-kind">{h.kind}</span>
              <span className="mono ellipsis">{h.label}</span>
              <span className="muted small ellipsis def-file">{h.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- a connection on its own ---------------- */

type SysData = {
  id: string;
  title: string;
  sub: string;
  kind: 'class';
  count: string;
  isNew: boolean;
  on: boolean;
};

const NH = 96;

function SysCard({ data: d }: NodeProps<Node<SysData>>) {
  return (
    <div className={['sys-card', d.kind, d.on && 'on', d.isNew && 'added'].filter(Boolean).join(' ')}>
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Top} id="u" />
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Left} id="fl" />
      <div className="area-head">
        <span className="area-title ellipsis">{d.title}</span>
        {d.isNew && <span className="pill done">new</span>}
      </div>
      <div className="mono muted small ellipsis">{d.sub}</div>
      {d.count && <div className="muted small">{d.count}</div>}
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="target" position={Position.Bottom} id="d" />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="target" position={Position.Right} id="fr" />
    </div>
  );
}

const SYS_TYPES = { sys: SysCard };

function handles(a: { x: number; y: number }, b: { x: number; y: number }): { sourceHandle: string; targetHandle: string } {
  if (b.y > a.y) return { sourceHandle: 'b', targetHandle: 't' };
  if (b.y < a.y) return { sourceHandle: 'u', targetHandle: 'd' };
  return b.x > a.x ? { sourceHandle: 'r', targetHandle: 'l' } : { sourceHandle: 'fl', targetHandle: 'fr' };
}

/** A connection of the canvas on its own: the classes on each side and each pair's link, the rest left out. */
function LinkView({ goal, ix, t, links, link, pick, sel, chg, name, onNav }: {
  goal: string;
  ix: CodeIndex;
  t: Tree;
  links: Link[];
  link: NonNullable<SystemsNav['link']>;
  pick?: string;
  sel?: string;
  chg?: CodeChange;
  name: (id: string) => string;
  onNav: (n: Partial<SystemsNav>) => void;
}) {
  const ls = useMemo(() => linksOf(ix, t, links, link), [ix, t, links, link]);
  const computed = useMemo(() => {
    const left = [...new Set(ls.map(l => l.from))].sort((a, b) => (ix.cls.get(a)?.name ?? a).localeCompare(ix.cls.get(b)?.name ?? b));
    const right = [...new Set(ls.map(l => l.to))].sort((a, b) => (ix.cls.get(a)?.name ?? a).localeCompare(ix.cls.get(b)?.name ?? b));
    const added = new Set(chg?.added.map(edgeKey));
    const card = (id: string, side: 'L' | 'R', i: number, n: number, other: number): Node<SysData> => {
      const c = ix.cls.get(id)!;
      const k = ls.filter(l => (side === 'L' ? l.from : l.to) === id).reduce((s, l) => s + l.edges.length, 0);
      return {
        id: `${side}:${id}`, type: 'sys', position: { x: side === 'L' ? 0 : 560, y: (i + Math.max(0, other - n) / 2) * (NH - 6) },
        data: { id, title: c.name, sub: c.file, kind: 'class', count: `${k} ${KIND_STYLE[link.kind].word}`, isNew: !!chg?.newClasses.has(id), on: sel === id },
      };
    };
    const nodes = [...left.map((id, i) => card(id, 'L', i, left.length, right.length)), ...right.map((id, i) => card(id, 'R', i, right.length, left.length))];
    const st = KIND_STYLE[link.kind];
    const edges: Edge[] = ls.map(l => {
      const k = `${l.from}\n${l.to}`;
      const on = pick === k;
      const isNew = l.edges.some(e => added.has(edgeKey(e)));
      const names = [...l.names];
      return {
        id: `${l.from}->${l.to}`, source: `L:${l.from}`, target: `R:${l.to}`, sourceHandle: 'r', targetHandle: 'l', data: { auto: true, pick: k }, interactionWidth: 16,
        label: `${isNew ? 'new · ' : ''}${link.kind === 'signal' ? '⚡ ' : ''}${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`,
        labelStyle: { fill: isNew ? 'var(--accent)' : st.stroke, fontSize: 11, fontWeight: on ? 700 : 400 }, labelBgStyle: { fill: 'var(--panel)' },
        style: { stroke: isNew ? 'var(--accent)' : st.stroke, strokeDasharray: st.dash, strokeWidth: on ? 3 : 1.5, opacity: pick && !on ? 0.2 : 0.9 },
        markerEnd: { type: MarkerType.ArrowClosed, color: isNew ? 'var(--accent)' : st.stroke },
      };
    });
    return { nodes, edges };
  }, [ix, ls, link, pick, sel, chg]);
  const lay = useLayout(`mh.systems.layout.${goal}.link`, computed.nodes, computed.edges);
  return (
    <div className="sys-map">
      <div className="sys-banner">
        <button className="btn ghost small" onClick={() => onNav({ linkOpen: undefined, pick: undefined, sel: undefined })}>
          ← The canvas
        </button>
        <span>
          <b>{name(link.from)}</b> {KIND_STYLE[link.kind].word} <b>{name(link.to)}</b>
        </span>
        <span className="muted small">
          {ls.length} pair{ls.length === 1 ? '' : 's'} of classes · {ls.reduce((s, l) => s + l.edges.length, 0)} {link.kind === 'signal' ? 'emits and handlers' : 'places in the code'}
        </span>
        {lay.moved && (
          <button className="btn ghost small" onClick={lay.reset}>
            Reset layout
          </button>
        )}
      </div>
      {!ls.length ? (
        <div className="empty">Nothing joins them this way any more.</div>
      ) : (
        <ReactFlow
          nodes={lay.nodes}
          edges={lay.edges}
          nodeTypes={SYS_TYPES}
          onNodesChange={lay.onNodesChange}
          onNodeDragStop={lay.onNodeDragStop}
          onNodeClick={(_, n) => onNav({ sel: n.data.id })}
          onEdgeClick={(_, e) => onNav({ pick: pick === e.data?.pick ? undefined : (e.data?.pick as string), sel: undefined })}
          onPaneClick={() => onNav({ sel: undefined, pick: undefined })}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
        >
          <Background gap={20} size={1} color="var(--line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
    </div>
  );
}

/** The inspector for a connection: every place in the code behind it, by pair of classes. */
function LinkPanel({ ix, t, links, link, pick, name, open, onNav, onFn }: {
  ix: CodeIndex;
  t: Tree;
  links: Link[];
  link: NonNullable<SystemsNav['link']>;
  pick?: string;
  name: (id: string) => string;
  open: boolean;
  onNav: (n: Partial<SystemsNav>) => void;
  onFn: (fn: string) => void;
}) {
  const ls = linksOf(ix, t, links, link)
    .filter(l => !pick || `${l.from}\n${l.to}` === pick)
    .sort((a, b) => b.edges.length - a.edges.length);
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">Connection</div>
          <b>
            {name(link.from)} {KIND_STYLE[link.kind].word} {name(link.to)}
          </b>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ link: undefined, linkOpen: undefined, pick: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      <p className="area-text small">
        {pick ? 'One pair of classes. ' : 'Each pair of classes, and every place in the code behind it. '}Click a line to trace the function it's in.
      </p>
      <div className="row-wrap">
        {!open && (
          <button className="btn small" onClick={() => onNav({ linkOpen: true })} title="The classes on each side, an arrow per pair">
            Draw it on its own
          </button>
        )}
        {pick && (
          <button className="text-link small" onClick={() => onNav({ pick: undefined })}>
            Show every pair
          </button>
        )}
      </div>
      {ls.map(l => (
        <div key={l.from + l.to}>
          <div className="section-title">
            <button className="text-link" onClick={() => onNav({ sel: l.from })}>
              {ix.cls.get(l.from)?.name}
            </button>{' '}
            → <button className="text-link" onClick={() => onNav({ sel: l.to })}>
              {ix.cls.get(l.to)?.name}
            </button>{' '}
            <span className="muted">{l.edges.length}</span>
          </div>
          <EdgeList ix={ix} edges={l.edges} onFn={onFn} />
        </div>
      ))}
    </>
  );
}

/* ---------------- dragging ---------------- */

type XY = { x: number; y: number };

function loadLayout(key: string): Record<string, XY> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Where the person dragged each card, kept in the browser per goal and view, over the computed
 * layout. Arrows marked `auto` leave and enter by the sides facing where the cards are now.
 */
function useLayout(key: string, nodes: Node<SysData>[], edges: Edge[]) {
  const moved = useRef<Record<string, XY>>(loadLayout(key));
  const [count, setCount] = useState(() => Object.keys(moved.current).length);
  const place = (ns: Node<SysData>[], old: Node<SysData>[] = []) => {
    // React Flow keeps each card's measured size on its node: a card that loses it is hidden until measured again.
    const prev = new Map(old.map(n => [n.id, n]));
    return ns.map(n => {
      const o = prev.get(n.id);
      return { ...o, ...n, position: moved.current[n.id] ?? n.position, ...(o?.measured ? { measured: o.measured } : {}) };
    });
  };
  const [rf, setRf] = useState<Node<SysData>[]>(() => place(nodes));
  const seen = useRef({ key, nodes });
  useEffect(() => {
    if (seen.current.key === key && seen.current.nodes === nodes) return;
    if (seen.current.key !== key) moved.current = loadLayout(key);
    seen.current = { key, nodes };
    setCount(Object.keys(moved.current).length);
    setRf(old => place(nodes, old));
  }, [key, nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const routed = useMemo(() => {
    const at = new Map(rf.map(n => [n.id, n.position]));
    return edges.map(e => (e.data?.auto && at.has(e.source) && at.has(e.target) ? { ...e, ...handles(at.get(e.source)!, at.get(e.target)!) } : e));
  }, [rf, edges]);
  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(moved.current));
    } catch {
      // Kept for this visit only.
    }
  };
  return {
    nodes: rf,
    edges: routed,
    onNodesChange: (chs: NodeChange<Node<SysData>>[]) => {
      for (const c of chs) if (c.type === 'position' && c.position) moved.current[c.id] = c.position;
      setRf(ns => applyNodeChanges(chs, ns));
    },
    onNodeDragStop: () => (save(), setCount(Object.keys(moved.current).length)),
    moved: count > 0,
    reset: () => {
      moved.current = {};
      save();
      setCount(0);
      setRf(old => place(nodes, old));
    },
  };
}

/** The links behind a connection on the canvas, between what its two cards hold. */
function linksOf(ix: CodeIndex, t: Tree, links: Link[], c: { from: string; to: string; kind: LinkKind }): Link[] {
  const a = new Set(classesIn(ix, t, c.from));
  const b = new Set(classesIn(ix, t, c.to));
  return links.filter(l => l.kind === c.kind && a.has(l.from) && b.has(l.to));
}

/** Where an edge is in the code: the file of the function it starts in (where a handler was connected, for a signal's), and the line. */
function edgeWhere(ix: CodeIndex, e: CodeEdge): string {
  const f = ix.fn.get(e.k === 'listen' ? e.via ?? '' : e.f);
  return f ? `${f.file.split('/').pop()}:${e.l}` : '';
}

/** The function to trace for an edge: its caller, or for a handler, the handler. */
const edgeFn = (e: CodeEdge) => (e.k === 'listen' ? e.t : e.f);

function EdgeList({ ix, edges, onFn }: { ix: CodeIndex; edges: CodeEdge[]; onFn: (fn: string) => void }) {
  return (
    <ul className="edge-list small">
      {edges.slice(0, 200).map(e => (
        <li key={edgeKey(e) + e.via}>
          <button className="text-link sys-sentence" onClick={() => onFn(edgeFn(e))} title="Trace it">
            {edgeSentence(ix, e)}
          </button>
          {e.n && e.n > 1 && <span className="muted"> ×{e.n}</span>}
          <span className="muted mono"> {edgeWhere(ix, e)}</span>
        </li>
      ))}
      {edges.length > 200 && <li className="muted">and {edges.length - 200} more</li>}
    </ul>
  );
}

/* ---------------- trace ---------------- */

const STEP_ICON: Record<Step['kind'], string> = { call: '→', new: '✦', emit: '⚡', listen: '↳', caller: '↑', engine: '⏵' };

/**
 * A function's steps, down into what it does or up to how it's reached. Wide, it takes the
 * canvas's place; docked in the panel, a step clicked lights it on the canvas (drawing its class
 * if it isn't) and a step hovered lights it while hovered.
 */
function TraceView({ ix, bix, chg, root, up, sel, onNav, onBack, docked, onStep, onHover }: {
  ix: CodeIndex;
  bix?: CodeIndex;
  chg?: CodeChange;
  root?: string;
  up: boolean;
  sel?: string;
  onNav: (n: Partial<SystemsNav>) => void;
  onBack?: () => void;
  docked?: boolean;
  onStep?: (id: string) => void;
  onHover?: (id?: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [lit, setLit] = useState<string>();
  useEffect(() => setOpen(new Set()), [root, up]);
  if (!root || !(ix.fn.has(root) || ix.sig.has(root) || ix.cls.has(root))) {
    return (
      <div className="trace-empty">
        {onBack && (
          <button className="btn ghost small" onClick={onBack}>
            ← The canvas
          </button>
        )}
        <p>Pick a function to follow: from the search box, a card's pins, or one of the entry points on the right.</p>
        <p className="muted small">Trace reads like a debugger's step-through: each line a function calls, an object it makes, or a signal it emits, in the order its code does it. Signals continue into the functions that handle them.</p>
      </div>
    );
  }
  const added = new Set(chg?.added.map(edgeKey));
  const rows: ReactNode[] = [];
  const walk = (id: string, step: Step | undefined, key: string, depth: number, path: Set<string>) => {
    const kids = up ? stepsUp(ix, id) : stepsDown(ix, id);
    const loop = path.has(id) && depth > 0;
    const isOpen = depth === 0 || open.has(key);
    const gone = !up && depth >= 0 && chg && ix.fn.has(id) ? chg.removed.filter(e => e.f === id && (e.k === 'call' || e.k === 'new' || e.k === 'emit')) : [];
    rows.push(
      <TraceRow
        key={key} ix={ix} id={id} step={step} depth={depth} loop={loop} kids={loop ? 0 : kids.length + gone.length} open={isOpen} sel={docked ? lit === key : sel === id}
        isNew={!!step?.edge && added.has(edgeKey(step.edge))} edited={!!chg?.edited.has(id) || !!chg?.newFns.has(id)}
        onToggle={() => setOpen(o => {
          const n = new Set(o);
          if (n.has(key)) n.delete(key);
          else n.add(key);
          return n;
        })}
        onSelect={() => (step?.kind === 'engine' ? undefined : docked && onStep ? (setLit(key), onStep(id)) : onNav({ sel: id }))}
        onRoot={() => onNav({ trace: id, sel: id })}
        onHover={onHover}
      />,
    );
    if (loop || !isOpen || depth > 24) return;
    const next = new Set(path).add(id);
    kids.slice(0, 80).forEach((s, i) => {
      if (s.kind === 'engine') rows.push(<div key={`${key}/e`} className="trace-row engine" style={{ paddingLeft: 12 + (depth + 1) * 18 }}><span className="trace-icon">⏵</span> the engine calls it, {engineWhen(ix.fn.get(id)?.name ?? '')}</div>);
      else walk(s.id, s, `${key}/${i}:${s.id}`, depth + 1, next);
    });
    if (kids.length > 80) rows.push(<div key={`${key}/more`} className="trace-row muted small" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>and {kids.length - 80} more</div>);
    for (const e of gone) {
      rows.push(
        <div key={`${key}/gone:${edgeKey(e)}`} className="trace-row gone" style={{ paddingLeft: 12 + (depth + 1) * 18 }} title="Removed in this scope">
          <span className="def-sign del">−</span> <span className="mono">{edgeSentence(bix ?? ix, e, ix).replace(/^.*? (calls|makes a|emits) /, '$1 ')}</span>
        </div>,
      );
    }
  };
  walk(root, undefined, root, 0, new Set());
  return (
    <div className={`trace-view${docked ? ' docked' : ''}`}>
      <div className="trace-head">
        {onBack && (
          <button className="btn ghost small" onClick={onBack} title="Back to the canvas (Esc)">
            ← The canvas
          </button>
        )}
        <div className="seg" role="group" aria-label="Direction">
          <button className={`btn small${!up ? ' on' : ''}`} onClick={() => onNav({ up: false })} title="What it does: the calls, objects and signals in its code, in order">
            ↓ What it does
          </button>
          <button className={`btn small${up ? ' on' : ''}`} onClick={() => onNav({ up: true })} title="How it's reached: who calls it, emits what it handles, or makes its object">
            ↑ How it's reached
          </button>
        </div>
        <button className="btn ghost small" onClick={() => setOpen(new Set(allKeys(ix, root, up, 3)))}>
          Open 3 levels
        </button>
        <button className="btn ghost small" onClick={() => setOpen(new Set())}>
          Fold
        </button>
      </div>
      <div className="trace-rows scroll" onMouseLeave={() => onHover?.(undefined)}>
        {rows}
      </div>
    </div>
  );
}

/** The keys of every row down to a depth, to open them at once. */
function allKeys(ix: CodeIndex, root: string, up: boolean, depth: number): string[] {
  const out: string[] = [];
  const walk = (id: string, key: string, d: number, path: Set<string>) => {
    if (d >= depth || path.has(id)) return;
    out.push(key);
    const next = new Set(path).add(id);
    (up ? stepsUp(ix, id) : stepsDown(ix, id)).slice(0, 80).forEach((s, i) => s.kind !== 'engine' && walk(s.id, `${key}/${i}:${s.id}`, d + 1, next));
  };
  walk(root, root, 0, new Set());
  return out;
}

function TraceRow({ ix, id, step, depth, loop, kids, open, sel, isNew, edited, onToggle, onSelect, onRoot, onHover }: {
  ix: CodeIndex;
  id: string;
  step?: Step;
  depth: number;
  loop: boolean;
  kids: number;
  open: boolean;
  sel: boolean;
  isNew: boolean;
  edited: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onRoot: () => void;
  onHover?: (id?: string) => void;
}) {
  const f = ix.fn.get(id);
  const s = ix.sig.get(id);
  const c = ix.cls.get(id);
  const label = f ? fnLabel(ix, id) : s ? `${ix.cls.get(s.cls)?.name ?? s.cls}.${s.name}` : c ? c.name : id;
  const what = !step ? '' : step.kind === 'new' && !ix.cls.has(id) ? 'made by' : step.kind === 'new' ? 'makes' : step.kind === 'emit' && ix.sig.has(id) ? 'emits' : step.kind === 'emit' ? 'emitted by' : step.kind === 'listen' ? 'handled by' : '';
  const st = f ? stateOf(ix, id) : undefined;
  const at = step?.edge ? (step.kind === 'listen' ? step.edge.via && ix.fn.get(step.edge.via) : ix.fn.get(step.edge.f)) : undefined;
  return (
    <div className={`trace-row${sel ? ' on' : ''}${loop ? ' loop' : ''}${isNew ? ' new' : ''}`} style={{ paddingLeft: 12 + depth * 18 }} onMouseEnter={() => onHover?.(id)}>
      <button className="trace-toggle" onClick={onToggle} disabled={!kids || depth === 0} aria-label={open ? 'Fold' : 'Open'} aria-expanded={open}>
        {kids && depth > 0 ? (open ? '▾' : '▸') : ''}
      </button>
      <span className="trace-icon" title={step?.kind}>{step ? STEP_ICON[step.kind] : '◉'}</span>
      {what && <span className="muted small">{what}</span>}
      <button className={`text-link mono trace-label${s ? ' sig' : ''}`} onClick={onSelect} onDoubleClick={onRoot} title={f?.doc ? `${f.doc}\n\nClick to show it on the canvas · double-click to trace from here` : 'Click to show it on the canvas · double-click to trace from here'}>
        {label}
        {f && '()'}
      </button>
      {isNew && <span className="pill done">new</span>}
      {edited && <span className="pill chg" title="Its code changed in this scope">edited</span>}
      {step?.edge?.g && <span className="pill" title="Followed by its name only: the receiver's type isn't declared">by name</span>}
      {f?.mut && <span className="trace-mut" title="Changes its own object's state">✎</span>}
      {f?.engine && <span className="pill" title={engineWhen(f.name)}>engine</span>}
      {loop && <span className="muted small">↺ already above</span>}
      {st && (st.writes.length > 0 || st.reads.length > 0) && (
        <span className="muted small trace-state" title={[...st.writes.map(e => `writes ${e.t}`), ...st.reads.map(e => `reads ${e.t}`)].slice(0, 30).join('\n')}>
          {st.writes.length > 0 && <span className="w">writes {st.writes.length}</span>} {st.reads.length > 0 && <span>reads {st.reads.length}</span>}
        </span>
      )}
      {!!kids && !open && depth > 0 && <span className="muted small">· {kids} step{kids === 1 ? '' : 's'}</span>}
      {at && step?.edge && <span className="muted small trace-at mono">{at.file.split('/').pop()}:{step.edge.l}</span>}
    </div>
  );
}

/* ---------------- two systems looked at ---------------- */

const meetWord = (how: Meeting['how'], a: string, b: string) => (how === 'a⇒b' ? `${a} ⇒ ${b}` : how === 'b⇒a' ? `${b} ⇒ ${a}` : how === 'both' ? 'both ways' : 'both read it');

/** With two systems looked at: what's straight between them, and the classes where they meet, by the way influence runs. */
function BetweenPanel({ ix, res, a, b, bpick, name, onNav, onFn }: { ix: CodeIndex; res: BetweenRes; a: string; b: string; bpick?: string; name: (id: string) => string; onNav: (n: Partial<SystemsNav>) => void; onFn: (fn: string) => void }) {
  const an = name(a);
  const bn = name(b);
  const touchLine = (t: Touch) => (
    <li key={t.fn + t.target + t.kind}>
      <button className="text-link mono" onClick={() => onFn(t.fn)}>
        {fnLabel(ix, t.fn)}
      </button>{' '}
      <span className="muted">{t.kind}</span> <span className="mono">{ix.fn.has(t.target) ? fnLabel(ix, t.target) + '()' : ix.field.has(t.target) ? `${ix.field.get(t.target)!.cls}.${ix.field.get(t.target)!.name}` : t.target}</span>
    </li>
  );
  return (
    <>
      <div className="kicker">Two systems</div>
      <b>
        {an} and {bn}
      </b>
      {bpick && <PickedConnection ix={ix} res={res} pick={bpick} an={an} bn={bn} onNav={onNav} onFn={onFn} />}
      <p className="area-text small">
        Influence runs from what changes something to what reads it. When {an} changes a class that {bn} reads, {an} reaches {bn} through it, even if they never call each other. The canvas draws each class where they meet on its own.
      </p>
      {(res.ab.length > 0 || res.ba.length > 0) && <div className="section-title">Straight between them</div>}
      {[...res.ab, ...res.ba].map(l => (
        <div key={l.kind + l.from + l.to} className="small">
          <b>{ix.cls.get(l.from)?.name}</b> {KIND_STYLE[l.kind].word} <b>{ix.cls.get(l.to)?.name}</b>: <span className="mono">{[...l.names].slice(0, 6).join(', ')}</span>
          <ul className="changes small">
            {l.edges.filter(e => e.k !== 'listen').slice(0, 6).map(e => (
              <li key={edgeKey(e)}>
                <button className="text-link sys-sentence" onClick={() => onFn(e.f)}>
                  {edgeSentence(ix, e)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="section-title">Where they meet</div>
      {res.meetings.map(m => (
        <details key={m.mid} className="meeting" open={m.how !== 'shared' && res.meetings.indexOf(m) < 4}>
          <summary>
            <button className="text-link" onClick={() => onNav({ sel: m.mid })}>
              <b>{ix.cls.get(m.mid)?.name}</b>
            </button>{' '}
            <span className={`pill${m.how === 'shared' ? '' : ' decision'}`}>{meetWord(m.how, an, bn)}</span>
          </summary>
          {m.a.length > 0 && (
            <>
              <div className="muted small">{an}:</div>
              <ul className="changes small">{dedupe(m.a).slice(0, 8).map(touchLine)}</ul>
            </>
          )}
          {m.b.length > 0 && (
            <>
              <div className="muted small">{bn}:</div>
              <ul className="changes small">{dedupe(m.b).slice(0, 8).map(touchLine)}</ul>
            </>
          )}
        </details>
      ))}
      {!res.meetings.length && <div className="muted small">Nothing in between.</div>}
    </>
  );
}

type BetweenRes = ReturnType<typeof between>;

/** A connection picked between two systems: every place in the code behind it. */
function PickedConnection({ ix, res, pick, an, bn, onNav, onFn }: { ix: CodeIndex; res: BetweenRes; pick: string; an: string; bn: string; onNav: (n: Partial<SystemsNav>) => void; onFn: (fn: string) => void }) {
  const [side, kind, mid] = pick.split('|');
  let title: string;
  let edges: CodeEdge[];
  if (side === 'ab' || side === 'ba') {
    const ls = (side === 'ab' ? res.ab : res.ba).filter(l => l.kind === kind);
    title = `${side === 'ab' ? an : bn} ${KIND_STYLE[kind as LinkKind]?.word ?? kind} ${side === 'ab' ? bn : an}`;
    edges = ls.flatMap(l => l.edges);
  } else {
    const m = res.meetings.find(x => x.mid === mid);
    const ts = dedupe((side === 'a' ? m?.a : m?.b) ?? []).filter(t => t.kind === kind);
    title = `${side === 'a' ? an : bn} ${kind} ${ix.cls.get(mid)?.name ?? mid}`;
    edges = ts.map(t => t.edge);
  }
  return (
    <div className="picked">
      <div className="row-wrap">
        <span className="kicker">Connection</span>
        <button className="btn ghost small" onClick={() => onNav({ bpick: undefined })} aria-label="Close the connection">
          ✕
        </button>
      </div>
      <b>{title}</b>
      <EdgeList ix={ix} edges={edges} onFn={onFn} />
    </div>
  );
}

const dedupe = (ts: Touch[]) => {
  const seen = new Set<string>();
  return ts.filter(t => !seen.has(t.fn + t.target + t.kind) && seen.add(t.fn + t.target + t.kind));
};

/* ---------------- the inspector ---------------- */

type ActFn = (a: Act, unit: string) => void;

/** Look at it, add it to what's looked at, split it: the buttons a unit's panel starts with. */
function UnitActs({ id, onAct, split }: { id: string; onAct: ActFn; split?: boolean }) {
  return (
    <div className="row-wrap">
      <button className="btn small" onClick={() => onAct('focus', id)} title="Draw it in full, with what's one step from it (double-click on the canvas)">
        Look at it
      </button>
      <button className="btn ghost small" onClick={() => onAct('add', id)} title="Keep what's looked at, and add this (shift-click on the canvas). Two systems looked at show where they meet.">
        Add to what's looked at
      </button>
      {split && (
        <button className="btn ghost small" onClick={() => onAct('expand', id)} title="Split its card into what it holds">
          Split it
        </button>
      )}
    </div>
  );
}

/** The panel with nothing selected: what the scope changed first, where two systems looked at meet, then where the game starts. */
function StartPanel({ ix, bix, chg, view, between, onNav, onFn, onGone, onAct, onPeek, onHover }: {
  between?: ReactNode;
  onGone: (f: CodeFn) => void;
  ix: CodeIndex;
  bix?: CodeIndex;
  chg?: CodeChange;
  view: DesignScopeView;
  onNav: (n: Partial<SystemsNav>) => void;
  onFn: (fn: string) => void;
  onAct: ActFn;
  onPeek: (paths?: string[]) => void;
  onHover: (id?: string) => void;
}) {
  const groups = new Map<string, string[]>();
  for (const id of ix.entries) {
    const f = ix.fn.get(id)!;
    const c = ix.cls.get(f.cls)!;
    const g = c.main ? 'The main scene' : c.kind === 'autoload' ? 'Autoloads (always there)' : engineWhen(f.name).replace(/^./, x => x.toUpperCase());
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const order = ['The main scene', 'Autoloads (always there)', 'Every physics tick', 'Every frame', 'On input nothing else took', 'On any input', 'On input over it', 'When it enters the scene', 'When it redraws'];
  const keys = [...groups.keys()].sort((x, y) => (order.indexOf(x) + 1 || 99) - (order.indexOf(y) + 1 || 99));
  const s = ix.g.stats;
  return (
    <>
      {chg && <CodeChanges ix={ix} bix={bix} chg={chg} title={view.scope?.title} onNav={onNav} onFn={onFn} onGone={onGone} onAct={onAct} onHover={onHover} />}
      <ChangedFiles
        files={view.report?.files ?? []} onPeek={onPeek}
        onFile={(_, path) => {
          // A file clicked: look at its classes.
          const cs = ix.g.classes.filter(c => c.file === path).map(c => c.id);
          if (cs.length === 1) onAct('focus', cs[0]);
          else if (cs.length) onNav({ focus: cs, changes: false, sel: cs[0] });
        }}
      />
      {between}
      <details className="more" open={!chg && !view.report?.files.length}>
      <summary className="section-title">Where the game starts</summary>
      <p className="area-text small">
        The engine runs the main scene's script and the autoloads, then calls these callbacks on every node in the tree. Pick one to see its class and trace what happens from there. Double-click a card to look at it: it's drawn in full with what's one step from it, the rest folded into chips.
      </p>
      {keys.map(k => (
        <details key={k} className="meeting" open={k === 'The main scene' || k === 'Every physics tick' || k === 'Autoloads (always there)'}>
          <summary>
            {k} <span className="muted small">{groups.get(k)!.length}</span>
          </summary>
          <ul className="changes small">
            {groups.get(k)!.slice(0, 40).map(id => (
              <li key={id}>
                <button className="text-link mono" onClick={() => onFn(id)}>
                  {fnLabel(ix, id)}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
      </details>
      <details className="more">
        <summary className="section-title">What it could follow</summary>
        <div className="small">
          {s.files} files read (tests and add-ons left out). Of {s.calls} calls into the project, {s.resolved} were followed by their declared types and {s.guessed} by name only; {s.unresolved} weren't, as their receiver has no type.
        </div>
        {s.missed.length > 0 && (
          <>
            <div className="muted small">Typing these would let it follow more:</div>
            <ul className="changes small">
              {s.missed.slice(0, 15).map(m => (
                <li key={m.chain} className="mono">
                  {m.chain} ×{m.n}
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </>
  );
}

function CodeChanges({ ix, bix, chg, title, onFn, onGone, onAct, onHover }: { ix: CodeIndex; bix?: CodeIndex; chg: CodeChange; title?: string; onNav: (n: Partial<SystemsNav>) => void; onFn: (fn: string) => void; onGone: (f: CodeFn) => void; onAct: ActFn; onHover: (id?: string) => void }) {
  const [allFns, setAllFns] = useState(false);
  const fnRows: { sign: '+' | '~' | '−'; id: string; gone?: CodeFn }[] = [
    ...[...chg.newFns].map(id => ({ sign: '+' as const, id })),
    ...[...chg.edited].filter(id => !chg.newFns.has(id)).map(id => ({ sign: '~' as const, id })),
    ...chg.goneFns.map(f => ({ sign: '−' as const, id: f.id, gone: f })),
  ];
  const cross = (e: CodeEdge, g: CodeIndex) => {
    const a = g.fn.get(e.f)?.cls ?? g.sig.get(e.f)?.cls;
    const b = g.fn.get(e.t)?.cls ?? g.sig.get(e.t)?.cls ?? g.field.get(e.t)?.cls ?? (e.k === 'new' ? e.t : undefined);
    return a !== b;
  };
  const weight = { emit: 0, listen: 0, new: 1, call: 2, write: 3, read: 4 };
  const added = chg.added.filter(e => cross(e, ix)).sort((x, y) => weight[x.k] - weight[y.k]);
  const removed = chg.removed.filter(e => bix && cross(e, bix)).sort((x, y) => weight[x.k] - weight[y.k]);
  const total = chg.added.length + chg.removed.length + chg.newClasses.size + chg.goneClasses.length + chg.edited.size;
  return (
    <>
      <div className="section-title">How this scope changed what runs</div>
      {title && <div className="muted small ellipsis">{title}</div>}
      {!total ? (
        <div className="muted small">Nothing in how the code runs changed here.</div>
      ) : (
        <ul className="changes small">
          {[...chg.newClasses].map(id => (
            <li key={'nc' + id}>
              <span className="def-sign add">+</span> class{' '}
              <button className="text-link mono" onClick={() => onAct('focus', id)} onMouseEnter={() => onHover(id)} onMouseLeave={() => onHover(undefined)}>
                {ix.cls.get(id)?.name}
              </button>
            </li>
          ))}
          {chg.goneClasses.map(c => (
            <li key={'gc' + c.id}>
              <span className="def-sign del">−</span> class <span className="mono">{c.name}</span>
            </li>
          ))}
          {[...chg.newSignals].map(id => (
            <li key={'ns' + id}>
              <span className="def-sign add">+</span> signal <span className="mono">{ix.sig.get(id)?.name}</span> on {ix.sig.get(id)?.cls}
            </li>
          ))}
          {added.slice(0, 14).map(e => (
            <li key={'a' + edgeKey(e)}>
              <span className="def-sign add">+</span>{' '}
              <button className="text-link sys-sentence" onClick={() => onFn(e.k === 'listen' ? e.t : e.f)} onMouseEnter={() => onHover(e.k === 'listen' ? e.t : e.f)} onMouseLeave={() => onHover(undefined)}>
                {edgeSentence(ix, e)}
              </button>
            </li>
          ))}
          {removed.slice(0, 8).map(e => (
            <li key={'r' + edgeKey(e)}>
              <span className="def-sign del">−</span> {edgeSentence(bix!, e)}
            </li>
          ))}
          <li className="muted">
            {chg.added.length} links added, {chg.removed.length} removed; {chg.edited.size} functions edited, {chg.newFns.size} new, {chg.goneFns.length} gone
          </li>
        </ul>
      )}
      {fnRows.length > 0 && (
        <>
          <div className="section-title">
            Functions it changed <span className="muted">{fnRows.length}</span>
          </div>
          <ul className="changes small">
            {(allFns ? fnRows : fnRows.slice(0, 20)).map(r => (
              <li key={r.sign + r.id}>
                <span className={`def-sign ${r.sign === '+' ? 'add' : r.sign === '−' ? 'del' : 'chg'}`}>{r.sign}</span>{' '}
                <button
                  className="text-link mono" title={r.gone ? 'Removed: see what it was, in its diff' : 'Its panel: its diff first'}
                  onClick={() => (r.gone ? onGone(r.gone) : onFn(r.id))} onMouseEnter={() => !r.gone && onHover(r.id)} onMouseLeave={() => onHover(undefined)}
                >
                  {r.gone ? (bix ? fnLabel(bix, r.id) : r.gone.name) : fnLabel(ix, r.id)}()
                </button>
              </li>
            ))}
          </ul>
          {fnRows.length > 20 && (
            <button className="text-link small" onClick={() => setAllFns(a => !a)}>
              {allFns ? 'Fewer' : `All ${fnRows.length}`}
            </button>
          )}
        </>
      )}
    </>
  );
}

/** Changed files, each opening to its code with the edits marked. */
function FilesCode({ goal, files }: { goal: string; files: { path: string; range: Range; label: string }[] }) {
  const [open, setOpen] = useState<string>();
  if (!files.length) return null;
  return (
    <>
      <div className="section-title">
        Changed files <span className="muted">{files.length}</span>
      </div>
      {files.map(f => (
        <div key={f.path}>
          <button className="history-row file-row" onClick={() => setOpen(o => (o === f.path ? undefined : f.path))} title={`Its code, ${f.label} marked`}>
            <span className="grow mono ellipsis">
              {open === f.path ? '▾ ' : '▸ '}
              {f.path}
            </span>
          </button>
          {open === f.path && <MarkedCode goal={goal} rev={f.range.to} path={f.path} range={f.range} label={f.label} />}
        </div>
      ))}
    </>
  );
}

/** A definition the graph here doesn't hold (one removed, or not a function), with its diff. */
function DefPanel({ goal, d, onClose }: { goal: string; d: DefSel; onClose: () => void }) {
  const fn = d.kind === 'function' || d.kind === 'method';
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">
            {d.side === 'old' ? 'Removed' : 'Changed'} {d.kind}
          </div>
          <b className="mono">
            {d.parent ? `${d.parent}.` : ''}
            {d.name}
            {fn ? '()' : ''}
          </b>{' '}
          <span className="mono muted small">
            {d.file}
            {d.line ? `:${d.line}` : ''}
          </span>
        </div>
        <button className="btn ghost small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="muted small">{d.label}</div>
      <div className="section-title">Its code</div>
      <SymbolCode goal={goal} range={{ from: d.from, to: d.to }} path={d.file} lines={d.line ? [d.line, d.end ?? symbolEnd(undefined, { line: d.line, name: d.name, kind: d.kind })!] : undefined} side={d.side} />
    </>
  );
}

function AreaInfo({ ix, t, snap, area, chg, onNav, onAct }: { ix: CodeIndex; t: Tree; snap: DesignSnapshot; area: string; chg?: CodeChange; onNav: (n: Partial<SystemsNav>) => void; onAct: ActFn }) {
  const a = snap.map.areas.find(x => x.path === area);
  const cs = [...(ix.classesOf.get(area) ?? [])].sort((x, y) => (ix.fnsOf.get(y.id)?.length ?? 0) - (ix.fnsOf.get(x.id)?.length ?? 0));
  const groups = t.groups.get(area);
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">Area</div>
          <b>{a?.title ?? areaLabel(area)}</b> <span className="mono muted small">{area || '(top level)'}</span>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ sel: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      {a?.summary && <p className="area-text">{a.summary}</p>}
      <UnitActs id={areaNode(area)} onAct={onAct} split />
      {groups ? (
        <>
          <div className="section-title">Groups</div>
          <p className="muted small">
            {groups.some(g => g.declared) ? 'Named in ARCHITECTURE.md’s Systems section, the rest grouped by how their classes link.' : 'Grouped by how their classes link. Name them in ARCHITECTURE.md’s Systems section to say what each does.'}
          </p>
          <ul className="defs">
            {groups.map(g => (
              <li key={g.id}>
                <button className="def-row" onClick={() => onNav({ sel: g.id })} title={g.text}>
                  <span className="ellipsis">{g.name}</span>
                  {g.classes.some(c => chg?.touched.has(c)) && <span className="pill chg">changed</span>}
                  <span className="muted small def-file">{g.classes.length}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="section-title">Classes</div>
          <ClassList ix={ix} cs={cs.map(c => c.id)} chg={chg} onNav={onNav} />
        </>
      )}
    </>
  );
}

function ClassList({ ix, cs, chg, onNav }: { ix: CodeIndex; cs: string[]; chg?: CodeChange; onNav: (n: Partial<SystemsNav>) => void }) {
  return (
    <ul className="defs">
      {cs.map(id => {
        const c = ix.cls.get(id)!;
        return (
          <li key={id}>
            <button className="def-row" onClick={() => onNav({ sel: id })} title={c.doc}>
              <span className="mono ellipsis">{c.name}</span>
              {chg?.touched.has(id) && <span className="pill chg">changed</span>}
              <span className="muted small def-file">{ix.fnsOf.get(id)?.length ?? 0} fn</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function GroupPanel({ ix, t, chg, id, titles, onNav, onAct }: { ix: CodeIndex; t: Tree; chg?: CodeChange; id: string; titles: Map<string, string>; onNav: (n: Partial<SystemsNav>) => void; onAct: ActFn }) {
  const g = t.group.get(id)!;
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">Group</div>
          <b>{g.name}</b> <span className="muted small">in {titles.get(g.area) ?? areaLabel(g.area)}</span>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ sel: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      {g.text && <p className="area-text">{g.text}</p>}
      <p className="muted small">
        {g.declared
          ? 'Named in ARCHITECTURE.md’s Systems section.'
          : `Grouped by MetaHarness from how its classes link${g.hub ? `, around ${ix.cls.get(g.hub)?.name}` : ''}. The cartographer can name it in ARCHITECTURE.md’s Systems section: “- Name (ClassA, ClassB) — what it does”.`}
      </p>
      <UnitActs id={id} onAct={onAct} split={g.classes.length > 1} />
      <div className="section-title">Classes</div>
      <ClassList ix={ix} cs={g.classes} chg={chg} onNav={onNav} />
    </>
  );
}

function ClassPanel({ ix, links, chg, id, code, onNav, onAct, onFn }: { ix: CodeIndex; links: Link[]; chg?: CodeChange; id: string; code?: ReactNode; onNav: (n: Partial<SystemsNav>) => void; onAct: ActFn; onFn: (fn: string) => void }) {
  const c = ix.cls.get(id)!;
  const fns = [...(ix.fnsOf.get(id) ?? [])].sort((a, b) => Number(!!b.engine) - Number(!!a.engine) || a.line - b.line);
  const outs = links.filter(l => l.from === id);
  const ins = links.filter(l => l.to === id);
  const group = (ls: Link[]) => {
    const by = new Map<LinkKind, Link[]>();
    for (const l of ls) by.set(l.kind, [...(by.get(l.kind) ?? []), l]);
    return by;
  };
  const OUT_WORDS: Record<LinkKind, string> = { call: 'Calls', signal: 'Its signals reach', new: 'Makes', read: 'Reads the state of', write: 'Writes the state of' };
  const IN_WORDS: Record<LinkKind, string> = { call: 'Called by', signal: 'Hears signals from', new: 'Made by', read: 'Its state is read by', write: 'Its state is written by' };
  const list = (by: Map<LinkKind, Link[]>, words: Record<LinkKind, string>, side: 'to' | 'from') =>
    (['call', 'signal', 'new', 'write', 'read'] as LinkKind[]).filter(k => by.has(k)).map(k => (
      <div key={side + k} className="small sys-links">
        <span className="muted">{words[k]}</span>{' '}
        {by.get(k)!.sort((x, y) => y.edges.length - x.edges.length).map((l, i) => (
          <span key={l[side]}>
            {i > 0 && ', '}
            <button className="text-link" onClick={() => onNav({ sel: l[side] })} title={[...l.names].slice(0, 12).join(', ')}>
              {ix.cls.get(l[side])?.name}
            </button>
            <span className="muted"> {l.edges.length}</span>
          </span>
        ))}
      </div>
    ));
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">{c.kind === 'autoload' ? 'Autoload' : c.main ? 'Main scene script' : c.kind === 'inner' ? 'Inner class' : 'Class'}</div>
          <b>{c.name}</b> <span className="mono muted small">{c.file}</span>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ sel: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="muted small">
        {c.ext ? `extends ${ix.cls.get(c.ext)?.name ?? c.ext}` : c.base ? `extends ${c.base}` : ''} · in {areaLabel(c.area)}
      </div>
      {c.doc && <p className="area-text doc-text">{c.doc}</p>}
      <UnitActs id={id} onAct={onAct} />
      <button className="text-link small" onClick={() => onNav({ tool: 'trace', trace: id, up: true, sel: id })} title="Who makes its objects">
        ↑ Who makes it
      </button>
      <div className="section-title">Its code</div>
      {code}
      <div className="section-title">Links</div>
      {list(group(outs), OUT_WORDS, 'to')}
      {list(group(ins), IN_WORDS, 'from')}
      {!outs.length && !ins.length && <div className="muted small">It doesn't link to other classes.</div>}
      <div className="section-title">Functions</div>
      <ul className="defs">
        {fns.map(f => (
          <li key={f.id}>
            <button className="def-row" onClick={() => onFn(f.id)} title={f.doc ? `${f.doc}\n\nTrace it` : 'Trace it'}>
              <span className="mono ellipsis">{f.name}</span>
              {f.engine && <span className="pill" title={engineWhen(f.name)}>⏵ {engineWhen(f.name)}</span>}
              {f.mut && <span className="muted small">changes state</span>}
              {(chg?.edited.has(f.id) || chg?.newFns.has(f.id)) && <span className={`pill ${chg?.newFns.has(f.id) ? 'done' : 'chg'}`}>{chg?.newFns.has(f.id) ? 'new' : 'edited'}</span>}
              <span className="muted small def-file">:{f.line}</span>
            </button>
          </li>
        ))}
      </ul>
      {ix.g.signals.some(s => s.cls === id) && (
        <>
          <div className="section-title">Signals</div>
          <ul className="defs">
            {ix.g.signals.filter(s => s.cls === id).map(s => (
              <li key={s.id}>
                <button className="def-row" onClick={() => onNav({ sel: s.id })}>
                  <span className="mono">⚡ {s.name}</span>
                  <span className="muted small def-file">
                    {(ix.into.get(s.id) ?? []).filter(e => e.k === 'emit').length} emit · {(ix.out.get(s.id) ?? []).filter(e => e.k === 'listen').length} listen
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function SignalPanel({ ix, id, onNav, onFn }: { ix: CodeIndex; id: string; onNav: (n: Partial<SystemsNav>) => void; onFn: (fn: string) => void }) {
  const s = ix.sig.get(id)!;
  const emits = (ix.into.get(id) ?? []).filter(e => e.k === 'emit');
  const listens = (ix.out.get(id) ?? []).filter(e => e.k === 'listen');
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">Signal</div>
          <b className="mono">
            ⚡ {ix.cls.get(s.cls)?.name}.{s.name}
          </b>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ sel: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      <button className="btn ghost small" onClick={() => onNav({ tool: 'trace', trace: id, sel: id, up: false })}>
        Trace what it sets off
      </button>
      <div className="section-title">Emitted by</div>
      <ul className="changes small">
        {emits.map(e => (
          <li key={e.f}>
            <button className="text-link mono" onClick={() => onFn(e.f)}>
              {fnLabel(ix, e.f)}
            </button>
            <span className="muted"> :{e.l}</span>
          </li>
        ))}
        {!emits.length && <li className="muted">Nothing in the project emits it.</li>}
      </ul>
      <div className="section-title">Handled by</div>
      <ul className="changes small">
        {listens.map(e => (
          <li key={e.t + e.via}>
            <button className="text-link mono" onClick={() => onFn(e.t)}>
              {e.lam ? `a function in ${fnLabel(ix, e.t)}` : fnLabel(ix, e.t)}
            </button>
            {e.via && e.via !== e.t && <span className="muted"> · connected in {fnLabel(ix, e.via)}</span>}
          </li>
        ))}
        {!listens.length && <li className="muted">Nothing in the project connects to it.</li>}
      </ul>
    </>
  );
}

/** A function: its doc, its trace (docked, synced with the canvas), how the engine gets there, what it touches, its code. */
/** Which code a function's panel shows, and whose edits it marks. */
type FnCode = { rev?: string; range?: Range; lines: [number, number]; label: string; links: boolean };

function FnPanel({ goal, ix, bix, chg, id, up, docked, code, onNav, onAct, onStep, onHover }: {
  goal: Goal;
  /** Its code, and the edits marked on it. */
  code: FnCode;
  ix: CodeIndex;
  bix?: CodeIndex;
  chg?: CodeChange;
  id: string;
  up: boolean;
  docked: boolean;
  onNav: (n: Partial<SystemsNav>) => void;
  onAct: ActFn;
  onStep: (id: string) => void;
  onHover: (id?: string) => void;
}) {
  const f = ix.fn.get(id)!;
  const c = ix.cls.get(f.cls)!;
  const stacks = useMemo(() => stacksTo(ix, id), [ix, id]);
  const st = stateOf(ix, id);
  const byLine = new Map<number, CodeEdge[]>();
  for (const e of ix.out.get(id) ?? []) if (e.k === 'call' || e.k === 'new' || e.k === 'emit') byLine.set(e.l, [...(byLine.get(e.l) ?? []), e]);
  const go = (to: string) => onNav({ trace: to, sel: to, up: false });
  const fieldName = (e: CodeEdge) => {
    const x = ix.field.get(e.t);
    return x ? `${ix.cls.get(x.cls)?.name ?? x.cls}.${x.name}` : e.t;
  };
  return (
    <>
      <div className="area-panel-head">
        <div>
          <div className="kicker">Function</div>
          <b className="mono">{fnLabel(ix, id)}()</b> <span className="mono muted small">{f.file}:{f.line}</span>
        </div>
        <button className="btn ghost small" onClick={() => onNav({ sel: undefined })} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="row-wrap small">
        {f.engine && <span className="pill">⏵ engine: {engineWhen(f.name)}</span>}
        {f.static && <span className="pill">static</span>}
        {f.mut && <span className="pill" title="It, or a method of its own it calls, assigns its object's variables">changes {c.name}'s state</span>}
        {chg?.newFns.has(id) && <span className="pill done">new in this scope</span>}
        {chg?.edited.has(id) && !chg.newFns.has(id) && <span className="pill chg">edited in this scope</span>}
      </div>
      {f.doc && <p className="area-text doc-text">{f.doc}</p>}
      <MarkedCode
        key={`${id}\n${code.rev}`} goal={goal.id} rev={code.rev} path={f.file} range={code.range} lines={code.lines} label={code.label}
        lineClass={n => (code.links && byLine.has(n) ? 'calls' : undefined)}
        extra={n => {
          const es = code.links ? byLine.get(n) : undefined;
          return (
            es && (
              <span className="code-go">
                {es.slice(0, 3).map(e => (
                  <button key={e.t} className="text-link" onClick={() => go(e.t)} onMouseEnter={() => onHover(e.t)} onMouseLeave={() => onHover(undefined)} title={edgeSentence(ix, e)}>
                    {e.k === 'emit' ? '⚡' : e.k === 'new' ? '✦' : '→'} {ix.fn.get(e.t)?.name ?? ix.sig.get(e.t)?.name ?? ix.cls.get(e.t)?.name ?? e.t}
                  </button>
                ))}
              </span>
            )
          );
        }}
      />
      <div className="row-wrap">
        <button className="btn ghost small" onClick={() => onAct('focus', c.id)}>
          Look at {c.name}
        </button>
        {docked && (
          <button className="btn ghost small" onClick={() => onNav({ tool: 'trace', trace: id })} title="The trace in place of the canvas">
            Trace it wide
          </button>
        )}
      </div>
      {docked && (
        <>
          <div className="section-title">Step by step</div>
          <p className="muted small">Click a step to light it on the canvas (its class is drawn if it isn't); double-click to trace from there.</p>
          <TraceView ix={ix} bix={bix} chg={chg} root={id} up={up} onNav={onNav} docked onStep={onStep} onHover={onHover} />
        </>
      )}
      <div className="section-title">How the engine gets here</div>
      {stacks.length ? (
        stacks.map((s, i) => (
          <div key={i} className="call-stack small">
            {s.frames.map((fr, j) => (
              <div key={j} className="stack-frame" style={{ paddingLeft: j * 10 }} onMouseEnter={() => onHover(fr)} onMouseLeave={() => onHover(undefined)}>
                {j > 0 && <span className="muted">{s.via[j - 1] === 'emit' ? '⚡' : s.via[j - 1] === 'new' ? '✦' : '→'} </span>}
                <button className="text-link mono" onClick={() => onStep(fr)} onDoubleClick={() => go(fr)}>
                  {fnLabel(ix, fr)}
                </button>
                {j === 0 && ix.fn.get(fr)?.engine && <span className="muted"> ({engineWhen(ix.fn.get(fr)!.name)})</span>}
              </div>
            ))}
          </div>
        ))
      ) : (
        <div className="muted small">No path from an engine callback found: it may be called through something MetaHarness can't follow (an untyped receiver, a string, a scene).</div>
      )}
      {(st.writes.length > 0 || st.reads.length > 0) && (
        <>
          <div className="section-title">State of other classes it touches</div>
          {st.writes.length > 0 && (
            <div className="small">
              <span className="w">writes</span> <span className="mono">{[...new Set(st.writes.map(fieldName))].join(', ')}</span>
            </div>
          )}
          {st.reads.length > 0 && (
            <div className="small">
              <span className="muted">reads</span> <span className="mono">{[...new Set(st.reads.map(fieldName))].slice(0, 40).join(', ')}</span>
            </div>
          )}
        </>
      )}
    </>
  );
}
