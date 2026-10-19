import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeScript } from '../src/adapters/fake.ts';
import { agyHiddenSkills } from '../src/adapters/agy.ts';
import { claudeArgs } from '../src/adapters/claude.ts';
import type { SessionSpec } from '../src/adapters/types.ts';
import { configView } from '../src/configedit.ts';
import { Daemon } from '../src/daemon.ts';
import { git } from '../src/git.ts';
import { onToolCall, RuleState } from '../src/rules.ts';
import { loadSkills, nativeSkillNames, skillLayers, skillPart, skillRules, skillsFor, skillsPrompt, skillSummary } from '../src/skills.ts';
import { makeRepo, withTimeout } from './helpers.ts';

function put(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const skill = (front: string, body = 'Steps.') => `---\n${front}\n---\n${body}\n`;

const LONG = `# PDF forms

Fill PDF forms with the scripts here. Check the fields first.

## Finding the fields

Run scripts/fields.py on the form.${' Then read what it prints.'.repeat(120)}

## Filling them

### With values

Write a JSON file of values, then run scripts/fill.py.

## Checking the result

Open the output.
`;

/** A personal folder, a repository with skills in .claude, .agents and .metaharness. */
function setup() {
  const personal = mkdtempSync(join(tmpdir(), 'mh-skills-home-'));
  const repo = makeRepo();
  put(personal, {
    'skills/pdf/SKILL.md': skill('name: pdf\ndescription: filling PDF forms', LONG),
    'skills/pdf/scripts/fields.py': 'print("fields")\n',
    'skills/pdf/scripts/fill.py': 'print("fill")\n',
    'skills/pdf/.cache/x': 'hidden',
    'skills/notes/SKILL.md': skill('description: personal notes, replaced by the repository'),
  });
  put(repo, {
    '.claude/skills/frontend/SKILL.md': skill('description: building UI components\nwhen: path\npaths: ui/**\nroles: implementer'),
    '.agents/skills/release/SKILL.md': skill('description: writing release notes\nroles: lead'),
    '.agents/skills/claude-only/SKILL.md': skill('description: Claude Code tricks\nharness: claude-code'),
    '.metaharness/skills/notes/SKILL.md': skill('description: notes in this repository'),
    'ui/app.tsx': 'export {};\n',
  });
  return { personal, repo, dirs: [personal, join(repo, '.metaharness')] };
}

const agent = (role: string, o: { harness?: string; lead?: boolean; helper?: boolean } = {}) => ({ role, harness: o.harness ?? 'codex', lead: !!o.lead, helper: !!o.helper });

test('skills: layers, overrides, switches, and who each is for', () => {
  const { repo, dirs } = setup();
  const layers = skillLayers(dirs, repo, false);
  assert.deepEqual(layers.map(l => l.source), ['personal', '.claude', '.agents', 'repo']);
  const skills = loadSkills(layers, { release: false });
  assert.deepEqual([...skills.keys()].sort(), ['claude-only', 'frontend', 'notes', 'pdf', 'release']);
  assert.equal(skills.get('notes')!.source, 'repo', "the repository's own replaces the personal one");
  assert.equal(skills.get('notes')!.description, 'notes in this repository');
  assert.ok(skills.get('release')!.off, 'turned off in the settings');

  const names = (a: ReturnType<typeof agent>) => skillsFor(skills.values(), a).map(s => s.name);
  assert.deepEqual(names(agent('implementer')), ['frontend', 'notes', 'pdf']);
  assert.deepEqual(names(agent('reviewer', { harness: 'claude-code' })), ['claude-only', 'notes', 'pdf'], 'harness: keeps one to Claude Code');
  assert.deepEqual(names(agent('architect', { lead: true })), ['notes', 'pdf'], 'release would be for the lead, but it is off');

  assert.deepEqual(nativeSkillNames(join(repo, '.claude', 'skills')), ['frontend']);
});

test('skills: the prompt names start skills; the others come as notes when their moment comes', () => {
  const { repo, dirs } = setup();
  const skills = loadSkills(skillLayers(dirs, repo, false));
  const prompt = skillsPrompt(skills.values(), agent('implementer'));
  assert.match(prompt, /^## Skills\n\nGuides for particular kinds of work[\s\S]*skill\("<name>", part\)/);
  assert.match(prompt, /- notes: notes in this repository\n- pdf: filling PDF forms/);
  assert.doesNotMatch(prompt, /frontend/, 'a path skill is suggested later, not listed');
  assert.match(prompt, /Others are suggested when they become relevant/);
  assert.equal(skillsPrompt(skills.values(), { ...agent('x'), harness: 'none' }).includes('frontend'), false);

  const st = new RuleState();
  const rules = skillRules(skills.values());
  const first = onToolCall(rules, agent('implementer'), repo, st, 'read', 'ui/app.tsx', { kind: 'read' });
  assert.equal(first.length, 1);
  assert.equal(first[0].rule, 'skill:frontend');
  assert.match(first[0].text, /^\[MetaHarness · skill frontend\] You're looking at ui\/app.tsx\.\nThe skill frontend may help here: building UI components\nRead it with skill\("frontend"\)/);
  assert.deepEqual(onToolCall(rules, agent('implementer'), repo, st, 'read', 'ui/app.tsx', { kind: 'read' }), [], 'once per session');
  assert.deepEqual(onToolCall(rules, agent('reviewer'), repo, new RuleState(), 'read', 'ui/app.tsx', { kind: 'read' }), [], 'not for that role');
});

test('skills: a summary first, then a section or a file on request', () => {
  const { repo, dirs } = setup();
  const skills = loadSkills(skillLayers(dirs, repo, false));
  const pdf = skills.get('pdf')!;
  const sum = skillSummary(pdf);
  assert.match(sum, /^# Skill: pdf\n\nfilling PDF forms\n\n# PDF forms\n\nFill PDF forms with the scripts here/);
  assert.match(sum, /Sections of SKILL.md[\s\S]*- Finding the fields\n- Filling them\n  - With values\n- Checking the result/);
  assert.doesNotMatch(sum, /Then read what it prints/, 'section bodies stay out of the summary');
  assert.match(sum, /Files in .*pdf \(read one with skill\("pdf", part: "<path>"\)\):\n- scripts\/fields.py \(16 B\)\n- scripts\/fill.py/);
  assert.doesNotMatch(sum, /\.cache/);

  assert.match(skillSummary(skills.get('notes')!), /^# Skill: notes\n\nnotes in this repository\n\nSteps\.$/, 'a short SKILL.md comes whole');

  assert.match(skillPart(pdf, 'filling them'), /^# Skill pdf: Filling them\n\n### With values\n\nWrite a JSON file/);
  assert.doesNotMatch(skillPart(pdf, 'Filling them'), /Checking the result/);
  assert.match(skillPart(pdf, 'scripts/fill.py'), /^# Skill pdf: scripts\/fill.py\n\nprint\("fill"\)/);
  assert.match(skillPart(pdf, 'SKILL.md'), /# PDF forms/);
  assert.match(skillPart(pdf, '../notes/SKILL.md'), /has no section or file/, 'nothing outside its folder');
  symlinkSync('/etc/hostname', join(pdf.dir, 'link'));
  assert.match(skillPart(pdf, 'link'), /has no section or file/, 'nor through a link');
});

test('skills: each harness hides its native copy of the repository skills, unless the role keeps them', () => {
  const { repo } = setup();
  const role = { name: 'r', harness: 'claude-code', model: 'm', fallback: [], goodAt: '', instructions: '', helper: false, allow: [], autoApprove: 'read-only', mcp: [], worktree: false, file: '' };
  const spec = (nativeSkills = false) => ({ cwd: repo, sharedDir: '/s', mcpUrl: 'http://x', systemPrompt: '', mcpServers: [], role: { ...role, nativeSkills } }) as unknown as SessionSpec;
  const args = claudeArgs(spec(), 'id');
  assert.ok(args.includes('Skill(frontend)'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project,local');
  const native = claudeArgs(spec(true), 'id');
  assert.ok(!native.includes('Skill(frontend)'));
  assert.equal(native[native.indexOf('--setting-sources') + 1], 'user,project,local', "native_skills brings the user's own back");

  assert.deepEqual(agyHiddenSkills(spec(), ['mine']).sort(), ['claude-only', 'mine', 'release']);
  assert.deepEqual(agyHiddenSkills(spec(true), ['mine']), []);
});

function team(scripts: Record<string, FakeScript>) {
  const { personal, repo } = setup();
  put(personal, Object.fromEntries(Object.keys(scripts).map(n => [`roles/${n}.md`, `---\nharness: fake\nmodel: m\n---\nYou do ${n} things.\n`])));
  writeFileSync(join(personal, 'settings.json'), JSON.stringify({ skills: { release: false } }));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Skills');
  const fake = new FakeAdapter(scripts);
  const d = new Daemon({ home: mkdtempSync(join(tmpdir(), 'mh-home-')), repo, dbPath: ':memory:', configDirs: [personal, join(repo, '.metaharness')], adapters: { fake }, pollMs: 0, settings: { approvals: 'ask' } });
  return { d, fake, repo, personal };
}

test('skills in a run: listed, suggested at the moment, read through the tool', async () => {
  const seen: Record<string, string | null> = {};
  const { d, fake } = team({
    implementer: async ctx => {
      seen.list = await ctx.tool('skill', {});
      ctx.read('ui/app.tsx');
      seen.note = await ctx.nextMessage(2000);
      seen.summary = await ctx.tool('skill', { name: 'pdf' });
      seen.part = await ctx.tool('skill', { name: 'pdf', part: 'scripts/fields.py' });
      seen.guess = await ctx.tool('skill', 'frontnd');
      seen.notMine = await ctx.tool('skill', { name: 'claude-only' });
      seen.off = await ctx.tool('skill', { name: 'release' });
      await ctx.tool('done', { note: 'ok' });
    },
  });
  const goal = d.startGoal({ request: 'Build the page', lead: 'implementer' });
  await withTimeout(d.goals.get(goal)!.leadDone, 10_000, 'lead done');

  assert.match(fake.started[0].spec.systemPrompt, /## Skills[\s\S]*- notes: notes in this repository/);
  assert.match(seen.list!, /^Skills:\n- frontend: building UI components \(suggested when you look at files\)\n- notes:/);
  assert.match(seen.note!, /^\[MetaHarness · skill frontend\] You're looking at ui\/app.tsx/);
  assert.match(seen.summary!, /^# Skill: pdf[\s\S]*Sections of SKILL.md/);
  assert.match(seen.part!, /print\("fields"\)/);
  assert.match(seen.guess!, /^\(Took "frontnd" to mean frontend\.\)\n# Skill: frontend/);
  assert.match(seen.notMine!, /^The skill claude-only isn't for your role \(implementer\) on fake\./);
  assert.match(seen.off!, /^The skill release is turned off\./);

  const events = d.store.since(goal).filter(e => e.type.startsWith('skill.')).map(e => `${e.type} ${e.data.skill}${e.data.part ? ` ${e.data.part}` : ''}`);
  assert.deepEqual(events, ['skill.suggested frontend', 'skill.read pdf', 'skill.read pdf scripts/fields.py', 'skill.read frontend']);
  assert.equal(d.store.since(goal).filter(e => e.type === 'rule.fired' && String(e.data.rule).startsWith('skill:')).length, 0);
});

test('skills in the app: each with its folder, what it replaces, its files and its switch', () => {
  const { repo, personal } = setup();
  writeFileSync(join(personal, 'settings.json'), JSON.stringify({ skills: { pdf: false } }));
  const view = configView([{ scope: 'personal', dir: personal }, { scope: 'repo', dir: join(repo, '.metaharness') }]);
  const by = Object.fromEntries(view.skills.map(s => [s.name, s]));
  assert.equal(by.notes.source, 'repo');
  assert.equal(by.notes.overrides, 'personal');
  assert.equal(by.frontend.source, '.claude');
  assert.equal(by.pdf.on, false);
  assert.equal(by.pdf.switchedBy, 'personal');
  assert.deepEqual(by.pdf.files.map(f => f.path), ['scripts/fields.py', 'scripts/fill.py']);
  assert.equal(view.skills[view.skills.length - 1].when, 'path', 'start skills first');
});
