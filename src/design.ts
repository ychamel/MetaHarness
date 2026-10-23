import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import * as git from './git.ts';
import { packFor, resolveContext, resolveImport, type FileOutline, type LanguagePack, type Outliner, type Symbol } from './languages.ts';
import { parseMap } from './rules.ts';

/**
 * The Design view's data (design §14): the code as areas, from the map (ARCHITECTURE.md's path
 * sections) or else from folders; each file's classes, functions and imports, from the language
 * packs; and the dependencies between areas. A snapshot is taken when the goal starts and each
 * time work lands on the goal branch, so the view can show how the design moved. Snapshots live
 * in the goal's folder (design/<sha>.json); outlines are kept by blob, so each snapshot only
 * reads the files that changed.
 */

export const MAP_FILE = 'ARCHITECTURE.md';

export interface Area {
  /** A folder or file path, without a trailing slash; '' for files at the top level. */
  path: string;
  title: string;
  /** The first paragraph of its map section. */
  summary: string;
  /** Not in the map: a folder the map doesn't cover. */
  unmapped?: boolean;
}

export interface DesignFile {
  path: string;
  size: number;
  blob: string;
  area: string;
  lang?: string;
  symbols?: Symbol[];
  /** Repository files it imports. */
  imports?: string[];
}

/** A path data or control takes through the code, as the map's Flows section declares it. */
export interface Flow {
  name: string;
  /** Each step as written, with the area it names when it names one. */
  steps: { label: string; area?: string }[];
  text: string;
}

export interface DesignSnapshot {
  sha: string;
  at: string;
  map: { file: string | null; overview: string; areas: Area[]; flows?: Flow[] };
  files: DesignFile[];
  /** Imports between areas, counted by file. */
  edges: { from: string; to: string; n: number }[];
  /** Files left unread: too many or too large. */
  skipped: number;
  /** Packs that couldn't be loaded. */
  problems: string[];
}

export interface SnapshotInfo {
  sha: string;
  at: string;
  kind: 'start' | 'landed' | 'asked';
  by?: string[];
  summaries?: string[];
  change?: ChangeSummary;
}

const MAX_FILES = 5000;
const MAX_BYTES = 256 * 1024;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.git)\/|\.min\.(js|css)$|\.lock$|-lock\.json$/;

/* ---------------- areas ---------------- */

/** Areas from the map's path sections; files outside them fall into their top folder, marked unmapped. */
export function mapAreas(text: string, cwd: string): { overview: string; areas: Area[] } {
  const doc = parseMap(text, cwd);
  const areas = doc.sections.map(s => {
    const [heading = '', ...rest] = s.text.split('\n');
    const title = heading.replace(/^#+\s*/, '').replace(/[`*_]/g, '').trim().slice(s.path.length).replace(/^\/?\s*[-—–:·]*\s*/, '').trim();
    const para = rest.join('\n').trim().split(/\n\s*\n/)[0] ?? '';
    const summary = para.startsWith('#') ? '' : para.replace(/\s+/g, ' ').slice(0, 400);
    return { path: s.path, title: title || s.path.split('/').pop() || s.path, summary };
  });
  return { overview: doc.overview.replace(/^#[^\n]*\n/, '').trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').slice(0, 600) ?? '', areas };
}

const FLOWS_HEADING = /^(#{1,6})\s+(data\s+)?flows?\b/i;

/**
 * The map's Flows section: one list item per flow, its steps joined by arrows, each step an area's
 * path (or its title), an optional description after a dash:
 *   - Checkout: `src/api/` → `src/orders/` → `src/store/` — a request becomes a saved order
 */
export function parseFlows(text: string, areas: Area[]): Flow[] {
  const lines = text.split('\n');
  const flows: Flow[] = [];
  let level = 0;
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,6})\s/.exec(line);
    if (h) {
      if (FLOWS_HEADING.test(line)) level = h[1].length;
      else if (level && h[1].length <= level) level = 0;
      continue;
    }
    if (!level) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!item || !/→|->|⟶|=>/.test(item[1])) continue;
    let body = item[1];
    let name = '';
    const colon = /^([^:→]+?):\s+(.*)$/.exec(body);
    if (colon && !/[`/]/.test(colon[1])) [name, body] = [colon[1], colon[2]];
    const [chain, ...desc] = body.split(/\s+[—–]\s+|\s+--\s+|\s+-\s+(?=[^→>]*$)/);
    const steps = chain.split(/\s*(?:→|->|⟶|=>)\s*/).map(st => {
      const label = st.replace(/[*_]/g, '').trim();
      return { label, ...stepArea(label, areas) };
    }).filter(st => st.label);
    if (steps.length < 2) continue;
    flows.push({ name: name.replace(/[*_`]/g, '').trim() || steps.map(st => st.label).join(' → '), steps, text: desc.join(' — ').trim() });
  }
  return flows;
}

