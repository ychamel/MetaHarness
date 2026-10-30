import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { scopesOf, type ScopeDir } from './configedit.ts';
import { DesignTracker } from './design.ts';
import { Outliner } from './languages.ts';
import type { Settings } from './settings.ts';

/**
 * A project: a folder the human opened, like a folder opened in an editor. Its goals and rooms
 * work there and nowhere else, and it reads its own `.metaharness/` on top of the personal
 * config (design §22). One daemon holds every project at once.
 */
export class Project {
  readonly id: string;
  readonly dir: string;
  readonly name: string;
  /** Personal config, then the project's own, later ones overriding earlier ones. */
  readonly configDirs: string[];
  config!: Config;
  /** Design snapshots for the Design view (src/design.ts), read with the project's language packs. */
  design!: DesignTracker;

  private home: string;
  private settingsOverride?: Partial<Settings>;

  constructor(home: string, dir: string, configDirs: string[], settingsOverride?: Partial<Settings>) {
    this.home = home;
    this.settingsOverride = settingsOverride;
    this.dir = dir;
    this.id = projectId(dir);
    this.name = basename(dir) || dir;
    this.configDirs = configDirs;
    this.reload();
  }

  /** Reads the config files again: what's saved applies to agents started from now on. */
  reload(): void {
    this.config = loadConfig(this.configDirs, { repo: this.dir });
    if (this.settingsOverride) Object.assign(this.config.settings, this.settingsOverride);
    this.design = new DesignTracker(this.home, new Outliner(this.config.languages));
  }

  get scopes(): ScopeDir[] {
    return scopesOf(this.configDirs);
  }
}

/** A short, stable id for a folder, for addresses and the log. */
export function projectId(dir: string): string {
  return createHash('sha256').update(dir).digest('hex').slice(0, 10);
}

/** An absolute, real path for a folder someone named: `~` expanded, symlinks resolved. Throws when it isn't a folder. */
export function realDir(path: string, from = process.cwd()): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  const abs = isAbsolute(expanded) ? expanded : resolve(from, expanded);
  if (!existsSync(abs)) throw new Error(`There's no folder ${abs}.`);
  if (!statSync(abs).isDirectory()) throw new Error(`${abs} is a file, not a folder.`);
  return realpathSync(abs);
}

/** Whether `path` is `dir` or inside it. Both absolute and normalized. */
export function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/* ---------------- the list of projects you've opened ---------------- */

export interface ProjectEntry {
  dir: string;
  /** You said its own setup (.metaharness: roles, MCP servers, hooks) may run. */
  trusted: boolean;
  openedAt: string;
}

const REGISTRY = 'projects.json';

export function loadRegistry(home: string): ProjectEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(home, REGISTRY), 'utf8')) as { projects?: ProjectEntry[] };
    return (raw.projects ?? []).filter(p => p && typeof p.dir === 'string');
  } catch {
    return [];
  }
}

export function saveRegistry(home: string, list: ProjectEntry[]): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, REGISTRY), JSON.stringify({ projects: list }, null, 2) + '\n');
}

/** Puts a project at the top of the list (most recently opened first), keeping what it had. */
export function remember(home: string, dir: string, o: { trusted?: boolean } = {}): ProjectEntry {
  const list = loadRegistry(home);
  const before = list.find(p => p.dir === dir);
  const entry: ProjectEntry = { dir, trusted: o.trusted ?? before?.trusted ?? false, openedAt: new Date().toISOString() };
  saveRegistry(home, [entry, ...list.filter(p => p.dir !== dir)]);
  return entry;
}

export function forget(home: string, dir: string): boolean {
  const list = loadRegistry(home);
  const rest = list.filter(p => p.dir !== dir);
  if (rest.length === list.length) return false;
  saveRegistry(home, rest);
  return true;
}

/* ---------------- opening a folder ---------------- */

/**
 * What a folder's own setup would run, for the trust question asked the first time it's opened:
 * its `.metaharness/` (roles, workflows, rules, MCP servers, which can start commands). Empty
 * when it has none, and then there's nothing to ask.
 */
export interface FolderSetup {
  roles: string[];
  workflows: string[];
  rules: string[];
  mcp: { name: string; command: string }[];
  /** Harness profiles: each names a program to run. */
  harnesses: string[];
}

export function folderSetup(dir: string): FolderSetup | undefined {
  const own = join(dir, '.metaharness');
  if (!existsSync(own)) return undefined;
  const c = loadConfig([own], { builtIn: false, repo: null });
  const harnesses = existsSync(join(own, 'harnesses')) ? readdirSync(join(own, 'harnesses')).filter(f => f.endsWith('.md') || f.endsWith('.json')) : [];
  const setup: FolderSetup = {
    roles: [...c.roles.values()].filter(r => r.file !== '(built in)').map(r => r.name),
    workflows: [...c.workflows.keys()],
    rules: [...c.rules.keys()],
    mcp: [...c.mcp].map(([name, def]) => ({ name, command: def.url ?? [def.command, ...(def.args ?? [])].filter(Boolean).join(' ') })),
    harnesses,
  };
  return setup.roles.length + setup.workflows.length + setup.rules.length + setup.mcp.length + setup.harnesses.length ? setup : undefined;
}

/** Another known project this folder is inside, or ones inside it: their agents could read each other's files. */
export function nesting(dir: string, others: string[]): { inside?: string; contains: string[] } {
  const rest = others.filter(o => o !== dir);
  return { inside: rest.find(o => within(dir, o)), contains: rest.filter(o => within(o, dir)) };
}

/* ---------------- browsing folders (the daemon's disk, wherever the app is opened from) ---------------- */

export interface FolderView {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string; git: boolean; setup: boolean }[];
}

export function browse(path?: string, o: { hidden?: boolean } = {}): FolderView {
  const dir = realDir(path || homedir());
  const dirs: FolderView['dirs'] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!o.hidden && e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    dirs.push({ name: e.name, path: full, git: existsSync(join(full, '.git')), setup: existsSync(join(full, '.metaharness')) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, home: homedir(), dirs };
}
