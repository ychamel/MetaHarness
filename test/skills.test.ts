import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeScript } from '../src/adapters/fake.ts';
import { agyHiddenSkills } from '../src/adapters/agy.ts';
import { claudeArgs } from '../src/adapters/claude.ts';
import type { SessionSpec } from '../src/adapters/types.ts';
import { configView, saveRole, saveRule } from '../src/configedit.ts';
import { Daemon } from '../src/daemon.ts';
import { git } from '../src/git.ts';
import { onToolCall, parseRule, rulesPrompt, RuleState } from '../src/rules.ts';
import { claimedSkills, loadSkills, nativeSkillNames, skillLayers, skillPart, skillsFor, skillsPrompt, skillSummary, withSkills } from '../src/skills.ts';
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
    '.claude/skills/frontend/SKILL.md': skill('description: building UI components'),
    '.agents/skills/release/SKILL.md': skill('description: writing release notes'),
    '.agents/skills/claude-only/SKILL.md': skill('description: Claude Code tricks\nharness: claude-code'),
    '.metaharness/skills/notes/SKILL.md': skill('description: notes in this repository'),
    'ui/app.tsx': 'export {};\n',
  });
  return { personal, repo, dirs: [personal, join(repo, '.metaharness')] };
}

const agent = (skills: string[] = [], harness = 'codex') => ({ harness, skills });
/** implementer carries frontend, lead carries release; nobody names the others. */
const claimed = claimedSkills([{ skills: ['frontend'] }, { skills: ['release'] }, {}]);

test('skills: layers, overrides, switches, and which roles carry them', () => {
  const { repo, dirs } = setup();
  const layers = skillLayers(dirs, repo, false);
  assert.deepEqual(layers.map(l => l.source), ['personal', '.claude', '.agents', 'repo']);
  const skills = loadSkills(layers, { release: false });
  assert.deepEqual([...skills.keys()].sort(), ['claude-only', 'frontend', 'notes', 'pdf', 'release']);
  assert.equal(skills.get('notes')!.source, 'repo', "the repository's own replaces the personal one");
  assert.equal(skills.get('notes')!.description, 'notes in this repository');
  assert.ok(skills.get('release')!.off, 'turned off in the settings');

  const names = (a: ReturnType<typeof agent>) => skillsFor(skills.values(), a, claimed).map(s => s.name);
  assert.deepEqual(names(agent(['frontend'])), ['frontend', 'notes', 'pdf'], 'its own, plus those no role names');
  assert.deepEqual(names(agent([], 'claude-code')), ['claude-only', 'notes', 'pdf'], 'harness: keeps one to Claude Code; frontend is the implementer\'s');
  assert.deepEqual(names(agent(['release'])), ['notes', 'pdf'], 'release is named by this role, but it is off');

  assert.deepEqual(nativeSkillNames(join(repo, '.claude', 'skills')), ['frontend']);
});

