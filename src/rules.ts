import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { parseFrontMatter } from './config.ts';
import type { ToolRequest } from './adapters/types.ts';

/**
 * Rules (design §18): short notes MetaHarness hands an agent at a moment it can see: the start
 * of a session, a tool call that names a path, a new file, a commit, a call to done. Each is a
 * markdown file in rules/; this module reads them and decides which ones fire. The daemon only
 * delivers what comes out.
 */

export type RuleWhen = 'start' | 'path' | 'new-file' | 'commit' | 'done';
export const RULE_WHENS: RuleWhen[] = ['start', 'path', 'new-file', 'commit', 'done'];

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';
const CHANGE_KINDS: ChangeKind[] = ['added', 'modified', 'deleted', 'renamed'];

export interface Rule {
  name: string;
  when: RuleWhen;
  /** One line: what the rule is for. Agents see it in their prompt, and the Rules page lists it. */
  description: string;
  body: string;
  /** all, team, helpers, lead, role names, and !name to leave one out. */
  roles: string[];
  /** Globs relative to the repository, and !glob to leave some out. */
  paths: string[];
  /** Harness ids it's for, and !id to leave one out; empty: every harness. */
  harness: string[];
  /** A skill the note points at (src/skills.ts): only for agents that carry it. */
  skill?: string;
  /** A repository file whose path-headed sections come along (path rules). */
  sections?: string;
  /** A repository file whose text follows the body, when it exists. */
  include?: string;
  /** Only while this repository file exists. */
  requires?: string;
  /** Only while this repository file doesn't exist. */
  missing?: string;
  /** Commit rules: the kinds of change that count. */
  changes: ChangeKind[];
  /** Commit rules: commits that also change this file don't count. */
  unlessChanged?: string;
  /** Done rules: only for agents that changed files in the repository. */
  edited: boolean;
  /** Turned off by a same-named file or by the settings. */
  off: boolean;
  file: string;
}

/** Built-in rules and workflows: the default pack, which a folder's file of the same name replaces. */
export const BUILTIN_DIR = join(import.meta.dirname, '..', 'defaults');

const truthy = (v?: string) => /^(true|yes|1|on)$/i.test(v ?? '');
const list = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

export function parseRule(name: string, text: string, file: string): Rule {
  const { meta, body } = parseFrontMatter(text);
  const when = (RULE_WHENS as string[]).includes(meta.when ?? '') ? (meta.when as RuleWhen) : 'start';
  const changes = list(meta.changes).filter((c): c is ChangeKind => (CHANGE_KINDS as string[]).includes(c));
  return {
    name,
    when,
    description: meta.description || meta.good_at || body.split('\n').find(l => l.trim())?.trim().slice(0, 160) || '',
    body,
    roles: list(meta.roles).length ? list(meta.roles) : ['all'],
    paths: list(meta.paths).length ? list(meta.paths) : ['**'],
    harness: list(meta.harness ?? meta.harnesses),
    skill: meta.skill || undefined,
    sections: meta.sections || undefined,
    include: meta.include || undefined,
    requires: meta.requires || undefined,
    missing: meta.missing || undefined,
    changes: changes.length ? changes : CHANGE_KINDS,
    unlessChanged: meta.unless_changed || undefined,
    edited: truthy(meta.edited),
    off: truthy(meta.off),
    file,
  };
}

/** The rules in one config folder. */
export function loadRuleFiles(dir: string): Rule[] {
  const d = join(dir, 'rules');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(f => f.endsWith('.md'))
    .map(f => parseRule(basename(f, '.md'), readFileSync(join(d, f), 'utf8'), join(d, f)));
}

/**
 * Rules from each folder in order, a later file replacing an earlier one of the same name, then
 * the settings' switches. Rules that are off stay in the map, marked off.
 */
export function loadRules(dirs: string[], switches: Record<string, boolean> = {}): Map<string, Rule> {
  const out = new Map<string, Rule>();
  for (const dir of dirs) {
    for (const r of loadRuleFiles(dir)) {
      // An "off" file with no body of its own only turns the earlier rule off.
      const before = out.get(r.name);
      out.set(r.name, r.off && before && !r.body ? { ...before, off: true, file: r.file } : r);
    }
  }
  for (const [name, on] of Object.entries(switches)) {
    const r = out.get(name);
    if (r) r.off = !on;
  }
  return out;
}

