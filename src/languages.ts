import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { parseFrontMatter } from './config.ts';
import { BUILTIN_DIR } from './rules.ts';

/**
 * Language packs (design §14, the Design view): how MetaHarness finds the classes, functions and
 * imports in a file. A pack is a folder in languages/: `language.md` says which files it reads
 * and how its imports name other files; a tree-sitter grammar (`grammar.wasm`) with
 * `queries.scm`, or, for formats simple enough, `patterns.txt` with one regular expression per
 * kind. Built-in packs come first; a folder's pack of the same name replaces one.
 *
 * queries.scm follows tree-sitter's tags.scm convention, so a grammar's own tags.scm mostly works
 * as is: `@definition.<kind>` around a definition with `@name` inside it, `@reference.<kind>`
 * for names used, and MetaHarness's `@import` for the text that names another file.
 */

export type Resolve = 'relative' | 'dotted' | 'res' | 'name' | 'suffix';
const RESOLVES: Resolve[] = ['relative', 'dotted', 'res', 'name', 'suffix'];

export interface LanguagePack {
  name: string;
  extensions: string[];
  /** The grammar's wasm file, for tree-sitter packs. */
  grammar?: string;
  queries?: string;
  /** Line patterns, for packs without a grammar. */
  patterns?: { kind: string; re: RegExp }[];
  /** How an import names a file, tried in order. */
  resolve: Resolve[];
  /** Endings tried when resolving an import (".ts", "/index.ts"). */
  try: string[];
  /** Folders dotted names are found under. */
  roots: string[];
  /** Which reader finds the calls, signals and state in its files (src/codegraph.ts), if any. */
  code?: string;
  description: string;
  dir: string;
  builtIn: boolean;
}

const list = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

export function loadLanguagePack(dir: string, builtIn = false): LanguagePack | undefined {
  const file = join(dir, 'language.md');
  if (!existsSync(file)) return undefined;
  const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'));
  const grammar = meta.grammar ? join(dir, meta.grammar) : undefined;
  const queriesFile = join(dir, meta.queries || 'queries.scm');
  const patternsFile = join(dir, meta.patterns || 'patterns.txt');
  const patterns = existsSync(patternsFile)
    ? readFileSync(patternsFile, 'utf8')
        .split('\n')
        .map(l => /^\s*([\w.]+)\s*:\s*(.+?)\s*$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m && !m[0].trimStart().startsWith('#'))
        .flatMap(m => {
          try {
            return [{ kind: m[1], re: new RegExp(m[2]) }];
          } catch {
            return [];
          }
        })
    : undefined;
  return {
    name: basename(dir),
    extensions: list(meta.extensions).map(e => e.toLowerCase()),
    ...(grammar && existsSync(grammar) ? { grammar } : {}),
    ...(existsSync(queriesFile) ? { queries: readFileSync(queriesFile, 'utf8') } : {}),
    ...(patterns?.length ? { patterns } : {}),
    resolve: list(meta.resolve).filter((r): r is Resolve => (RESOLVES as string[]).includes(r)),
    try: list(meta.try),
    roots: list(meta.roots).length ? list(meta.roots) : ['.'],
    ...(meta.code ? { code: meta.code.trim() } : {}),
    description: body.trim().split('\n\n')[0]?.replace(/\s+/g, ' ') ?? '',
    dir,
    builtIn,
  };
}

/** Built-in packs, then each folder's languages/, a later pack replacing an earlier one of the same name. */
export function loadLanguages(dirs: string[], builtIn = true): Map<string, LanguagePack> {
  const out = new Map<string, LanguagePack>();
  for (const [i, d] of [...(builtIn ? [BUILTIN_DIR] : []), ...dirs].entries()) {
    const root = join(d, 'languages');
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      if (!statSync(dir).isDirectory()) continue;
      const pack = loadLanguagePack(dir, builtIn && i === 0);
      if (pack && (pack.grammar || pack.patterns)) out.set(pack.name, pack);
    }
  }
  return out;
}

/** The pack that reads a file, by its extension. */
export function packFor(packs: Iterable<LanguagePack>, path: string): LanguagePack | undefined {
  const lower = path.toLowerCase();
  let best: LanguagePack | undefined;
  let len = 0;
  for (const p of packs) {
    for (const e of p.extensions) if (lower.endsWith(e) && e.length > len) [best, len] = [p, e.length];
  }
  return best;
}

/* ---------------- what's in a file ---------------- */

export interface Symbol {
  kind: string;
  name: string;
  /** The class (or other definition) it's inside. */
  parent?: string;
  /** 1-based. */
  line: number;
  /** Its last line, 1-based (snapshots taken before this was kept don't have it). */
  end?: number;
  /** A short hash of its text, to tell a changed definition from an unchanged one. */
  hash: string;
}