function stepArea(label: string, areas: Area[]): { area?: string } {
  const code = /`([^`]+)`/.exec(label)?.[1] ?? label.split(/\s+/)[0];
  const path = code.replace(/^\.?\//, '').replace(/\/+$/, '');
  const byPath = path ? areaOf(areas.filter(a => a.path), path) : undefined;
  if (byPath !== undefined && (path === byPath || path.startsWith(byPath + '/'))) return { area: byPath };
  const plain = label.replace(/`/g, '').replace(/\(.*\)/, '').trim().toLowerCase();
  const byTitle = areas.find(a => a.title.toLowerCase() === plain || a.path.split('/').pop()?.toLowerCase() === plain);
  return byTitle ? { area: byTitle.path } : {};
}

/** Groups of areas that use each other in a circle (strongly connected, two or more areas). */
export function cycles(edges: { from: string; to: string }[]): string[][] {
  const next = new Map<string, string[]>();
  for (const e of edges) if (e.from !== e.to) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  let i = 0;
  const visit = (v: string) => {
    index.set(v, i);
    low.set(v, i++);
    stack.push(v);
    on.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) out.push(group.sort());
    }
  };
  for (const v of next.keys()) if (!index.has(v)) visit(v);
  return out;
}

/**
 * Areas from folders, for a repository without a map: its top folders, and a folder that holds
 * most of the code split into its own subfolders.
 */
