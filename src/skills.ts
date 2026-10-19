import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseFrontMatter } from './config.ts';
import { appliesTo, BUILTIN_DIR, forHarness, type Rule, type RuleAgent } from './rules.ts';

/**
 * Skills (design §18): guides with a folder of resources, in the SKILL.md format the harnesses
 * share. The agent decides when to read one, through the skill tool, on every harness alike.
 * MetaHarness only points at them: a line in the prompt, or a rule-style note at the moment a
 * skill becomes relevant. Reading one gives a summary first (its sections and files), and a
 * section or file on request, so nothing long arrives unasked.
 */

export type SkillWhen = 'start' | 'path' | 'new-file' | 'commit';
export const SKILL_WHENS: SkillWhen[] = ['start', 'path', 'new-file', 'commit'];

/** Where a skill's folder is: MetaHarness's own, ~/.metaharness, or one of the repository's skill folders. */
export type SkillSource = 'built-in' | 'personal' | 'repo' | '.claude' | '.agents';

export interface Skill {
  name: string;
  description: string;
  /** start: a line in the prompt. The others: a note when the moment comes, like a rule's. */
  when: SkillWhen;
  /** all, team, helpers, lead, role names, and !name to leave one out. */
  roles: string[];
  /** Globs relative to the repository (path, new-file, commit). */
  paths: string[];
  /** Harness ids it's for, and !id to leave one out; empty: every harness. */
  harness: string[];
  body: string;
  dir: string;
  file: string;
  source: SkillSource;
  off: boolean;
}

export interface SkillLayer {
  source: SkillSource;
  /** A folder holding one folder per skill. */
  dir: string;
}

const truthy = (v?: string) => /^(true|yes|1|on)$/i.test(v ?? '');
const list = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
const NAME = /^[\w.:-]+$/;

/**
 * Skill folders from least to most specific: the built-in ones, the personal ones, then the
 * repository's: those other harnesses keep (.claude/skills, .agents/skills), and MetaHarness's
 * own .metaharness/skills last.
 */
export function skillLayers(configDirs: string[], repo?: string, builtIn = true): SkillLayer[] {
  const layers: SkillLayer[] = builtIn ? [{ source: 'built-in', dir: join(BUILTIN_DIR, 'skills') }] : [];
  const personal = repo ? configDirs.filter(d => d !== join(repo, '.metaharness')) : configDirs.slice(0, -1);
  const own = configDirs.filter(d => !personal.includes(d));
  for (const d of personal) layers.push({ source: 'personal', dir: join(d, 'skills') });
  if (repo) layers.push({ source: '.claude', dir: join(repo, '.claude', 'skills') }, { source: '.agents', dir: join(repo, '.agents', 'skills') });
  for (const d of own) layers.push({ source: 'repo', dir: join(d, 'skills') });
  return layers;
}

export function parseSkill(folder: string, text: string, dir: string, source: SkillSource): Skill {
  const { meta, body } = parseFrontMatter(text);
  const when = (SKILL_WHENS as string[]).includes(meta.when ?? '') ? (meta.when as SkillWhen) : 'start';
  const name = meta.name && NAME.test(meta.name) ? meta.name : folder;
  return {
    name,
    when,
    description: meta.description || body.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim().slice(0, 160) || '',
    roles: list(meta.roles).length ? list(meta.roles) : ['all'],
    paths: list(meta.paths).length ? list(meta.paths) : ['**'],
    harness: list(meta.harness ?? meta.harnesses),
    body,
    dir,
    file: join(dir, 'SKILL.md'),
    source,
    off: truthy(meta.off),
  };
}

/** The skills in one layer: each folder with a SKILL.md. */
export function loadSkillFolder(layer: SkillLayer): Skill[] {
  if (!existsSync(layer.dir)) return [];
  const out: Skill[] = [];
  for (const e of readdirSync(layer.dir, { withFileTypes: true })) {
    const dir = join(layer.dir, e.name);
    const file = join(dir, 'SKILL.md');
    if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink()) || !existsSync(file)) continue;
    out.push(parseSkill(e.name, readFileSync(file, 'utf8'), dir, layer.source));
  }
  return out;
}

