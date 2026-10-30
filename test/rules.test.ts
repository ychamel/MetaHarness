import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeScript } from '../src/adapters/fake.ts';
import { agyPersonalSkills, writeAgentConfig } from '../src/adapters/agy.ts';
import { hiddenSkills, isolationConfig } from '../src/adapters/codex.ts';
import type { SessionSpec } from '../src/adapters/types.ts';
import { loadConfig } from '../src/config.ts';
import { Daemon } from '../src/daemon.ts';
import { git } from '../src/git.ts';
import { appliesTo, loadRules, matchesPaths, onCommit, onDone, parseMap, parseRule, pathsIn, RuleState, sectionFor } from '../src/rules.ts';
import { makeRepo, settle, withTimeout } from './helpers.ts';

const MAP = `# Shop

A small shop. Requests come in through src/api and land in src/store.

## Where things go

Shared helpers live in src/util.

## src/api/

The HTTP handlers. One file per resource.

\`\`\`
## not a heading, inside a fence
\`\`\`

### src/api/admin/

Admin-only handlers.

## \`src/store/\`

Storage. Nothing here knows about HTTP.
`;

/** A repository with a map, conventions and a little code. */
function shopRepo(): string {
  const dir = makeRepo();
  for (const [path, text] of Object.entries({
    'ARCHITECTURE.md': MAP,
    'CONVENTIONS.md': 'Handlers are named after their resource.\n',
    'src/api/orders.ts': 'export {};\n',
    'src/api/admin/users.ts': 'export {};\n',
    'src/store/db.ts': 'export {};\n',
    'src/util/money.ts': 'export {};\n',
  })) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Shop');
  return dir;
}

const rule = (name: string, front: string, body = 'Body.') => parseRule(name, `---\n${front}\n---\n${body}\n`, `${name}.md`);

test('rules: globs, roles and layers', () => {
  assert.ok(matchesPaths('src/a/b.ts', ['**']));
  assert.ok(matchesPaths('src/a/b.ts', ['src/**']));
  assert.ok(matchesPaths('src/a', ['src/a']), "a folder's path covers itself");
  assert.ok(matchesPaths('src/a/b.ts', ['src/a']), "a folder's path covers what's inside");
  assert.ok(!matchesPaths('src/a/b.test.ts', ['**', '!**/*.test.*']));
  assert.ok(!matchesPaths('test/x.ts', ['**', '!**/*test*/**']));
  assert.ok(matchesPaths('README.md', ['*.md']) && !matchesPaths('docs/x.md', ['*.md']));
  assert.ok(matchesPaths('ui/a.tsx', ['{ui,web}/**']));

  const team = rule('t', 'roles: team, !reviewer');
  assert.ok(appliesTo(team, { role: 'implementer', helper: false, lead: false }));
  assert.ok(!appliesTo(team, { role: 'reviewer', helper: false, lead: false }));
  assert.ok(!appliesTo(team, { role: 'scout', helper: true, lead: false }));
  assert.ok(appliesTo(rule('l', 'roles: lead'), { role: 'architect', helper: false, lead: true }));
  assert.ok(appliesTo(rule('a', 'when: path'), { role: 'scout', helper: true, lead: false }), 'all by default');

  // Built-in, then a folder replacing one and turning one off, then the settings.
  const personal = mkdtempSync(join(tmpdir(), 'mh-rules-'));
  mkdirSync(join(personal, 'rules'));
  writeFileSync(join(personal, 'rules', 'conventions.md'), '---\nwhen: start\n---\nTabs, always.\n');
  writeFileSync(join(personal, 'rules', 'map.md'), '---\noff: true\n---\n');
  writeFileSync(join(personal, 'settings.json'), JSON.stringify({ rules: { 'finish-clean': false } }));
  const cfg = loadConfig([personal]);
  assert.equal(cfg.rules.get('conventions')!.body, 'Tabs, always.');
  assert.equal(cfg.rules.get('map')!.off, true);
  assert.equal(cfg.rules.get('map')!.when, 'start', 'an off file keeps the rule it turns off');
  assert.equal(cfg.rules.get('finish-clean')!.off, true);
  assert.equal(cfg.rules.get('no-duplicates')!.off, false);
  assert.ok(cfg.workflows.get('map-bootstrap')?.builtIn);
  assert.equal(loadRules([personal], { map: true }).get('map')!.off, false, 'a switch turns a rule back on');
});

