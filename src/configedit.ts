import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parseFrontMatter } from './config.ts';
import type { McpServerDef } from './mcpservers.ts';

/**
 * Reading and writing the configuration from a client (the web app): roles, workflows, the team
 * guidelines (methodology) and MCP servers, each in one of the config directories. The files stay
 * the source of truth, in the same format people write by hand.
 */

/** personal: ~/.metaharness, for every project. repo: .metaharness in the repository. */
export type Scope = 'personal' | 'repo';

export interface ScopeDir {
  scope: Scope;
  dir: string;
}

/** The daemon's config directories as scopes: the last one is the repository's, an earlier one personal. */
export function scopesOf(dirs: string[]): ScopeDir[] {
  if (!dirs.length) return [];
  const repo = { scope: 'repo' as const, dir: dirs[dirs.length - 1] };
  return dirs.length > 1 ? [{ scope: 'personal', dir: dirs[0] }, repo] : [repo];
}

function dirOf(scopes: ScopeDir[], scope: unknown): string {
  const s = scopes.find(x => x.scope === scope);
  if (!s) throw new Error(`There's no ${String(scope)} config folder here. Folders: ${scopes.map(x => `${x.scope} (${x.dir})`).join(', ')}.`);
  return s.dir;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
function checkName(name: unknown, what: string): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!NAME.test(n) || n.includes('..')) throw new Error(`A ${what} name uses letters, digits, dots, dashes and underscores, and starts with a letter or digit (got "${String(name ?? '')}").`);
  return n;
}

/* ---------------- reading ---------------- */

export interface RoleView {
  name: string;
  scope: Scope;
  file: string;
  /** Also defined in a folder this one overrides (a personal role of the same name). */
  overrides?: Scope;
  harness: string;
  model: string;
  fallback: string[];
  goodAt: string;
  instructions: string;
  helper: boolean;
  worktree: boolean;
  workflow: string;
  mcp: string[];
  autoApprove: 'read-only' | 'none';
  permissionMode: string;
  allow: string[];
}

export interface WorkflowView {
  name: string;
  scope: Scope;
  file: string;
  overrides?: Scope;
  goodAt: string;
  body: string;
}

export interface GuideView {
  /** What agents get: the most specific folder's file, or the built-in text. */
  text: string;
  from: Scope | 'built-in';
  builtIn: string;
  /** The file in each folder, where there is one. */
  files: Partial<Record<Scope, string>>;
}

export interface ConfigView {
  scopes: ScopeDir[];
  roles: RoleView[];
  workflows: WorkflowView[];
  methodology: GuideView;
  helperMethodology: GuideView;
  mcp: { name: string; scope: Scope; def: McpServerDef }[];
}

const readIf = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined);

export function configView(scopes: ScopeDir[]): ConfigView {
  const builtIn = loadConfig([]);
  const roles = new Map<string, RoleView>();
  const workflows = new Map<string, WorkflowView>();
  const mcp = new Map<string, { name: string; scope: Scope; def: McpServerDef }>();
  const guide = (file: string, def: string): GuideView => {
    const g: GuideView = { text: def, from: 'built-in', builtIn: def, files: {} };
    for (const { scope, dir } of scopes) {
      const t = readIf(join(dir, file));
      if (t === undefined) continue;
      g.files[scope] = t;
      g.text = t;
      g.from = scope;
    }
    return g;
  };
  for (const { scope, dir } of scopes) {
    const c = loadConfig([dir]);
    for (const r of c.roles.values()) {
      const before = roles.get(r.name);
      roles.set(r.name, {
        name: r.name, scope, file: r.file, overrides: before?.scope, harness: r.harness, model: r.model, fallback: r.fallback, goodAt: r.goodAt,
        instructions: r.instructions, helper: r.helper, worktree: r.worktree, workflow: r.workflow ?? '', mcp: r.mcp, autoApprove: r.autoApprove,
        permissionMode: r.permissionMode ?? '', allow: r.allow,
      });
    }
    for (const w of c.workflows.values()) {
      const before = workflows.get(w.name);
      workflows.set(w.name, { name: w.name, scope, file: w.file, overrides: before?.scope, goodAt: w.goodAt, body: w.body });
    }
    for (const [name, def] of c.mcp) mcp.set(name, { name, scope, def });
  }
  const byName = <T extends { name: string }>(m: Map<string, T>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    scopes,
    roles: byName(roles),
    workflows: byName(workflows),
    methodology: guide('methodology.md', builtIn.methodology),
    helperMethodology: guide('helper-methodology.md', builtIn.helperMethodology),
    mcp: byName(mcp),
  };
}

/* ---------------- writing ---------------- */

/** One front-matter value on one line. */
const oneLine = (v: string) => v.replace(/\s*\n\s*/g, ' ').trim();

/** Leading HTML comments in a file people wrote, kept when the app saves it. */
function leadingComments(text: string): string {
  return /^\s*((?:<!--[\s\S]*?-->\s*)+)/.exec(text)?.[1].trim() ?? '';
}

function writeDoc(file: string, meta: [string, string][], body: string, keep = ''): void {
  const lines = meta.filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${oneLine(v)}`);
  const head = lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${keep ? keep + '\n' : ''}${head}${body.trim()}\n`);
}

/** Keys the app writes for a role; anything else already in the file is kept as it was. */
const ROLE_KEYS = ['harness', 'model', 'fallback', 'fallbacks', 'good_at', 'helper', 'worktree', 'workflow', 'mcp', 'auto_approve', 'permission_mode', 'allow'];

const strList = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(x => String(x).trim()).filter(Boolean);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Where a saved item was before, when it's renamed or moved to the other folder. */
interface Previous {
  name?: string;
  scope?: Scope;
}