test('skills: the prompt names the skills an agent carries; a rule can point at one when the moment comes', () => {
  const { repo, dirs } = setup();
  const skills = loadSkills(skillLayers(dirs, repo, false));
  const mine = skillsFor(skills.values(), agent(['frontend']), claimed);
  const prompt = skillsPrompt(mine);
  assert.match(prompt, /^## Skills\n\nGuides for particular kinds of work[\s\S]*skill\("<name>", part\)/);
  assert.match(prompt, /- frontend: building UI components\n- notes: notes in this repository\n- pdf: filling PDF forms/);
  assert.equal(skillsPrompt([]), '');

  const pointer = parseRule('ui-skill', '---\nwhen: path\npaths: ui/**\nskill: frontend\n---\n', 'ui-skill.md');
  const both = parseRule('ui-note', '---\nwhen: path\npaths: ui/**\nskill: frontend\n---\nComponents live in ui/.', 'ui-note.md');
  const rules = withSkills([pointer, both], mine);
  assert.equal(rules[0].description, 'points to the skill frontend');
  const notes = onToolCall(rules, { role: 'implementer', helper: false, lead: false }, repo, new RuleState(), 'read', 'ui/app.tsx', { kind: 'read' });
  assert.deepEqual(notes.map(n => n.rule), ['ui-skill', 'ui-note']);
  assert.match(notes[0].text, /^\[MetaHarness · rule ui-skill\] You're looking at ui\/app.tsx\.\nThe skill frontend may help here: building UI components\nRead it with skill\("frontend"\)/);
  assert.match(notes[1].text, /\nComponents live in ui\/\.\n\nThe skill frontend may help here/, "the rule's own text, then the pointer");
  assert.match(rulesPrompt(rules, { role: 'implementer', helper: false, lead: false }, repo), /- ui-skill, when you look at files \(ui\/\*\*\): points to the skill frontend/);

  const without = skillsFor(skills.values(), agent([]), claimed);
  assert.deepEqual(withSkills([pointer, both], without), [], "an agent that doesn't carry the skill doesn't get rules pointing at it");
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

function team(scripts: Record<string, FakeScript>, roleSkills: Record<string, string> = {}) {
  const { personal, repo } = setup();
  put(personal, Object.fromEntries(Object.keys(scripts).map(n => [`roles/${n}.md`, `---\nharness: fake\nmodel: m\n${roleSkills[n] ? `skills: ${roleSkills[n]}\n` : ''}---\nYou do ${n} things.\n`])));
  put(personal, { 'roles/reviewer.md': '---\nharness: fake\nmodel: m\nskills: claude-only\n---\nReview.\n' });
  put(repo, { '.metaharness/rules/ui-skill.md': '---\nwhen: path\npaths: ui/**\nskill: frontend\n---\n' });
  writeFileSync(join(personal, 'settings.json'), JSON.stringify({ skills: { release: false } }));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Skills');
  const fake = new FakeAdapter(scripts);
  const d = new Daemon({ home: mkdtempSync(join(tmpdir(), 'mh-home-')), repo, dbPath: ':memory:', configDirs: [personal, join(repo, '.metaharness')], adapters: { fake }, pollMs: 0, settings: { approvals: 'ask' } });
  return { d, fake, repo, personal };
}

test('skills in a run: listed, pointed at by a rule, read through the tool', async () => {
  const seen: Record<string, string | null> = {};
  const { d, fake } = team(
    {
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
    },
    { implementer: 'frontend, release' },
  );
  const goal = d.startGoal({ request: 'Build the page', lead: 'implementer' });
  await withTimeout(d.goals.get(goal)!.leadDone, 10_000, 'lead done');

  assert.match(fake.started[0].spec.systemPrompt, /## Skills[\s\S]*- frontend: building UI components\n- notes: notes in this repository\n- pdf/);
  assert.match(seen.list!, /^Skills:\n- frontend: building UI components\n- notes:/);
  assert.match(seen.note!, /^\[MetaHarness · rule ui-skill\] You're looking at ui\/app.tsx\.\nThe skill frontend may help here/);
  assert.match(seen.summary!, /^# Skill: pdf[\s\S]*Sections of SKILL.md/);
  assert.match(seen.part!, /print\("fields"\)/);
  assert.match(seen.guess!, /^\(Took "frontnd" to mean frontend\.\)\n# Skill: frontend/);
  assert.match(seen.notMine!, /^Your role \(implementer on fake\) doesn't carry the skill claude-only\./);
  assert.match(seen.off!, /^The skill release is turned off\./);

  const events = d.store.since(goal).filter(e => e.type === 'skill.read' || (e.type === 'rule.fired' && e.data.skill)).map(e => `${e.type} ${e.data.skill}${e.data.part ? ` ${e.data.part}` : ''}`);
  assert.deepEqual(events, ['rule.fired frontend', 'skill.read pdf', 'skill.read pdf scripts/fields.py', 'skill.read frontend']);
});

test('skills in the app: each with its folder, what it replaces, its files and its switch', () => {
  const { repo, personal } = setup();
  writeFileSync(join(personal, 'settings.json'), JSON.stringify({ skills: { pdf: false } }));
  put(personal, { 'roles/designer.md': '---\nharness: codex\nskills: frontend\n---\nDesign.\n', 'rules/ui-skill.md': '---\nwhen: path\nskill: frontend\n---\n' });
  const view = configView([{ scope: 'personal', dir: personal }, { scope: 'repo', dir: join(repo, '.metaharness') }]);
  const by = Object.fromEntries(view.skills.map(s => [s.name, s]));
  assert.equal(by.notes.source, 'repo');
  assert.equal(by.notes.overrides, 'personal');
  assert.equal(by.frontend.source, '.claude');
  assert.equal(by.pdf.on, false);
  assert.equal(by.pdf.switchedBy, 'personal');
  assert.deepEqual(by.pdf.files.map(f => f.path), ['scripts/fields.py', 'scripts/fill.py']);
  assert.deepEqual(by.frontend.carriedBy, ['designer']);
  assert.deepEqual(by.pdf.carriedBy, [], 'no role names it: every role carries it');
  assert.deepEqual(by.frontend.pointedBy, ['ui-skill']);
  assert.deepEqual(view.roles.find(r => r.name === 'designer')!.skills, ['frontend']);

  const scopes = view.scopes;
  const file = saveRule(scopes, { name: 'forms', scope: 'repo', when: 'path', paths: ['forms/**'], skill: 'pdf', body: '' });
  assert.equal(readFileSync(file, 'utf8'), '---\nwhen: path\npaths: forms/**\nskill: pdf\n---\n\n', 'a rule may be only a pointer');
  assert.throws(() => saveRule(scopes, { name: 'empty', scope: 'repo', when: 'path', body: '' }), /or a skill to point at/);
  const role = saveRole(scopes, { name: 'designer', scope: 'personal', harness: 'codex', skills: ['frontend', 'pdf'], previous: { name: 'designer', scope: 'personal' } });
  assert.match(readFileSync(role, 'utf8'), /\nskills: frontend, pdf\n/);
});