test('rules: the paths a tool call names, on any harness', () => {
  const cwd = shopRepo();
  const paths = (summary: string, how = { shell: false, write: false }) => pathsIn(summary, cwd, how).map(p => p.path);
  const shell = { shell: true, write: false };
  assert.deepEqual(paths(join(cwd, 'src/api/orders.ts')), ['src/api/orders.ts']);
  assert.deepEqual(paths('src/**/*.ts'), ['src'], 'a glob counts as the folder it starts in');
  assert.deepEqual(paths(`cd ${cwd} && rg -n "total" src/store && cat src/api/orders.ts:12`, shell), ['src/store', 'src/api/orders.ts']);
  assert.deepEqual(paths('ls src', shell), ['src'], 'a bare word after ls is a path');
  assert.deepEqual(paths('npm test src', shell), [], 'but not after npm');
  assert.deepEqual(paths('cat /etc/passwd ../other/x.ts', shell), [], 'outside the working folder');
  assert.deepEqual(paths('src/api/missing.ts'), [], "a read of something that doesn't exist");
  assert.deepEqual(pathsIn('src/api/new.ts', cwd, { shell: false, write: true }), [{ path: 'src/api/new.ts', exists: false }]);
  assert.deepEqual(paths('src/api/orders.ts, src/store/db.ts'), ['src/api/orders.ts', 'src/store/db.ts'], "Codex's edit lists");
});

test('rules: a map splits into its overview and path sections', () => {
  const cwd = shopRepo();
  const doc = parseMap(MAP, cwd);
  assert.deepEqual(doc.sections.map(s => s.path).sort(), ['src/api', 'src/api/admin', 'src/store']);
  assert.deepEqual(doc.sections.find(s => s.path === 'src/api')!.nested, ['src/api/admin']);
  assert.match(doc.sections.find(s => s.path === 'src/api')!.text, /One file per resource[\s\S]*Admin-only/, 'a nested section is part of its parent');
  assert.match(doc.overview, /A small shop[\s\S]*Where things go[\s\S]*src\/util/);
  assert.doesNotMatch(doc.overview, /HTTP handlers/);
  assert.match(sectionFor(doc, 'src/api/orders.ts')!.text, /HTTP handlers[\s\S]*not a heading/);
  assert.equal(sectionFor(doc, 'src/api/admin/users.ts')!.path, 'src/api/admin', 'the deepest section wins');
  assert.equal(sectionFor(doc, 'src/util/money.ts'), undefined);
});