export function folderAreas(paths: string[]): Area[] {
  const top = new Map<string, number>();
  for (const p of paths) top.set(p.includes('/') ? p.split('/')[0] : '', (top.get(p.includes('/') ? p.split('/')[0] : '') ?? 0) + 1);
  const out: Area[] = [];
  for (const [dir, n] of top) {
    const subs = new Set(paths.filter(p => p.startsWith(dir + '/') && p.split('/').length > 2).map(p => p.split('/').slice(0, 2).join('/')));
    if (dir && n >= paths.length / 2 && subs.size >= 2) {
      for (const s of subs) out.push({ path: s, title: s.split('/').pop()!, summary: '' });
      if (paths.some(p => posix.dirname(p) === dir)) out.push({ path: dir, title: dir, summary: '' });
    } else out.push({ path: dir, title: dir || 'top level', summary: '' });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Folders the map leaves out still show, so nothing goes missing from the picture: each at the
 * depth of the mapped areas beside it (src/util/ next to a mapped src/api/), marked unmapped.
 */
export function unmappedAreas(paths: string[], mapped: Area[]): Area[] {
  const out = new Map<string, Area>();
  for (const p of paths) {
    const dirs = posix.dirname(p) === '.' ? [] : posix.dirname(p).split('/');
    let shared = 0;
    for (const a of mapped) {
      const segs = a.path.split('/');
      let n = 0;
      while (n < segs.length && n < dirs.length && segs[n] === dirs[n]) n++;
      shared = Math.max(shared, n);
    }
    const path = dirs.slice(0, Math.min(dirs.length, shared + 1)).join('/');
    if (!out.has(path)) out.set(path, { path, title: path.split('/').pop() || 'top level', summary: '', unmapped: true });
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The deepest area holding a path. */
export function areaOf(areas: Area[], path: string): string | undefined {
  let best: Area | undefined;
  for (const a of areas) {
    if ((a.path === '' || path === a.path || path.startsWith(a.path + '/')) && (!best || a.path.length > best.path.length)) best = a;
  }
  return best?.path;
}

/* ---------------- snapshots ---------------- */

export class DesignTracker {
  private outlines = new Map<string, FileOutline | null>();
  private building = new Map<string, Promise<DesignSnapshot>>();
  readonly home: string;
  readonly outliner: Outliner;

  constructor(home: string, outliner: Outliner) {
    this.home = home;
    this.outliner = outliner;
  }

  private dir(goal: string): string {
    return join(this.home, 'goals', goal, 'design');
  }

  /** The design at a commit: from the goal's folder, else read now (and kept). */
  async get(goal: string, gg: git.GoalGit, dir: string, sha: string): Promise<DesignSnapshot> {
    const file = join(this.dir(goal), `${sha}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as DesignSnapshot;
    const key = `${goal}/${sha}`;
    let p = this.building.get(key);
    if (!p) {
      p = this.build(gg, dir, sha).then(s => {
        mkdirSync(this.dir(goal), { recursive: true });
        writeFileSync(file, JSON.stringify(s));
        return s;
      });
      p.finally(() => this.building.delete(key)).catch(() => {});
      this.building.set(key, p);
    }
    return p;
  }

  /** A snapshot already taken, if there is one on disk. */
  cached(goal: string, sha: string): DesignSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir(goal), `${sha}.json`), 'utf8')) as DesignSnapshot;
    } catch {
      return undefined;
    }
  }

  /** Keeps a scope's report as goals/<goal>/design/reports/<from>..<to>.json, for later goals and models to read. */
  saveReport(report: DesignReport): string {
    const dir = join(this.dir(report.goal), 'reports');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${report.scope.from}..${report.scope.to}.json`);
    writeFileSync(file, JSON.stringify(report, null, 1));
    return file;
  }

  list(goal: string): SnapshotInfo[] {
    try {
      return JSON.parse(readFileSync(join(this.dir(goal), 'index.json'), 'utf8')) as SnapshotInfo[];
    } catch {
      return [];
    }
  }

  /**
   * Takes a snapshot for the timeline and compares it with the one before. Resolves to what
   * changed (undefined for the first, or when the commit was already in the timeline).
   */
  async record(goal: string, gg: git.GoalGit, dir: string, info: Omit<SnapshotInfo, 'at' | 'change'>): Promise<{ info: SnapshotInfo; change?: DesignChange } | undefined> {
    const index = this.list(goal);
    if (index.some(i => i.sha === info.sha)) return undefined;
    const snap = await this.get(goal, gg, dir, info.sha);
    const prev = index.at(-1);
    const change = prev ? compareDesigns(await this.get(goal, gg, dir, prev.sha), snap) : undefined;
    const entry: SnapshotInfo = { ...info, at: new Date().toISOString(), ...(change ? { change: summarize(change) } : {}) };
    // Read again: another snapshot may have finished meanwhile.
    const now = this.list(goal);
    now.push(entry);
    mkdirSync(this.dir(goal), { recursive: true });
    writeFileSync(join(this.dir(goal), 'index.json'), JSON.stringify(now));
    return { info: entry, change };
  }

  async build(gg: git.GoalGit, cwd: string, sha: string): Promise<DesignSnapshot> {
    const tree = git.treeFiles(gg, sha).filter(f => !SKIP.test(f.path));
    const paths = tree.map(f => f.path);
    const mapText = git.showFile(gg, sha, MAP_FILE);
    const fromMap = mapText ? mapAreas(mapText, cwd) : undefined;
    let areas = fromMap?.areas.length ? fromMap.areas : folderAreas(paths);
    if (fromMap?.areas.length) areas = [...areas, ...unmappedAreas(paths.filter(p => areaOf(areas, p) === undefined), areas)];
    const packs = this.outliner.packs;
    const files: DesignFile[] = tree.map(f => ({ path: f.path, size: f.size, blob: f.blob, area: areaOf(areas, f.path) ?? '', ...(packFor(packs.values(), f.path) ? { lang: packFor(packs.values(), f.path)!.name } : {}) }));
    const readable = files.filter(f => f.lang && f.size <= MAX_BYTES);
    const toRead = readable.slice(0, MAX_FILES);
    const need = [...new Set(toRead.filter(f => !this.outlines.has(`${f.lang}:${f.blob}`)).map(f => f.blob))];
    const texts = git.readBlobs(gg, need);
    const outlineOf = new Map<string, FileOutline>();
    for (const f of toRead) {
      const key = `${f.lang}:${f.blob}`;
      if (!this.outlines.has(key)) {
        const text = texts.get(f.blob);
        this.outlines.set(key, text === undefined ? null : ((await this.outliner.outline(packs.get(f.lang!)!, text)) ?? null));
      }
      const o = this.outlines.get(key);
      if (o) outlineOf.set(f.path, o);
    }
    // Class names first, for packs that resolve imports by name (GDScript's class_name).
    const ctx = resolveContext(paths);
    for (const f of toRead) {
      const o = outlineOf.get(f.path);
      if (!o) continue;
      const names = ctx.names.get(f.lang!) ?? new Map<string, string>();
      for (const s of o.symbols) if (s.kind === 'class' && !s.parent && !names.has(s.name)) names.set(s.name, f.path);
      ctx.names.set(f.lang!, names);
    }
    const edges = new Map<string, number>();
    for (const f of toRead) {
      const o = outlineOf.get(f.path);
      if (!o) continue;
      const pack = packs.get(f.lang!)!;
      const targets = new Set<string>();
      for (const spec of [...o.imports, ...(pack.resolve.includes('name') ? o.references : [])]) {
        const to = resolveImport(pack, f.path, spec, ctx);
        if (to) targets.add(to);
      }
      f.symbols = o.symbols;
      if (targets.size) f.imports = [...targets];
      for (const t of targets) {
        const ta = areaOf(areas, t) ?? '';
        if (ta !== f.area) edges.set(`${f.area}\n${ta}`, (edges.get(`${f.area}\n${ta}`) ?? 0) + 1);
      }
    }
    return {
      sha,
      at: new Date().toISOString(),
      map: { file: mapText ? MAP_FILE : null, overview: fromMap?.overview ?? '', areas, flows: mapText ? parseFlows(mapText, areas) : [] },
      files,
      edges: [...edges].map(([k, n]) => ({ from: k.split('\n')[0], to: k.split('\n')[1], n })),
      skipped: readable.length - toRead.length + files.filter(f => f.lang && f.size > MAX_BYTES).length,
      problems: [...this.outliner.problems.values()],
    };
  }
}

/* ---------------- what changed between two snapshots ---------------- */

export interface SymbolRef {
  file: string;
  kind: string;
  name: string;
  parent?: string;
  area: string;
  /** Where it is: in the newer snapshot, or the older one for a removed definition. */
  line?: number;
  end?: number;
}

export interface DesignChange {
  areas: { added: string[]; removed: string[]; rewritten: string[] };
  edges: { added: { from: string; to: string }[]; removed: { from: string; to: string }[] };
  files: { added: string[]; removed: string[]; changed: string[] };
  symbols: { added: SymbolRef[]; removed: SymbolRef[]; changed: SymbolRef[] };
  overviewChanged: boolean;
}

export interface ChangeSummary {
  areas: number;
  edges: number;
  files: number;
  symbols: number;
  /** A few lines a person reads first. */
  highlights: string[];
}

const symKey = (s: { kind: string; name: string; parent?: string }) => `${s.kind} ${s.parent ? `${s.parent}.` : ''}${s.name}`;

export function compareDesigns(a: DesignSnapshot, b: DesignSnapshot): DesignChange {
  const aAreas = new Map(a.map.areas.map(x => [x.path, x]));
  const bAreas = new Map(b.map.areas.map(x => [x.path, x]));
  const edgeKey = (e: { from: string; to: string }) => `${e.from}\n${e.to}`;
  const aEdges = new Set(a.edges.map(edgeKey));
  const bEdges = new Set(b.edges.map(edgeKey));
  const aFiles = new Map(a.files.map(f => [f.path, f]));
  const bFiles = new Map(b.files.map(f => [f.path, f]));
  const change: DesignChange = {
    areas: {
      added: [...bAreas.keys()].filter(p => !aAreas.has(p)),
      removed: [...aAreas.keys()].filter(p => !bAreas.has(p)),
      rewritten: [...bAreas.values()].filter(x => aAreas.has(x.path) && aAreas.get(x.path)!.summary !== x.summary && !x.unmapped).map(x => x.path),
    },
    edges: {
      added: b.edges.filter(e => !aEdges.has(edgeKey(e))).map(({ from, to }) => ({ from, to })),
      removed: a.edges.filter(e => !bEdges.has(edgeKey(e))).map(({ from, to }) => ({ from, to })),
    },
    files: {
      added: [...bFiles.keys()].filter(p => !aFiles.has(p)),
      removed: [...aFiles.keys()].filter(p => !bFiles.has(p)),
      changed: [...bFiles.values()].filter(f => aFiles.has(f.path) && aFiles.get(f.path)!.blob !== f.blob).map(f => f.path),
    },
    symbols: { added: [], removed: [], changed: [] },
    overviewChanged: a.map.overview !== b.map.overview,
  };
  const ref = (f: DesignFile, s: Symbol): SymbolRef => ({ file: f.path, kind: s.kind, name: s.name, ...(s.parent ? { parent: s.parent } : {}), area: f.area, line: s.line, ...(s.end ? { end: s.end } : {}) });
  for (const path of new Set([...change.files.added, ...change.files.removed, ...change.files.changed])) {
    const before = new Map((aFiles.get(path)?.symbols ?? []).map(s => [symKey(s), s]));
    const after = new Map((bFiles.get(path)?.symbols ?? []).map(s => [symKey(s), s]));
    const f = bFiles.get(path) ?? aFiles.get(path)!;
    for (const [k, s] of after) {
      const old = before.get(k);
      if (!old) change.symbols.added.push(ref(f, s));
      else if (old.hash !== s.hash) change.symbols.changed.push(ref(f, s));
    }
    for (const [k, s] of before) if (!after.has(k)) change.symbols.removed.push(ref(aFiles.get(path) ?? f, s));
  }
  return change;
}

const label = (p: string) => p || 'top level';
const TOP_KINDS = ['class', 'interface', 'type', 'enum', 'module'];

export function summarize(c: DesignChange): ChangeSummary {
  const h: string[] = [];
  for (const p of c.areas.added) h.push(`new area ${label(p)}`);
  for (const p of c.areas.removed) h.push(`area ${label(p)} gone`);
  for (const p of c.areas.rewritten) h.push(`${label(p)} described anew`);
  for (const e of c.edges.added) h.push(`${label(e.from)} now uses ${label(e.to)}`);
  for (const e of c.edges.removed) h.push(`${label(e.from)} no longer uses ${label(e.to)}`);
  const big = (s: SymbolRef) => TOP_KINDS.includes(s.kind) || !s.parent;
  for (const s of c.symbols.added.filter(big).slice(0, 4)) h.push(`added ${s.kind} ${s.name} (${s.file})`);
  for (const s of c.symbols.removed.filter(big).slice(0, 3)) h.push(`removed ${s.kind} ${s.name} (${s.file})`);
  return {
    areas: c.areas.added.length + c.areas.removed.length + c.areas.rewritten.length,
    edges: c.edges.added.length + c.edges.removed.length,
    files: c.files.added.length + c.files.removed.length + c.files.changed.length,
    symbols: c.symbols.added.length + c.symbols.removed.length + c.symbols.changed.length,
    highlights: h.slice(0, 10),
  };
}

export type { LanguagePack };

/* ---------------- a scope's report: what changed where, and what may need attention ---------------- */

export interface ScopeCommit {
  sha: string;
  at: string;
  summary: string;
  agent?: string;
  merge: boolean;
  added: number;
  removed: number;
  files: number;
  /** The areas its files are in. */
  areas: string[];
  paths: string[];
}

export interface AreaChange {
  path: string;
  /** Net lines added and removed over the scope, and files changed. */
  added: number;
  removed: number;
  files: number;
  commits: number;
  /** Who committed here, with how many commits. */
  agents: { name: string; commits: number }[];
  symbols: { added: number; changed: number; removed: number };
  /** The highest hotspot score among its files. */
  hotspot: number;
}

export interface FileChange {
  path: string;
  area: string;
  added: number;
  removed: number;
  /** Lines added and removed counted commit by commit, so code rewritten twice counts twice. */
  churn: number;
  commits: number;
  agents: string[];
  size: number;
  /** How many files import it. */
  usedBy: number;
  score: number;
  reasons: string[];
}

/**
 * What a scope of work (a commit, a landing, an agent's branch, the whole goal) did to the
 * design, kept as JSON beside the snapshots so a later goal, or a model, can read it: the
 * commits, each area's share, files ranked by how much attention they may need (hotspots),
 * circular dependencies, new and lost dependencies, coupling, and the declared flows.
 */
export interface DesignReport {
  goal: string;
  scope: { kind: string; title: string; from: string; to: string };
  at: string;
  totals: { commits: number; files: number; added: number; removed: number; agents: string[] };
  commits: ScopeCommit[];
  areas: AreaChange[];
  files: FileChange[];
  /** The files with the highest scores, at most 20. */
  hotspots: string[];
  cycles: { areas: string[]; new: boolean }[];
  edges: DesignChange['edges'];
  coupling: { area: string; uses: number; usedBy: number }[];
  /** Flow steps that name no area, or that follow one another without an import either way. */
  flows: { name: string; unknown: string[]; unbacked: [string, string][] }[];
}

export interface ReportInput {
  goal: string;
  scope: DesignReport['scope'];
  before: DesignSnapshot;
  after: DesignSnapshot;
  change: DesignChange;
  log: { sha: string; parents: string[]; at: string; summary: string; files: { path: string; added: number; removed: number }[] }[];
  /** Net lines per file over the scope. */
  net: Map<string, { added: number; removed: number }>;
  /** Who made each commit, from the hooks. */
  authors: Map<string, string>;
  /** A merge's size against its first parent, from the log. */
  mergeSizes?: Map<string, { added: number; removed: number; files: number }>;
}

const LARGE = 48 * 1024;

export function designReport(r: ReportInput): DesignReport {
  const areas = r.after.map.areas;
  const oldAreas = r.before.map.areas;
  const where = (p: string) => areaOf(areas, p) ?? areaOf(oldAreas, p) ?? '';
  const commits: ScopeCommit[] = r.log.map(c => {
    const merge = c.parents.length > 1;
    const m = r.mergeSizes?.get(c.sha);
    const paths = c.files.map(f => f.path);
    return {
      sha: c.sha, at: c.at, summary: c.summary, ...(r.authors.has(c.sha) ? { agent: r.authors.get(c.sha) } : {}), merge,
      added: merge ? (m?.added ?? 0) : c.files.reduce((n, f) => n + f.added, 0),
      removed: merge ? (m?.removed ?? 0) : c.files.reduce((n, f) => n + f.removed, 0),
      files: merge ? (m?.files ?? 0) : c.files.length,
      areas: [...new Set(paths.map(where))], paths: paths.slice(0, 200),
    };
  });
  const usedBy = new Map<string, number>();
  for (const f of r.after.files) for (const i of f.imports ?? []) usedBy.set(i, (usedBy.get(i) ?? 0) + 1);
  const size = new Map(r.after.files.map(f => [f.path, f.size]));
  const gross = new Map<string, { churn: number; commits: number; agents: Set<string> }>();
  for (const c of r.log) {
    for (const f of c.files) {
      const g = gross.get(f.path) ?? { churn: 0, commits: 0, agents: new Set<string>() };
      g.churn += f.added + f.removed;
      g.commits++;
      if (r.authors.has(c.sha)) g.agents.add(r.authors.get(c.sha)!);
      gross.set(f.path, g);
    }
  }
  const files: FileChange[] = [];
  for (const path of new Set([...r.net.keys(), ...gross.keys()])) {
    const n = r.net.get(path) ?? { added: 0, removed: 0 };
    const g = gross.get(path) ?? { churn: n.added + n.removed, commits: 0, agents: new Set<string>() };
    const sz = size.get(path) ?? 0;
    const ub = usedBy.get(path) ?? 0;
    // A heuristic for ranking, not a measure: churn, weighted up for rework, several hands,
    // many dependants and size.
    const score = g.churn
      ? Math.round(Math.log2(1 + g.churn) * (1 + 0.5 * Math.max(0, g.commits - 1)) * (1 + 0.5 * Math.max(0, g.agents.size - 1)) * (1 + Math.log2(1 + ub) / 2) * (sz > LARGE ? 1.5 : 1) * 10) / 10
      : 0;
    const reasons = [
      g.commits >= 3 ? `changed in ${g.commits} commits` : '',
      g.agents.size > 1 ? `changed by ${g.agents.size} agents (${[...g.agents].join(', ')})` : '',
      ub >= 5 ? `used by ${ub} files` : '',
      sz > LARGE ? `large: ${Math.round(sz / 1024)} KB` : '',
      g.churn >= 300 ? `${g.churn} lines changed along the way` : '',
    ].filter(Boolean);
    files.push({ path, area: where(path), added: n.added, removed: n.removed, churn: g.churn, commits: g.commits, agents: [...g.agents], size: sz, usedBy: ub, score, reasons });
  }
  files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const byArea = new Map<string, AreaChange>();
  const area = (p: string) => {
    let a = byArea.get(p);
    if (!a) byArea.set(p, (a = { path: p, added: 0, removed: 0, files: 0, commits: 0, agents: [], symbols: { added: 0, changed: 0, removed: 0 }, hotspot: 0 }));
    return a;
  };
  for (const f of files) {
    const a = area(f.area);
    if (r.net.has(f.path)) {
      a.added += f.added;
      a.removed += f.removed;
      a.files++;
    }
    a.hotspot = Math.max(a.hotspot, f.score);
  }
  for (const c of commits) {
    for (const p of c.areas) {
      const a = area(p);
      a.commits++;
      if (c.agent) {
        const who = a.agents.find(x => x.name === c.agent);
        if (who) who.commits++;
        else a.agents.push({ name: c.agent, commits: 1 });
      }
    }
  }
  for (const [k, list] of [['added', r.change.symbols.added], ['changed', r.change.symbols.changed], ['removed', r.change.symbols.removed]] as const) {
    for (const s of list) area(s.area).symbols[k]++;
  }
  for (const a of byArea.values()) a.agents.sort((x, y) => y.commits - x.commits);
  const before = new Set(cycles(r.before.edges).map(c => c.join('\n')));
  const linked = new Set(r.after.edges.flatMap(e => [`${e.from}\n${e.to}`, `${e.to}\n${e.from}`]));
  return {
    goal: r.goal,
    scope: r.scope,
    at: new Date().toISOString(),
    totals: {
      commits: commits.length, files: r.net.size,
      added: [...r.net.values()].reduce((n, x) => n + x.added, 0), removed: [...r.net.values()].reduce((n, x) => n + x.removed, 0),
      agents: [...new Set(commits.map(c => c.agent).filter((a): a is string => !!a))],
    },
    commits,
    areas: [...byArea.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed)),
    files: files.slice(0, 2000),
    hotspots: files.filter(f => f.score > 0).slice(0, 20).map(f => f.path),
    cycles: cycles(r.after.edges).map(c => ({ areas: c, new: !before.has(c.join('\n')) })),
    edges: r.change.edges,
    coupling: areas.map(a => ({ area: a.path, uses: r.after.edges.filter(e => e.from === a.path).length, usedBy: r.after.edges.filter(e => e.to === a.path).length })).filter(c => c.uses || c.usedBy),
    flows: (r.after.map.flows ?? []).map(f => {
      const unbacked: [string, string][] = [];
      for (let i = 1; i < f.steps.length; i++) {
        const [a, b] = [f.steps[i - 1].area, f.steps[i].area];
        if (a !== undefined && b !== undefined && a !== b && !linked.has(`${a}\n${b}`)) unbacked.push([a, b]);
      }
      return { name: f.name, unknown: f.steps.filter(st => st.area === undefined).map(st => st.label), unbacked };
    }),
  };
}