/** Skills from each layer in order, a later one replacing an earlier one of the same name, then the settings' switches. */
export function loadSkills(layers: SkillLayer[], switches: Record<string, boolean> = {}): Map<string, Skill> {
  const out = new Map<string, Skill>();
  for (const layer of layers) for (const s of loadSkillFolder(layer)) out.set(s.name, s);
  for (const [name, on] of Object.entries(switches)) {
    const s = out.get(name);
    if (s) s.off = !on;
  }
  return out;
}

/**
 * The skills in a harness's own folder of a repository (.claude/skills, .agents/skills): what it
 * would load natively, by name and by folder where they differ, to hide them there.
 */
export function nativeSkillNames(dir: string): string[] {
  return [...new Set(loadSkillFolder({ source: 'repo', dir }).flatMap(s => [s.name, s.dir.slice(dir.length + 1)]))];
}

/* ---------------- who a skill is for ---------------- */

export interface SkillAgent extends RuleAgent {
  harness: string;
}

export function skillFor(s: Skill, a: SkillAgent): boolean {
  return !s.off && forHarness(s.harness, a.harness) && appliesTo(s, a);
}

export function skillsFor(skills: Iterable<Skill>, a: SkillAgent): Skill[] {
  return [...skills].filter(s => skillFor(s, a)).sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * A skill with a moment as a rule the rules engine fires: its note names the skill and what it's
 * for, never its text.
 */
export function skillRules(skills: Iterable<Skill>): Rule[] {
  return [...skills]
    .filter(s => !s.off && s.when !== 'start')
    .map(s => ({
      name: `skill:${s.name}`,
      skill: s.name,
      when: s.when,
      description: s.description,
      body: `The skill ${s.name} may help here: ${s.description}\nRead it with skill("${s.name}") if it fits what you're doing.`,
      roles: s.roles,
      paths: s.paths,
      harness: s.harness,
      changes: ['added', 'modified', 'deleted', 'renamed'],
      edited: false,
      off: false,
      file: s.file,
    }));
}

const HOW = 'skill("<name>") gives a summary with its sections and files, and skill("<name>", part) one section or file.';

/** The Skills part of an agent's prompt; empty when no skill is for it. */
export function skillsPrompt(skills: Iterable<Skill>, a: SkillAgent): string {
  const mine = skillsFor(skills, a);
  if (!mine.length) return '';
  const start = mine.filter(s => s.when === 'start');
  const parts = ['## Skills', `Guides for particular kinds of work, with files to go with them. Read one with the \`skill\` tool when it fits: ${HOW}`];
  if (start.length) parts.push(start.map(s => `- ${s.name}: ${s.description}`).join('\n'));
  if (start.length < mine.length) parts.push('Others are suggested when they become relevant, in a note marked "[MetaHarness · skill <name>]". skill() lists every skill for your role.');
  return parts.join('\n\n');
}

/* ---------------- reading one ---------------- */

/** All the skills for an agent, for skill() without a name. */
export function skillList(mine: Skill[]): string {
  if (!mine.length) return 'There are no skills for your role.';
  const moment: Record<SkillWhen, string> = { start: '', path: ' (suggested when you look at files)', 'new-file': ' (suggested when you create a file)', commit: ' (suggested when you commit)' };
  return `Skills:\n${mine.map(s => `- ${s.name}: ${s.description}${moment[s.when]}`).join('\n')}\n\nRead one with ${HOW}`;
}

interface Heading {
  level: number;
  title: string;
  line: number;
}

function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) out.push({ level: h[1].length, title: h[2], line: i });
  }
  return out;
}

const WHOLE_MAX = 2500;
const INTRO_MAX = 1200;
const PART_MAX = 15_000;
const FILES_MAX = 60;