/* ---------------- who a rule is for ---------------- */

export interface RuleAgent {
  role: string;
  /** A quick helper, or an agent in a helper role. */
  helper: boolean;
  lead: boolean;
  /** Its harness id, for harness: lines. */
  harness?: string;
}

export function forHarness(harnesses: string[], harness: string): boolean {
  const out = harnesses.filter(h => h.startsWith('!')).map(h => h.slice(1));
  const inc = harnesses.filter(h => !h.startsWith('!'));
  return (inc.length ? inc.includes(harness) : true) && !out.includes(harness);
}

export function appliesTo(rule: Pick<Rule, 'roles'> & Partial<Pick<Rule, 'harness'>>, a: RuleAgent): boolean {
  if (rule.harness?.length && a.harness && !forHarness(rule.harness, a.harness)) return false;
  const is = (t: string) => t === 'all' || (t === 'team' && !a.helper) || (t === 'helpers' && a.helper) || (t === 'lead' && a.lead) || t === a.role;
  const out = rule.roles.filter(t => t.startsWith('!')).map(t => t.slice(1));
  const inc = rule.roles.filter(t => !t.startsWith('!'));
  return (inc.length ? inc.some(is) : true) && !out.some(is);
}

/** requires: and missing:, against the agent's working folder. */
function holds(rule: Rule, cwd: string): boolean {
  if (rule.requires && !existsSync(join(cwd, rule.requires))) return false;
  if (rule.missing && existsSync(join(cwd, rule.missing))) return false;
  return true;
}

/* ---------------- paths ---------------- */

/** A glob as a regular expression: ** any depth, * within one folder, ? one character, {a,b} either. */
export function globRegex(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      // "**/" matches no folder too.
      re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += g[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${g.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  // A folder's glob also covers what's inside it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function matchesPaths(path: string, globs: string[]): boolean {
  const inc = globs.filter(g => !g.startsWith('!'));
  const out = globs.filter(g => g.startsWith('!')).map(g => g.slice(1));
  return (inc.length ? inc.some(g => globRegex(g).test(path)) : true) && !out.some(g => globRegex(g).test(path));
}

/** Commands whose plain arguments (no slash, no extension) are paths: ls src, rg foo lib. */
const NAV_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'less', 'more', 'rg', 'grep', 'egrep', 'ag', 'fd', 'find', 'tree', 'wc', 'sed', 'awk', 'bat', 'cd', 'stat', 'file', 'du']);
const SKIP = /^(\.git|node_modules)(\/|$)/;

/** What the adapter knows about a tool call besides its name and summary. */
export interface ToolInfo {
  kind?: ToolRequest['kind'];
  /** Files the call created, when the harness says (Codex reports a change once it's applied). */
  created?: string[];
}

/** Shell commands and file edits, from the adapter's kind or, without one, the tool's name. */
function kindOf(tool: string, info?: ToolInfo): { shell: boolean; write: boolean } {
  if (info?.kind) return { shell: info.kind === 'shell', write: info.kind === 'edit' };
  return { shell: /^(bash|shell|run_command|exec)$/i.test(tool), write: /^(write|edit|multiedit|notebookedit)$/i.test(tool) };
}

export interface ToolPath {
  /** Relative to the working folder, with forward slashes. */
  path: string;
  exists: boolean;
}

/** A path relative to the working folder, or undefined when it's outside it (or in .git, node_modules). */
function inRepo(p: string, cwd: string): string | undefined {
  const rel = relative(cwd, isAbsolute(p) ? p : join(cwd, p)).split(sep).join('/');
  return !rel || rel.startsWith('..') || isAbsolute(rel) || SKIP.test(rel) ? undefined : rel;
}

/**
 * The repository paths a tool call names, read from its one-line summary: a file path, a search
 * path, a command's arguments. The same on every harness, since each reports a summary. Paths
 * that don't exist count only for an edit (a file being created).
 */