export interface FileOutline {
  symbols: Symbol[];
  /** What its imports say, as written. */
  imports: string[];
  /** Names it uses that may be defined elsewhere (`@reference.class`), for `resolve: name`. */
  references: string[];
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 10);
const MAX_SYMBOLS = 400;

type TS = typeof import('web-tree-sitter');
type Loaded = { language: import('web-tree-sitter').Language; query: import('web-tree-sitter').Query; parser: import('web-tree-sitter').Parser };

/** Reads files with the packs. Grammars load once, when a file needs them. */
export class Outliner {
  private ts?: Promise<TS>;
  private loaded = new Map<string, Promise<Loaded | undefined>>();
  /** Why a pack couldn't be used, by name: shown to the human once. */
  readonly problems = new Map<string, string>();

  readonly packs: Map<string, LanguagePack>;

  constructor(packs: Map<string, LanguagePack>) {
    this.packs = packs;
  }

  async outline(pack: LanguagePack, text: string): Promise<FileOutline | undefined> {
    if (pack.grammar && pack.queries) {
      const l = await this.load(pack);
      if (l) return treeOutline(l, text);
    }
    return pack.patterns ? patternOutline(pack.patterns, text) : undefined;
  }

  /** Parses a file with the pack's grammar and hands its root to `read`; undefined without a grammar. */
  async parse<T>(pack: LanguagePack, text: string, read: (root: import('web-tree-sitter').Node) => T): Promise<T | undefined> {
    const l = pack.grammar && pack.queries ? await this.load(pack) : undefined;
    const tree = l?.parser.parse(text);
    if (!tree) return undefined;
    try {
      return read(tree.rootNode);
    } finally {
      tree.delete();
    }
  }

  private load(pack: LanguagePack): Promise<Loaded | undefined> {
    let p = this.loaded.get(pack.name);
    if (!p) {
      p = (async () => {
        try {
          this.ts ??= import('web-tree-sitter').then(async m => (await m.Parser.init(), m));
          const ts = await this.ts;
          const language = await ts.Language.load(readFileSync(pack.grammar!));
          const parser = new ts.Parser();
          parser.setLanguage(language);
          return { language, parser, query: new ts.Query(language, pack.queries!) };
        } catch (e) {
          this.problems.set(pack.name, `${pack.name}: ${(e as Error).message || String(e)}`);
          return undefined;
        }
      })();
      this.loaded.set(pack.name, p);
    }
    return p;
  }
}