const cap = (text: string, max: number, where: string) =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n… (${text.length - max} more characters in ${where})`;

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const SKIP_FILE = /^(\.|node_modules$|__pycache__$|SKILL\.md$)/;

/** The files in a skill's folder besides SKILL.md, relative, with their sizes. */
export function skillFiles(dir: string, max = FILES_MAX): { files: { path: string; bytes: number }[]; more: number } {
  const files: { path: string; bytes: number }[] = [];
  let more = 0;
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_FILE.test(e.name) && !(depth > 0 && e.name === 'SKILL.md')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= max) more++;
        else files.push({ path: relative(dir, p).split(sep).join('/'), bytes: statSync(p).size });
      }
    }
  };
  walk(dir, 0);
  return { files, more };
}

function filesPart(s: Skill): string {
  const { files, more } = skillFiles(s.dir);
  if (!files.length) return '';
  const lines = files.map(f => `- ${f.path} (${size(f.bytes)})`);
  if (more) lines.push(`- and ${more} more`);
  return `Files in ${s.dir} (read one with skill("${s.name}", part: "<path>")):\n${lines.join('\n')}`;
}

/**
 * What skill(name) gives: the description, then SKILL.md whole when it's short, else its opening
 * and its sections by heading; then the folder's files by path.
 */
export function skillSummary(s: Skill): string {
  const parts = [`# Skill: ${s.name}`, s.description];
  if (s.body.length <= WHOLE_MAX) parts.push(s.body);
  else {
    const lines = s.body.split('\n');
    const hs = headingsOf(lines);
    // A title heading on the first line belongs to the opening.
    const firstText = lines.findIndex(l => l.trim());
    const sections = hs.filter(h => h.line !== firstText);
    const intro = lines.slice(0, sections[0]?.line ?? lines.length).join('\n').trim();
    if (intro) parts.push(cap(intro, INTRO_MAX, 'SKILL.md'));
    if (sections.length) {
      const top = Math.min(...sections.map(h => h.level));
      parts.push(`Sections of SKILL.md (read one with skill("${s.name}", part: "<heading>")):\n${sections.map(h => `${'  '.repeat(h.level - top)}- ${h.title}`).join('\n')}`);
    } else parts.push(`SKILL.md has no sections; read it whole with skill("${s.name}", part: "SKILL.md").`);
  }
  const files = filesPart(s);
  if (files) parts.push(files);
  return parts.filter(Boolean).join('\n\n');
}

/** A file inside the skill's folder (no way out of it, by .. or a link), or undefined. */
function fileIn(s: Skill, part: string): string | undefined {
  const p = join(s.dir, part.replace(/^\.?\//, ''));
  try {
    const real = realpathSync(p);
    const root = realpathSync(s.dir);
    if (real !== root && !real.startsWith(root + sep)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

const norm = (t: string) => t.toLowerCase().replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim();

/** skill(name, part): a section of SKILL.md by its heading, or a file in the skill's folder by its path. */
export function skillPart(s: Skill, part: string): string {
  const file = fileIn(s, part);
  if (file) {
    const buf = readFileSync(file);
    if (buf.includes(0)) return `${part} is a binary file (${size(buf.length)}): ${file}`;
    return `# Skill ${s.name}: ${part}\n\n${cap(buf.toString('utf8'), PART_MAX, file)}`;
  }
  const lines = s.body.split('\n');
  const hs = headingsOf(lines);
  const want = norm(part);
  const h = hs.find(x => norm(x.title) === want) ?? hs.find(x => norm(x.title).includes(want)) ?? hs.find(x => want.includes(norm(x.title)) && norm(x.title).length > 3);
  if (h) {
    const end = hs.find(x => x.line > h.line && x.level <= h.level)?.line ?? lines.length;
    return `# Skill ${s.name}: ${h.title}\n\n${cap(lines.slice(h.line + 1, end).join('\n').trim(), PART_MAX, s.file)}`;
  }
  const sections = hs.map(x => `- ${x.title}`).join('\n');
  const files = filesPart(s);
  return [`The skill ${s.name} has no section or file "${part}".`, sections && `Sections:\n${sections}`, files].filter(Boolean).join('\n\n');
}