test('rules: commits and done', () => {
  const cwd = shopRepo();
  const who = { role: 'implementer', helper: false, lead: false };
  const upkeep = parseRule('map-upkeep', readFileSync(join(import.meta.dirname, '..', 'defaults', 'rules', 'map-upkeep.md'), 'utf8'), 'x');
  const st = new RuleState();
  assert.equal(onCommit([upkeep], who, cwd, st, 'abc1234def', [{ kind: 'modified', path: 'src/api/orders.ts' }]).length, 0, 'an edit in place keeps the map right');
  assert.equal(onCommit([upkeep], who, cwd, st, 'abc1234def', [{ kind: 'added', path: 'src/api/orders.test.ts' }]).length, 0, 'tests are left out');
  assert.equal(onCommit([upkeep], who, cwd, st, 'abc1234def', [{ kind: 'added', path: 'src/cart/cart.ts' }, { kind: 'modified', path: 'ARCHITECTURE.md' }]).length, 0, 'the map changed too');
  const [n] = onCommit([upkeep], who, cwd, st, 'abc1234def', [{ kind: 'added', path: 'src/cart/cart.ts' }, { kind: 'renamed', path: 'src/store/sql.ts', from: 'src/store/db.ts' }]);
  assert.match(n.text, /^\[MetaHarness · rule map-upkeep\] Your commit abc1234 added src\/cart\/cart.ts, renamed src\/store\/db.ts → src\/store\/sql.ts\.\nARCHITECTURE.md wasn't changed/);

  const finish = rule('finish', 'when: done\nedited: true', 'Tidy up.');
  const fresh = new RuleState();
  assert.equal(onDone([finish], who, cwd, fresh), undefined, "an agent that changed nothing isn't held back");
  fresh.edited = true;
  assert.match(onDone([finish], who, cwd, fresh)!.text, /Before you finish:\nTidy up\.[\s\S]*call done again/);
  assert.equal(onDone([finish], who, cwd, fresh), undefined, 'once per session');
});

/** A daemon on the shop repository with one fake role per script. */
function shop(scripts: Record<string, FakeScript>, settings: Record<string, unknown> = {}, rules: Record<string, string> = {}) {
  const cfg = mkdtempSync(join(tmpdir(), 'mh-rules-cfg-'));
  mkdirSync(join(cfg, 'roles'));
  mkdirSync(join(cfg, 'rules'));
  for (const [name, text] of Object.entries(rules)) writeFileSync(join(cfg, 'rules', `${name}.md`), text);
  for (const name of Object.keys(scripts)) writeFileSync(join(cfg, 'roles', `${name}.md`), `---\nharness: fake\nmodel: m\ngood_at: ${name} things\n---\nYou do ${name} things.\n`);
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify(settings));
  const repo = shopRepo();
  const fake = new FakeAdapter(scripts);
  const d = new Daemon({ home: mkdtempSync(join(tmpdir(), 'mh-home-')), repo, dbPath: ':memory:', configDirs: [cfg], adapters: { fake }, pollMs: 0, settings: { approvals: 'ask' } });
  return { d, fake, repo };
}

/** A path rule handing out the map's sections as an agent moves, as a repository could add. */
const AREAS = '---\nwhen: path\ndescription: the part of the map for where you are\nsections: ARCHITECTURE.md\n---\nThe map, for where you are.\n';