function treeOutline(l: Loaded, text: string): FileOutline {
  const tree = l.parser.parse(text);
  const out: FileOutline = { symbols: [], imports: [], references: [] };
  if (!tree) return out;
  try {
    const defs: { kind: string; name: string; start: number; end: number; line: number; last: number; hash: string }[] = [];
    for (const m of l.query.matches(tree.rootNode)) {
      const def = m.captures.find(c => c.name.startsWith('definition.'));
      const name = m.captures.find(c => c.name === 'name');
      if (def && name) {
        defs.push({ kind: def.name.slice(11), name: name.node.text, start: def.node.startIndex, end: def.node.endIndex, line: def.node.startPosition.row + 1, last: def.node.endPosition.row + 1, hash: hash(def.node.text) });
      }
      for (const c of m.captures) if (c.name === 'import') out.imports.push(c.node.text.replace(/^(['"])(.*)\1$/s, '$2'));
      // A reference names what it uses with @name, as in tags.scm; calls are too many to follow.
      const ref = m.captures.find(c => c.name.startsWith('reference.') && c.name !== 'reference.call');
      if (ref) out.references.push((name ?? ref).node.text);
    }
    defs.sort((a, b) => a.start - b.start || b.end - a.end);
    for (const d of defs.slice(0, MAX_SYMBOLS)) {
      // The innermost definition around it, if any, is its parent: a method's class.
      const around = defs.filter(o => o !== d && o.start <= d.start && o.end >= d.end && (o.start < d.start || o.end > d.end)).at(-1);
      const kind = around && d.kind === 'function' && around.kind === 'class' ? 'method' : d.kind;
      out.symbols.push({ kind, name: d.name, ...(around ? { parent: around.name } : {}), line: d.line, end: d.last, hash: d.hash });
    }
  } finally {
    tree.delete();
  }
  out.imports = [...new Set(out.imports)];
  out.references = [...new Set(out.references)];
  return out;
}

/**
 * Line patterns: a match's first group is the name. A definition indented under a class (or
 * another definition) belongs to it; its text runs to the next line indented as little.
 */
function patternOutline(patterns: { kind: string; re: RegExp }[], text: string): FileOutline {
  const out: FileOutline = { symbols: [], imports: [], references: [] };
  const lines = text.split('\n');
  const open: { name: string; indent: number; kind: string }[] = [];
  const defs: { s: Symbol; indent: number; at: number }[] = [];
  for (const [i, line] of lines.entries()) {
    const indent = line.length - line.trimStart().length;
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (!m) continue;
      const value = m[1] ?? m[0];
      if (p.kind === 'import') out.imports.push(value);
      else if (p.kind.startsWith('reference')) out.references.push(value);
      else if (out.symbols.length < MAX_SYMBOLS) {
        while (open.length && open.at(-1)!.indent >= indent) open.pop();
        const parent = open.at(-1);
        const kind = parent?.kind === 'class' && p.kind === 'function' ? 'method' : p.kind;
        const s: Symbol = { kind, name: value, ...(parent ? { parent: parent.name } : {}), line: i + 1, hash: '' };
        out.symbols.push(s);
        defs.push({ s, indent, at: i });
        open.push({ name: value, indent, kind: p.kind });
      }
    }
  }
  for (const d of defs) {
    let end = d.at + 1;
    while (end < lines.length && !(lines[end].trim() && lines[end].length - lines[end].trimStart().length <= d.indent)) end++;
    d.s.hash = hash(lines.slice(d.at, end).join('\n'));
    while (end > d.at + 1 && !lines[end - 1].trim()) end--;
    d.s.end = end;
  }
  out.imports = [...new Set(out.imports)];
  out.references = [...new Set(out.references)];
  return out;
}

/* ---------------- which files an import names ---------------- */

export interface ResolveContext {
  /** Every file in the tree. */
  files: Set<string>;
  /** Folders that hold files. */
  folders: Set<string>;
  /** Where a Godot project's res:// starts: the folder of project.godot. */
  resRoot: string;
  /** Files defining a class by name (for `resolve: name`), per pack. */
  names: Map<string, Map<string, string>>;
}

export function resolveContext(paths: string[]): ResolveContext {
  const folders = new Set<string>();
  for (const p of paths) for (let d = posix.dirname(p); d !== '.' && !folders.has(d); d = posix.dirname(d)) folders.add(d);
  const godot = paths.filter(p => basename(p) === 'project.godot').sort((a, b) => a.length - b.length)[0];
  return { files: new Set(paths), folders, resRoot: godot ? posix.dirname(godot) : '.', names: new Map() };
}

/** The repository files an import names, by the pack's ways of resolving it. */
export function resolveImport(pack: LanguagePack, from: string, spec: string, ctx: ResolveContext): string | undefined {
  const tryFile = (base: string): string | undefined => {
    const b = posix.normalize(base).replace(/^\.\//, '');
    if (b.startsWith('..')) return undefined;
    if (ctx.files.has(b)) return b;
    // ESM imports of a .ts file are often written with .js.
    const stem = b.replace(/\.(m|c)?jsx?$/, '');
    for (const t of pack.try) if (ctx.files.has(stem + t)) return stem + t;
    return undefined;
  };
  for (const how of pack.resolve) {
    let hit: string | undefined;
    if (how === 'relative' && spec.startsWith('.')) hit = tryFile(posix.join(posix.dirname(from), spec));
    else if (how === 'dotted') {
      const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
      const rest = spec.slice(dots).replace(/\./g, '/');
      if (dots) {
        let dir = posix.dirname(from);
        for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
        hit = tryFile(rest ? posix.join(dir, rest) : posix.join(dir, '__init__.py'));
      } else for (const root of pack.roots) if ((hit = tryFile(posix.join(root, rest)))) break;
    } else if (how === 'res' && spec.startsWith('res://')) hit = tryFile(posix.join(ctx.resRoot, spec.slice(6)));
    else if (how === 'name') hit = ctx.names.get(pack.name)?.get(spec);
    else if (how === 'suffix') {
      const tail = spec.replace(/^[./]+/, '').replace(/[.:]+/g, '/');
      for (const f of ctx.files) if (f === tail || f.startsWith(tail + '.') || f.endsWith('/' + tail) || posix.dirname(f).endsWith('/' + tail)) {
        hit = f;
        break;
      }
    }
    if (hit && hit !== from) return hit;
  }
  return undefined;
}

/** The pack folder a file's pack came from, for the human. */
export const packOrigin = (p: LanguagePack) => (p.builtIn ? 'built in' : dirname(dirname(p.dir)));