export function pathsIn(summary: string, cwd: string, how: { shell: boolean; write: boolean }): ToolPath[] {
  const out = new Map<string, ToolPath>();
  for (const segment of summary.split(/&&|\|\||[;|\n]/)) {
    const words = segment.split(/[\s,(){}'"`<>=]+/).filter(Boolean);
    const cmd = words[0]?.replace(/^.*\//, '') ?? '';
    for (const [i, raw] of words.entries()) {
      if (how.shell && i === 0) continue;
      let w = raw.replace(/:\d+(:\d+)?$/, '').replace(/[.,:;]+$/, '');
      if (!w || w.startsWith('-') || w.startsWith('$') || w.startsWith('~') || /^[a-z][\w+.-]*:\/\//i.test(w)) continue;
      // A glob counts as the folder it starts in.
      const glob = w.search(/[*?[]/);
      if (glob >= 0) w = w.slice(0, glob).replace(/\/[^/]*$/, '');
      if (!w) continue;
      const pathLike = w.includes('/') || /\.\w{1,8}$/.test(w);
      if (how.shell && !pathLike && !NAV_COMMANDS.has(cmd)) continue;
      const rel = inRepo(w, cwd);
      if (!rel) continue;
      const exists = existsSync(join(cwd, rel));
      if (!exists && !(how.write && pathLike && glob < 0)) continue;
      out.set(rel, { path: rel, exists });
    }
  }
  return [...out.values()];
}

/* ---------------- a map's sections ---------------- */

export interface MapSection {
  /** The path its heading names, without a trailing slash. */
  path: string;
  /** Its heading and everything under it, nested sections included. */
  text: string;
  /** The paths of the sections nested in it, which come along with it. */
  nested: string[];
}

export interface MapDoc {
  /** Everything outside path sections: the title, the overview, where things go. */
  overview: string;
  sections: MapSection[];
}

/** The path a heading names: its first word, when that's a path in the repository. */
function headingPath(title: string, cwd: string): string | undefined {
  const first = title.trim().replace(/^[`*_]+/, '').split(/[`*_\s]/)[0]?.replace(/:$/, '') ?? '';
  const p = first.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!p || p.startsWith('..') || isAbsolute(p)) return undefined;
  return first.includes('/') || existsSync(join(cwd, p)) ? p : undefined;
}

/**
 * Splits a map into its overview and its path sections (design §18). A section runs to the next
 * heading of its level or higher, so a nested path heading is a section of its own inside it.
 */
export function parseMap(text: string, cwd: string): MapDoc {
  const sections: MapSection[] = [];
  const overview: string[] = [];
  const open: { path: string; level: number; lines: string[]; nested: string[] }[] = [];
  const close = (level: number) => {
    while (open.length && open.at(-1)!.level >= level) {
      const o = open.pop()!;
      sections.push({ path: o.path, text: o.lines.join('\n').trim(), nested: o.nested });
    }
  };
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      close(h[1].length);
      const path = headingPath(h[2], cwd);
      if (path) {
        for (const o of open) o.nested.push(path);
        open.push({ path, level: h[1].length, lines: [], nested: [] });
      }
    }
    if (open.length) for (const o of open) o.lines.push(line);
    else overview.push(line);
  }
  close(0);
  return { overview: overview.join('\n').trim(), sections };
}

/** The deepest section containing a path. */
export function sectionFor(doc: MapDoc, path: string): MapSection | undefined {
  return doc.sections
    .filter(s => path === s.path || path.startsWith(s.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

const cap = (text: string, max: number, file: string) => (text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n… (more in ${file})`);
const OVERVIEW_MAX = 3000;
const SECTION_MAX = 2500;
const INCLUDE_MAX = 6000;

function readRepoFile(cwd: string, file: string): string | undefined {
  try {
    const p = join(cwd, file);
    return statSync(p).isFile() ? readFileSync(p, 'utf8').trim() : undefined;
  } catch {
    return undefined;
  }
}

/* ---------------- what an agent has had ---------------- */

/** One session's worth: a fresh session starts over, a resumed one keeps it. */
export class RuleState {
  fired = new Set<string>();
  /** Per path rule: the overview ('') and the section paths already given. */
  given = new Map<string, Set<string>>();
  /** It changed files in the repository. */
  edited = false;
}

export interface RuleNote {
  rule: string;
  when: RuleWhen;
  paths: string[];
  text: string;
}

const head = (r: Pick<Rule, 'name'>) => `[MetaHarness · rule ${r.name}]`;

function withInclude(rule: Rule, cwd: string): string {
  const inc = rule.include && readRepoFile(cwd, rule.include);
  return inc ? `${rule.body}\n\n${rule.include}:\n\n${cap(inc, INCLUDE_MAX, rule.include!)}` : rule.body;
}

const TRIGGER: Record<Exclude<RuleWhen, 'start'>, string> = {
  path: 'when you look at files',
  'new-file': 'when you create a file',
  commit: 'when you commit',
  done: 'when you call done',
};

/**
 * The Rules part of an agent's prompt: the start rules in full, and a line for each of the
 * others so the agent knows their notes will come. Empty when no rule is for this agent.
 */
export function rulesPrompt(rules: Iterable<Rule>, a: RuleAgent, cwd: string): string {
  const mine = [...rules].filter(r => !r.off && appliesTo(r, a) && holds(r, cwd));
  const start = mine.filter(r => r.when === 'start');
  const later = mine.filter(r => r.when !== 'start');
  if (!start.length && !later.length) return '';
  const parts = ['## Rules'];
  for (const r of start) parts.push(`### ${r.name}\n\n${withInclude(r, cwd)}`);
  if (later.length) {
    const lines = later.map(r => {
      const where = r.paths.join(', ') === '**' ? '' : ` (${r.paths.join(', ')})`;
      return `- ${r.name}, ${TRIGGER[r.when as Exclude<RuleWhen, 'start'>]}${where}: ${r.description}`;
    });
    parts.push(`MetaHarness adds notes from these rules to what reaches you while you work (tool results, messages), each marked "${head({ name: '<name>' })}":\n\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** A tool call: path rules for what it looks at, new-file rules for what it creates. */
/** The paths a tool call names, relative to the working folder, and whether it edits them (an edit tool, not a command). */
export function toolPaths(tool: string, summary: string, cwd: string, info?: ToolInfo): { paths: ToolPath[]; edit: boolean } {
  const how = kindOf(tool, info);
  const paths = pathsIn(summary, cwd, how);
  for (const c of info?.created ?? []) {
    const rel = inRepo(c, cwd);
    const p = rel && paths.find(x => x.path === rel);
    if (p) p.exists = false;
    else if (rel) paths.push({ path: rel, exists: false });
  }
  return { paths, edit: how.write };
}

export function onToolCall(rules: Iterable<Rule>, a: RuleAgent, cwd: string, st: RuleState, tool: string, summary: string, info?: ToolInfo): RuleNote[] {
  const how = kindOf(tool, info);
  const { paths } = toolPaths(tool, summary, cwd, info);
  if (!paths.length) return [];
  if (how.write) st.edited = true;
  const out: RuleNote[] = [];
  for (const r of rules) {
    if (r.off || !appliesTo(r, a)) continue;
    if (r.when === 'path') {
      const note = pathNote(r, cwd, st, paths.map(p => p.path));
      if (note) out.push(note);
    } else if (r.when === 'new-file' && how.write && !st.fired.has(r.name)) {
      const created = paths.filter(p => !p.exists && matchesPaths(p.path, r.paths)).map(p => p.path);
      if (!created.length || !holds(r, cwd)) continue;
      st.fired.add(r.name);
      out.push({ rule: r.name, when: r.when, paths: created, text: `${head(r)} You created ${created.join(', ')}.\n${withInclude(r, cwd)}` });
    }
  }
  return out;
}

function pathNote(r: Rule, cwd: string, st: RuleState, touched: string[]): RuleNote | undefined {
  const hits = touched.filter(p => matchesPaths(p, r.paths));
  if (!hits.length || !holds(r, cwd)) return undefined;
  if (!r.sections) {
    if (st.fired.has(r.name)) return undefined;
    st.fired.add(r.name);
    return { rule: r.name, when: r.when, paths: hits, text: `${head(r)} You're looking at ${hits.join(', ')}.\n${withInclude(r, cwd)}` };
  }
  const given = st.given.get(r.name) ?? new Set<string>();
  st.given.set(r.name, given);
  if (given.has('*')) return undefined;
  // Reading the map itself: it has everything already.
  if (hits.includes(r.sections)) {
    given.add('*');
    return undefined;
  }
  const text = readRepoFile(cwd, r.sections);
  if (text === undefined) return undefined;
  const doc = parseMap(text, cwd);
  const fresh = [...new Map(hits.map(p => [p, sectionFor(doc, p)] as const).filter(([, s]) => s && !given.has(s.path)).map(([, s]) => [s!.path, s!])).values()];
  const first = !given.has('');
  if (!first && !fresh.length) return undefined;
  const parts: string[] = [];
  if (first) {
    given.add('');
    st.fired.add(r.name);
    parts.push(`${head(r)} You're looking at ${hits.join(', ')}.\n${withInclude(r, cwd)}`);
    if (doc.overview) parts.push(cap(doc.overview, OVERVIEW_MAX, r.sections));
  } else {
    parts.push(`${head(r)} From ${r.sections}, for ${fresh.map(s => s.path + '/').join(', ')}:`);
  }
  for (const s of fresh) {
    if (given.has(s.path)) continue;
    given.add(s.path);
    for (const n of s.nested) given.add(n);
    parts.push(cap(s.text, SECTION_MAX, r.sections));
  }
  return { rule: r.name, when: r.when, paths: hits, text: parts.join('\n\n') };
}

export interface CommitFile {
  kind: ChangeKind;
  path: string;
  /** Where a renamed file came from. */
  from?: string;
}

/** A commit by the agent (not a merge): commit rules for the files it changed. */
export function onCommit(rules: Iterable<Rule>, a: RuleAgent, cwd: string, st: RuleState, sha: string, files: CommitFile[]): RuleNote[] {
  if (files.length) st.edited = true;
  const out: RuleNote[] = [];
  for (const r of rules) {
    if (r.off || r.when !== 'commit' || !appliesTo(r, a) || !holds(r, cwd)) continue;
    if (r.unlessChanged && files.some(f => f.path === r.unlessChanged || f.from === r.unlessChanged)) continue;
    const hits = files.filter(f => r.changes.includes(f.kind) && (matchesPaths(f.path, r.paths) || (!!f.from && matchesPaths(f.from, r.paths))));
    if (!hits.length) continue;
    const shown = hits.slice(0, 8).map(f => (f.kind === 'renamed' ? `renamed ${f.from} → ${f.path}` : `${f.kind} ${f.path}`));
    if (hits.length > 8) shown.push(`and ${hits.length - 8} more`);
    out.push({ rule: r.name, when: r.when, paths: hits.map(f => f.path), text: `${head(r)} Your commit ${sha.slice(0, 7)} ${shown.join(', ')}.\n${withInclude(r, cwd)}` });
  }
  return out;
}

/**
 * The agent called done: the done rules it hasn't had this session, as the reply that holds the
 * done back once. Undefined when there are none, and the done goes through.
 */
export function onDone(rules: Iterable<Rule>, a: RuleAgent, cwd: string, st: RuleState): RuleNote | undefined {
  const due = [...rules].filter(r => !r.off && r.when === 'done' && !st.fired.has(r.name) && appliesTo(r, a) && (!r.edited || st.edited) && holds(r, cwd));
  if (!due.length) return undefined;
  for (const r of due) st.fired.add(r.name);
  const text = [...due.map(r => `${head(r)} Before you finish:\n${withInclude(r, cwd)}`), "Your done wasn't sent yet. When that's settled, call done again (it goes through then)."].join('\n\n');
  return { rule: due.map(r => r.name).join(', '), when: 'done', paths: [], text };
}
