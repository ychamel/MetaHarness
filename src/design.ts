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

export interface DesignSnapshot {
  sha: string;
  at: string;
  map: { file: string | null; overview: string; areas: Area[] };
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
      map: { file: mapText ? MAP_FILE : null, overview: fromMap?.overview ?? '', areas },
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
  const ref = (f: DesignFile, s: Symbol): SymbolRef => ({ file: f.path, kind: s.kind, name: s.name, ...(s.parent ? { parent: s.parent } : {}), area: f.area });
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