test('rules in a run: the prompt, sections as an agent moves, new files, commits and done', async () => {
  const seen: Record<string, string | null> = {};
  const { d, fake, repo } = shop({
    coder: async ctx => {
      ctx.read('src/api/orders.ts');
      seen.first = await ctx.nextMessage(2000);
      ctx.read('src/api/orders.ts');
      seen.again = await ctx.nextMessage(200);
      ctx.read('src/store/db.ts');
      seen.store = await ctx.nextMessage(2000);
      ctx.writeFile('src/api/refunds.ts', 'export {};\n');
      seen.created = await ctx.nextMessage(2000);
      ctx.writeFile('src/api/returns.ts', 'export {};\n');
      seen.created2 = await ctx.nextMessage(200);
      await ctx.run('git add -A && git commit -m "Refunds"', 10);
      seen.commit = await ctx.nextMessage(3000);
      seen.done1 = await ctx.tool('done', { note: 'Refunds' });
      seen.done2 = await ctx.tool('done', { note: 'Refunds, tidied' });
    },
  }, {}, { areas: AREAS });
  const goal = d.startGoal({ request: 'Add refunds', lead: 'coder' });
  // The commit the script announces, made here, then seen by the git poll.
  const committed = (async () => {
    while (!seen.created2 && seen.created2 !== null) await settle();
    await settle();
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'Refunds');
    d.refreshGit(goal);
  })();
  await withTimeout(d.goals.get(goal)!.leadDone, 10_000, 'lead done');
  await committed;
  await settle();

  const prompt = fake.started[0].spec.systemPrompt;
  assert.match(prompt, /## Rules\n\n### cartographer\n\nWhen this goal will change code[\s\S]*spawn a `cartographer`[\s\S]*### conventions\n\nWrite code that's readable[\s\S]*CONVENTIONS.md:\n\nHandlers are named after their resource/, 'a lead with a map is told about the cartographer');
  assert.match(prompt, /### docs\n\nThis repository's docs come in layers[\s\S]*## Purpose/, 'the doc layers');
  assert.match(prompt, /### map\n\nThis repository's docs come in layers[\s\S]*Name the 3 to 5 files[\s\S]*ARCHITECTURE.md:\n\n# Shop\n\nA small shop/, 'the map, whole, at the start');
  assert.match(prompt, /- areas, when you look at files: the part of the map/);
  assert.match(prompt, /- no-duplicates, when you create a file \(\*\*, !\*\*\/\*test\*\/\*\*/);
  assert.doesNotMatch(prompt, /map-missing/, 'the repository has a map');

  assert.match(seen.first!, /^\[MetaHarness · rule areas\] You're looking at src\/api\/orders.ts\.\nThe map, for where you are[\s\S]*A small shop[\s\S]*The HTTP handlers/);
  assert.doesNotMatch(seen.first!, /Storage\. Nothing here/);
  assert.equal(seen.again, null, 'the same section only once');
  assert.match(seen.store!, /^\[MetaHarness · rule areas\] From ARCHITECTURE.md, for src\/store\/:\n\n## `src\/store\/`\n\nStorage/);
  assert.doesNotMatch(seen.store!, /A small shop/, 'the overview only once');
  assert.match(seen.created!, /^\[MetaHarness · rule no-duplicates\] You created src\/api\/refunds.ts\.\nBefore you build on it/);
  assert.equal(seen.created2, null, 'new-file rules once per session');
  assert.match(seen.commit!, /rule map-upkeep\] Your commit [0-9a-f]{7} added src\/api\/refunds.ts, added src\/api\/returns.ts/);
  assert.match(seen.done1!, /rule finish-clean\] Before you finish:[\s\S]*call done again/);
  assert.match(seen.done2!, /^Done\. The human has your note\./);

  const fired = d.store.since(goal).filter(e => e.type === 'rule.fired').map(e => e.data.rule);
  assert.deepEqual(fired, ['areas', 'areas', 'no-duplicates', 'map-upkeep', 'finish-clean']);
});

test('rules: a lead in a repository without a map is told it can have one; a switch turns a rule off', async () => {
  const { d, fake, repo } = shop({ lead: async ctx => void (await ctx.tool('done', { note: 'ok' })) }, { rules: { conventions: false } });
  git(repo, 'rm', '-q', 'ARCHITECTURE.md');
  git(repo, 'commit', '-qm', 'No map');
  const goal = d.startGoal({ request: 'Something', lead: 'lead' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  const prompt = fake.started[0].spec.systemPrompt;
  assert.match(prompt, /### map-missing\n\nThis repository has no ARCHITECTURE.md[\s\S]*`map-bootstrap` workflow/);
  assert.match(prompt, /### cartographer\n\nWhen this goal will change code/, 'the cartographer keeps the doc comments, map or not');
  assert.match(prompt, /- doc-bootstrap: giving every file, class and function/, 'and the doc workflow is offered');
  assert.doesNotMatch(prompt, /### conventions/, 'turned off in the settings');
  assert.doesNotMatch(prompt, /### (map|docs)\n/, "no map, so neither the map nor the doc layers");
  assert.match(prompt, /- map-bootstrap: writing the layered docs/, 'the built-in workflow is offered');
});

test('native skills: Codex turns off user and repository skills, Antigravity shadows personal ones', async () => {
  const server = {
    request: async () => ({
      data: [{ skills: [
        { name: 'mine', scope: 'user', path: '/home/u/.codex/skills/mine/SKILL.md' },
        { name: 'imagegen', scope: 'system', path: '/home/u/.codex/skills/.system/imagegen/SKILL.md' },
        { name: 'team', scope: 'repo', path: '/repo/.agents/skills/team/SKILL.md' },
      ] }],
    }),
  };
  const skills = await hiddenSkills(server, '/repo');
  assert.deepEqual(skills, ['/home/u/.codex/skills/mine/SKILL.md', '/repo/.agents/skills/team/SKILL.md'], 'system skills stay; the repository\'s come through the skill tool');
  assert.deepEqual(await hiddenSkills(server, '/repo', true), [], 'native_skills keeps them all');
  assert.deepEqual(isolationConfig([], [], skills.slice(0, 1))['skills.config'], [{ path: '/home/u/.codex/skills/mine/SKILL.md', enabled: false }]);
  assert.equal(isolationConfig([])['skills.config'], undefined);
  assert.deepEqual(await hiddenSkills({ request: async () => Promise.reject(new Error('unknown method')) }, '/repo'), []);

  const global = mkdtempSync(join(tmpdir(), 'mh-agy-skills-'));
  mkdirSync(join(global, 'release-notes'));
  writeFileSync(join(global, 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Writes release notes.\n---\nSteps.\n');
  mkdirSync(join(global, 'not-a-skill'));
  assert.deepEqual(agyPersonalSkills(global), ['release-notes']);
  const agentDir = mkdtempSync(join(tmpdir(), 'mh-agy-agent-'));
  const spec = { agentDir, mcpUrl: 'http://x/mcp', systemPrompt: 'Hi', mcpServers: [] } as unknown as SessionSpec;
  writeAgentConfig(spec, '/hook.ts', agyPersonalSkills(global));
  const stub = readFileSync(join(agentDir, '.agents', 'skills', 'release-notes', 'SKILL.md'), 'utf8');
  assert.match(stub, /^---\nname: release-notes\ndescription: Turned off for this team by MetaHarness/);
});

test('rules from the app: switch one off, customize a built-in, delete the copy', async () => {
  const { d } = shop({ lead: async () => {} });
  const rule = (v: any, name: string) => v.config.rules.find((r: { name: string }) => r.name === name);
  let v = (await d.command({ cmd: 'settings.save', scope: 'repo', patch: { rules: { map: false } } })) as any;
  assert.equal(rule(v, 'map').on, false);
  assert.equal(rule(v, 'map').switchedBy, 'repo');
  assert.equal(d.project().config.rules.get('map')!.off, true, 'applies to agents started from now on');
  v = (await d.command({ cmd: 'settings.save', scope: 'repo', patch: { rules: { map: null } } })) as any;
  assert.equal(rule(v, 'map').on, true, 'null goes back to the default');

  const builtIn = rule(v, 'no-duplicates');
  v = (await d.command({ cmd: 'rule.save', ...builtIn, scope: 'repo', body: 'Ask the architect first.' })) as any;
  const copy = rule(v, 'no-duplicates');
  assert.equal(copy.scope, 'repo');
  assert.equal(copy.overrides, 'built-in');
  assert.match(readFileSync(copy.file, 'utf8'), /^---\nwhen: new-file\ndescription: before building[\s\S]*roles: team\npaths: \*\*, !\*\*\/\*test\*\/\*\*[\s\S]*---\nAsk the architect first\.\n$/);
  assert.equal(d.project().config.rules.get('no-duplicates')!.body, 'Ask the architect first.');
  v = (await d.command({ cmd: 'rule.delete', name: 'no-duplicates', scope: 'repo' })) as any;
  assert.equal(rule(v, 'no-duplicates').scope, 'built-in', 'the built-in one is back');
});