/**
 * Saves a role as roles/<name>.md in the given folder. With `previous`, the old file goes (a
 * rename or a move), unless it's the same file.
 */
export function saveRole(scopes: ScopeDir[], b: Record<string, unknown>): string {
  const name = checkName(b.name, 'role');
  const dir = dirOf(scopes, b.scope);
  const harness = str(b.harness);
  if (!harness) throw new Error('A role needs a harness.');
  const file = join(dir, 'roles', `${name}.md`);
  const prev = (b.previous ?? {}) as Previous;
  const prevFile = prev.name ? join(dirOf(scopes, prev.scope ?? b.scope), 'roles', `${checkName(prev.name, 'role')}.md`) : undefined;
  if (file !== prevFile && existsSync(file)) throw new Error(`There's already a role called ${name} in the ${String(b.scope)} folder.`);
  const old = prevFile && existsSync(prevFile) ? readFileSync(prevFile, 'utf8') : '';
  const extra = Object.entries(parseFrontMatter(old).meta).filter(([k]) => !ROLE_KEYS.includes(k));
  const allow = strList(b.allow);
  writeDoc(
    file,
    [
      ['harness', harness],
      ['model', str(b.model)],
      ['fallback', strList(b.fallback).join(', ')],
      ['good_at', str(b.goodAt)],
      ['helper', b.helper === true ? 'true' : ''],
      ['worktree', b.worktree === true ? 'true' : ''],
      ['workflow', str(b.workflow)],
      ['mcp', strList(b.mcp).join(', ')],
      ['auto_approve', b.autoApprove === 'none' ? 'none' : ''],
      ['permission_mode', str(b.permissionMode)],
      ['allow', allow.join(', ')],
      ...extra,
    ],
    str(b.instructions),
    leadingComments(old),
  );
  if (prevFile && prevFile !== file) rmSync(prevFile, { force: true });
  return file;
}

/** Saves a workflow as workflows/<name>.md; an old playbooks/<name>.md of the same name moves there. */
export function saveWorkflow(scopes: ScopeDir[], b: Record<string, unknown>): string {
  const name = checkName(b.name, 'workflow');
  const dir = dirOf(scopes, b.scope);
  const body = str(b.body);
  if (!body) throw new Error('A workflow needs its steps: what the lead should do.');
  const file = join(dir, 'workflows', `${name}.md`);
  const prev = (b.previous ?? {}) as Previous;
  const prevDir = prev.name ? dirOf(scopes, prev.scope ?? b.scope) : undefined;
  const prevFiles = prev.name && prevDir ? ['workflows', 'playbooks'].map(sub => join(prevDir, sub, `${checkName(prev.name, 'workflow')}.md`)) : [];
  if (!prevFiles.includes(file) && existsSync(file)) throw new Error(`There's already a workflow called ${name} in the ${String(b.scope)} folder.`);
  const oldFile = prevFiles.find(existsSync);
  const old = oldFile ? readFileSync(oldFile, 'utf8') : '';
  const extra = Object.entries(parseFrontMatter(old).meta).filter(([k]) => k !== 'good_at');
  writeDoc(file, [['good_at', str(b.goodAt)], ...extra], body, leadingComments(old));
  for (const f of prevFiles) if (f !== file) rmSync(f, { force: true });
  return file;
}

export function deleteItem(scopes: ScopeDir[], kind: 'role' | 'workflow', b: Record<string, unknown>): string {
  const name = checkName(b.name, kind);
  const dir = dirOf(scopes, b.scope);
  const files = kind === 'role' ? [join(dir, 'roles', `${name}.md`)] : [join(dir, 'workflows', `${name}.md`), join(dir, 'playbooks', `${name}.md`)];
  const found = files.filter(existsSync);
  if (!found.length) throw new Error(`There's no ${kind} called ${name} in the ${String(b.scope)} folder.`);
  for (const f of found) rmSync(f);
  return found[0];
}

const GUIDES: Record<string, string> = { methodology: 'methodology.md', 'helper-methodology': 'helper-methodology.md' };

/** Saves the team guidelines (or the helpers'); empty text removes the file, so the folder before it (or the built-in text) applies. */
export function saveGuide(scopes: ScopeDir[], b: Record<string, unknown>): string {
  const which = str(b.which);
  if (!GUIDES[which]) throw new Error(`"which" is methodology or helper-methodology.`);
  const file = join(dirOf(scopes, b.scope), GUIDES[which]);
  const text = str(b.text);
  if (!text) {
    rmSync(file, { force: true });
    return file;
  }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text + '\n');
  return file;
}

/** Adds, changes or (with no `def`) removes one server in a folder's mcp.json, keeping the rest of the file. */
export function saveMcp(scopes: ScopeDir[], b: Record<string, unknown>): string {
  const name = checkName(b.name, 'server');
  const file = join(dirOf(scopes, b.scope), 'mcp.json');
  let doc: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${file} isn't valid JSON (${(e as Error).message}); fix it by hand first.`);
    }
  }
  const servers = { ...(doc.mcpServers ?? {}) };
  const prev = (b.previous ?? {}) as Previous;
  if (prev.name && prev.name !== name && (prev.scope ?? b.scope) === b.scope) delete servers[prev.name];
  if (b.def === undefined || b.def === null) delete servers[name];
  else {
    const def = b.def as McpServerDef;
    if (typeof def !== 'object' || (!def.command && !def.url)) throw new Error('A server needs a command to run or a URL.');
    servers[name] = def;
  }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...doc, mcpServers: servers }, null, 2) + '\n');
  return file;
}
