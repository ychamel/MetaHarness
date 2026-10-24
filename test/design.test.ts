import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeAdapter, type FakeCtx, type FakeScript, type FakeTurnScript } from '../src/adapters/fake.ts';
import { Daemon, landedNote } from '../src/daemon.ts';
import { compareDesigns, cycles, DesignTracker, folderAreas, mapAreas, parseFlows, summarize } from '../src/design.ts';
import * as gitx from '../src/git.ts';
import { git } from '../src/git.ts';
import { readAuthors } from '../src/guard.ts';
import { loadLanguages, Outliner, resolveContext, resolveImport, scmPatterns } from '../src/languages.ts';
import { makeRepo, settle, withTimeout } from './helpers.ts';

/** Runs git as the agent does: with the environment its harness got (the guard and its name). */
function agentGit(ctx: FakeCtx, ...args: string[]): string {
  return execFileSync('git', args, { cwd: ctx.spec.cwd, env: { ...process.env, ...ctx.spec.env }, encoding: 'utf8', stdio: 'pipe' });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
}

function commitAll(dir: string, message: string, files: Record<string, string> = {}): string {
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const MAP = `# Shop

A small shop: requests come in through src/api and land in src/store.

## src/api/ — the HTTP side

The handlers, one file per resource.

## src/store/

Storage. Nothing here knows about HTTP.
`;

/** A repository with a map and two areas, the api using the store. */
function shopRepo(): string {
  const repo = makeRepo();
  commitAll(repo, 'Shop', {
    'ARCHITECTURE.md': MAP,
    'src/api/orders.ts': "import { db } from '../store/db.ts';\nexport class Orders {\n  list() {\n    return db.all();\n  }\n}\n",
    'src/store/db.ts': 'export const db = { all: () => [] };\n',
  });
  return repo;
}

/** A daemon with one fake role per script; `wake` lists roles that are woken by landed work. */
function team(scripts: Record<string, FakeScript>, o: { repo?: string; turns?: Record<string, FakeTurnScript>; wake?: string[]; settings?: Record<string, unknown> } = {}) {
  const personal = mkdtempSync(join(tmpdir(), 'mh-design-personal-'));
  const cfg = mkdtempSync(join(tmpdir(), 'mh-design-cfg-'));
  mkdirSync(join(cfg, 'roles'));
  for (const name of Object.keys(scripts)) {
    const wake = o.wake?.includes(name) ? 'wake: landed\n' : '';
    writeFileSync(join(cfg, 'roles', `${name}.md`), `---\nharness: fake\nmodel: m\ngood_at: ${name} things\n${wake}---\nYou do ${name} things.\n`);
  }
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify(o.settings ?? {}));
  const repo = o.repo ?? makeRepo();
  const fake = new FakeAdapter(scripts, {}, o.turns ?? {});
  const d = new Daemon({ home: mkdtempSync(join(tmpdir(), 'mh-home-')), repo, dbPath: ':memory:', configDirs: [personal, cfg], adapters: { fake }, pollMs: 0, settings: { approvals: 'ask' } });
  return { d, fake, repo, cfg };
}

test("the git hooks name the agent behind each commit; a commit's size comes with it", async () => {
  const repo = makeRepo();
  const { d } = team(
    {
      lead: async ctx => {
        writeFileSync(join(ctx.spec.cwd, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
        agentGit(ctx, 'add', 'a.ts');
        agentGit(ctx, 'commit', '-qm', 'Add a');
        await ctx.tool('done', { note: 'ok' });
      },
    },
    { repo },
  );
  const goal = d.startGoal({ request: 'r', lead: 'lead' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  // The human commits too, without the hooks' environment.
  commitAll(repo, 'Human edit', { 'b.md': 'hi\n' });
  d.refreshGit(goal);
  const commits = d.store.since(goal).filter(e => e.type === 'git.commit');
  assert.deepEqual(
    commits.map(c => [c.data.summary, c.agent ?? null, c.data.files, c.data.added, c.data.removed, c.data.paths]),
    [
      ['Add a', 'lead', 1, 2, 0, ['a.ts']],
      ['Human edit', null, 1, 1, 0, ['b.md']],
    ],
  );
  const gg = d.goals.get(goal)!.git!;
  assert.equal(readAuthors(gg.commonDir, goal).get(String(commits[0].data.sha)), 'lead');
  await d.close();
});

test('a merge and a rewrite are recorded by the hooks too', () => {
  const repo = makeRepo();
  const home = mkdtempSync(join(tmpdir(), 'mh-guard-'));
  const d = new Daemon({ home, repo, dbPath: ':memory:', configDirs: [mkdtempSync(join(tmpdir(), 'mh-cfg-'))], adapters: {}, pollMs: 0 });
  const env = { ...process.env, GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${d.guardDir}'`, MH_GOAL: 'g1', MH_AGENT: 'impl-1', MH_OWN_BRANCH: 'side' };
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' });
  git(repo, 'checkout', '-qb', 'side');
  writeFileSync(join(repo, 'x.txt'), 'x\n');
  run('add', 'x.txt');
  run('commit', '-qm', 'X');
  run('commit', '-q', '--amend', '-m', 'X, amended');
  const amended = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'trunk');
  commitAll(repo, 'Trunk moves', { 'y.txt': 'y\n' });
  run('merge', '-q', '--no-edit', 'side');
  const merge = git(repo, 'rev-parse', 'HEAD');
  const authors = readAuthors(join(repo, '.git'), 'g1');
  assert.equal(authors.get(amended), 'impl-1', 'the amended commit');
  assert.equal(authors.get(merge), 'impl-1', 'the merge commit');
  assert.equal(readAuthors(join(repo, '.git'), 'other').size, 0, 'per goal');
});

test('work landing on the goal branch is announced once it goes quiet, and wakes the roles that asked', async () => {
  const repo = shopRepo();
  const heard: string[] = [];
  const toLead: string[] = [];
  const { d } = team(
    {
      lead: async ctx => {
        await ctx.tool('spawn', { role: 'carto', name: 'carto', brief: 'Keep the map' });
        for (;;) {
          const m = await ctx.nextMessage(3000);
          if (m === null) break;
          toLead.push(m);
        }
        await ctx.tool('done', { note: 'ok' });
      },
      // The cartographer's first turn reads the map and ends without done: it rests until woken.
      carto: async () => {},
    },
    {
      repo,
      wake: ['carto'],
      turns: {
        carto: async (ctx, text) => {
          heard.push(text);
          const map = readFileSync(join(ctx.spec.cwd, 'ARCHITECTURE.md'), 'utf8') + '\n## src/util/\n\nSmall helpers.\n';
          writeFileSync(join(ctx.spec.cwd, 'ARCHITECTURE.md'), map);
          agentGit(ctx, 'add', 'ARCHITECTURE.md');
          agentGit(ctx, 'commit', '-qm', 'map: src/util/ for small helpers');
        },
      },
    },
  );
  const goal = d.startGoal({ request: 'r', lead: 'lead' });
  const g = d.goals.get(goal)!;
  while (g.agents.get('carto')?.state !== 'idle') await settle();
  commitAll(repo, 'Add util', { 'src/util/log.ts': 'export const log = () => {};\n' });
  commitAll(repo, 'Use util', { 'src/store/db.ts': "import { log } from '../util/log.ts';\nexport const db = { all: () => (log(), []) };\n" });
  d.refreshGit(goal);
  assert.ok(g.landing, 'gathered, not announced yet');
  d.landed(g);
  while (!heard.length) await settle();
  assert.match(heard[0], /Work landed on trunk: 2 commits, [0-9a-f]{7}\.\.[0-9a-f]{7}\.\n- [0-9a-f]{7} unnamed: Add util\n- [0-9a-f]{7} unnamed: Use util\nFiles: src\/util\/log.ts, src\/store\/db.ts\.\nThe changes: `git diff --stat/);
  // Its own map commit lands too, but doesn't wake it again.
  while (g.agents.get('carto')?.state !== 'idle') await settle();
  d.refreshGit(goal);
  d.landed(g);
  await settle();
  await settle();
  assert.equal(heard.length, 1);
  const landed = d.store.since(goal).filter(e => e.type === 'git.landed');
  assert.deepEqual(landed.map(e => [e.data.commits, e.data.by]), [[2, []], [1, ['carto']]]);
  await withTimeout(g.leadDone, 8000, 'lead done');
  assert.ok(!toLead.some(m => /carto/.test(m)), `the cartographer resting isn't news for the lead: ${toLead.join(' | ')}`);
  await d.designIdle();
  await d.close();
});

test('design: areas from the map, imports between them, and what changed as work landed', async () => {
  const repo = shopRepo();
  const { d } = team({ lead: async ctx => void (await ctx.nextMessage(4000), await ctx.tool('done', { note: 'ok' })) }, { repo });
  const goal = d.startGoal({ request: 'r', lead: 'lead' });
  const g = d.goals.get(goal)!;
  await d.designIdle();
  const start = await d.designView(goal);
  const snap = start.snapshot!;
  assert.deepEqual(
    snap.map.areas.map(a => [a.path, a.title, a.summary, a.unmapped ?? false]),
    [
      ['src/api', 'the HTTP side', 'The handlers, one file per resource.', false],
      ['src/store', 'store', 'Storage. Nothing here knows about HTTP.', false],
      ['', 'top level', '', true],
    ],
  );
  assert.match(snap.map.overview, /A small shop/);
  assert.deepEqual(snap.edges, [{ from: 'src/api', to: 'src/store', n: 1 }]);
  const orders = snap.files.find(f => f.path === 'src/api/orders.ts')!;
  assert.deepEqual(orders.symbols!.map(s => `${s.kind} ${s.parent ? s.parent + '.' : ''}${s.name}`), ['class Orders', 'method Orders.list']);
  assert.deepEqual(orders.imports, ['src/store/db.ts']);
  assert.deepEqual(start.list.map(i => i.kind), ['start']);

  commitAll(repo, 'Refunds, and a logger', {
    'src/api/refunds.ts': "import { db } from '../store/db.ts';\nexport class Refunds {}\n",
    'src/util/log.ts': 'export function log() {}\n',
    'src/store/db.ts': "import { log } from '../util/log.ts';\nexport const db = { all: () => (log(), []) };\n",
  });
  d.refreshGit(goal);
  d.landed(g);
  await d.designIdle();
  const changed = d.store.since(goal).find(e => e.type === 'design.changed')!;
  assert.ok(changed, 'design.changed is logged');
  assert.deepEqual(changed.data.highlights, ['new area src/util', 'src/store now uses src/util', 'added class Refunds (src/api/refunds.ts)', 'added function log (src/util/log.ts)']);
  const list = (await d.designView(goal)).list;
  assert.deepEqual(list.map(i => i.kind), ['start', 'landed']);
  const c = await d.designCompare(goal, list[0].sha, list[1].sha);
  assert.deepEqual(c.files, { added: ['src/api/refunds.ts', 'src/util/log.ts'], removed: [], changed: ['src/store/db.ts'] });
  assert.deepEqual(c.edges, { added: [{ from: 'src/store', to: 'src/util' }], removed: [] });
  // A branch or "now" is read on demand.
  assert.equal((await d.designView(goal, 'now')).snapshot!.sha, git(repo, 'rev-parse', 'HEAD'));
  await d.close();
});

test('design: without a map, folders are the areas; a folder holding most of the code is split', () => {
  assert.deepEqual(
    folderAreas(['README.md', 'src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts', 'src/main.ts', 'docs/d.md']).map(a => a.path),
    ['', 'docs', 'src', 'src/a', 'src/b'],
  );
  const m = mapAreas('# P\n\nIntro.\n\n## `ui/src/pages/`: the pages\n\nOne per route.\n\nMore.\n', '/nowhere');
  assert.deepEqual(m.areas, [{ path: 'ui/src/pages', title: 'the pages', summary: 'One per route.' }]);
  assert.equal(m.overview, 'Intro.');
});

test('languages: Python, GDScript and Godot scenes, with their imports resolved to files', async () => {
  const repo = makeRepo();
  commitAll(repo, 'Code', {
    'app/__init__.py': '',
    'app/models.py': 'class User:\n    def name(self):\n        return "x"\n',
    'app/views.py': 'from .models import User\nimport app.util\n\ndef index():\n    return User()\n',
    'app/util.py': 'def helper():\n    pass\n',
    'game/project.godot': '[application]\n',
    'game/player.gd': 'class_name Player\nextends CharacterBody2D\nconst Gun = preload("res://weapons/gun.gd")\nfunc _ready():\n\tpass\n',
    'game/weapons/gun.gd': 'extends Node\nfunc fire():\n\tpass\n',
    'game/enemy.gd': 'extends Node2D\nvar target: Player\n',
    'game/main.tscn': '[gd_scene format=3]\n[ext_resource type="Script" path="res://player.gd" id="1"]\n[node name="Main" type="Node2D"]\n[node name="Player" parent="."]\n',
  });
  const packs = loadLanguages([]);
  assert.deepEqual([...packs.keys()].sort(), ['gdscript', 'godot-scene', 'javascript', 'python', 'tsx', 'typescript']);
  const tracker = new DesignTracker(mkdtempSync(join(tmpdir(), 'mh-home-')), new Outliner(packs));
  const gg = gitx.setupGoal(repo, 'g') as gitx.GoalGit;
  const snap = await tracker.build(gg, repo, git(repo, 'rev-parse', 'HEAD'));
  const f = (p: string) => snap.files.find(x => x.path === p)!;
  assert.deepEqual(f('app/views.py').imports?.sort(), ['app/models.py', 'app/util.py']);
  assert.deepEqual(f('app/models.py').symbols!.map(s => `${s.kind} ${s.name}`), ['class User', 'method name']);
  assert.deepEqual(f('game/player.gd').imports, ['game/weapons/gun.gd']);
  assert.deepEqual(f('game/enemy.gd').imports, ['game/player.gd'], 'a class_name used as a type');
  assert.deepEqual(f('game/main.tscn').symbols!.map(s => s.name), ['Main', 'Player']);
  assert.deepEqual(f('game/main.tscn').imports, ['game/player.gd']);
  assert.deepEqual(snap.problems, []);
  // An import a pack can't place stays out.
  const ctx = resolveContext(['a/b.ts']);
  assert.equal(resolveImport(packs.get('typescript')!, 'a/c.ts', 'react', ctx), undefined);
  assert.equal(resolveImport(packs.get('typescript')!, 'a/c.ts', './b.js', ctx), 'a/b.ts', 'ESM writes .js for a .ts file');
});

test('a language pack in a config folder adds a language with patterns', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'mh-lang-'));
  write(cfg, {
    'languages/lua/language.md': '---\nextensions: .lua\nresolve: dotted\ntry: .lua\n---\nLua.\n',
    'languages/lua/patterns.txt': '# kind: regex\nfunction: ^\\s*function\\s+([\\w.:]+)\nimport: require\\s*\\(?\\s*["\']([^"\']+)["\']\n',
  });
  const packs = loadLanguages([cfg]);
  const lua = packs.get('lua')!;
  assert.equal(lua.builtIn, false);
  const o = await new Outliner(packs).outline(lua, 'local m = require("game.state")\nfunction M.start()\nend\n');
  assert.deepEqual(o, { symbols: [{ kind: 'function', name: 'M.start', line: 2, end: 2, hash: o!.symbols[0].hash }], imports: ['game.state'], references: [] });
  assert.equal(resolveImport(lua, 'main.lua', 'game.state', resolveContext(['game/state.lua'])), 'game/state.lua');
});

test('diffs: a commit, a range, the whole goal and uncommitted work, read when asked', async () => {
  const repo = shopRepo();
  const { d } = team(
    {
      lead: async ctx => {
        await ctx.tool('spawn', { role: 'impl', name: 'impl', brief: 'b', worktree: true });
        await ctx.nextMessage(4000);
        await ctx.tool('done', { note: 'ok' });
      },
      impl: async ctx => {
        write(ctx.spec.cwd, { 'src/api/refunds.ts': 'export class Refunds {}\n' });
        agentGit(ctx, 'add', '-A');
        agentGit(ctx, 'commit', '-qm', 'Refunds');
        write(ctx.spec.cwd, { 'src/api/orders.ts': 'export class Orders {}\n', 'notes.txt': 'todo\n' });
        await ctx.tool('done', { note: 'Refunds on my branch' });
      },
    },
    { repo },
  );
  const goal = d.startGoal({ request: 'r', lead: 'lead' });
  await withTimeout(d.goals.get(goal)!.leadDone, 6000, 'lead done');
  git(repo, 'mv', 'src/store/db.ts', 'src/store/sql.ts');
  git(repo, 'commit', '-qm', 'Rename the store');
  const v = d.gitView(goal);
  assert.equal(v.git!.commits, 1);
  assert.deepEqual(v.branches!.map(b => [b.agent, b.ahead, b.behind, b.uncommitted]), [['impl', 1, 1, 2]]);
  const sha = d.store.since(goal).length ? git(repo, 'rev-parse', `mh/${goal}/impl`) : '';
  const one = d.diffView(goal, { sha });
  assert.equal(one.title, `${sha.slice(0, 7)} Refunds`);
  assert.deepEqual(one.files.map(f => [f.path, f.status, f.added, f.removed]), [['src/api/refunds.ts', 'added', 1, 0]]);
  assert.match(one.files[0].patch, /^@@ -0,0 \+1 @@\n\+export class Refunds \{\}$/);
  const whole = d.diffView(goal, { whole: true });
  assert.deepEqual(whole.files.map(f => [f.path, f.status, f.from ?? null]), [['src/store/sql.ts', 'renamed', 'src/store/db.ts']]);
  const wt = d.diffView(goal, { agent: 'impl' });
  assert.equal(wt.shared, false);
  assert.deepEqual(wt.files.map(f => [f.path, f.status]).sort(), [['notes.txt', 'added'], ['src/api/orders.ts', 'modified']]);
  writeFileSync(join(repo, 'README.md'), '# Changed\n');
  const mine = d.diffView(goal, { agent: 'lead' });
  assert.equal(mine.shared, true, "the checkout's changes could be anyone's");
  assert.deepEqual(mine.files.map(f => f.path), ['README.md']);
  assert.throws(() => d.diffView(goal, { sha: '--output=/tmp/x' }), /no commit/);
  await d.close();
});

test('pinned notes reach each agent once, when it first works in the area; kept, they become a rule', async () => {
  const repo = shopRepo();
  // Without the map, the only notes are the human's.
  git(repo, 'rm', '-q', 'ARCHITECTURE.md');
  git(repo, 'commit', '-qm', 'No map');
  const seen: Record<string, (string | null)[]> = { lead: [], impl: [] };
  let goal = '';
  const { d, cfg } = team(
    {
      lead: async ctx => {
        while (!d.goals.get(goal)?.notes.size) await ctx.sleep(10);
        ctx.read('src/store/db.ts');
        seen.lead.push(await ctx.nextMessage(300));
        ctx.read('src/api/orders.ts');
        seen.lead.push(await ctx.nextMessage(2000));
        ctx.read('src/api/orders.ts');
        seen.lead.push(await ctx.nextMessage(300));
        await ctx.tool('spawn', { role: 'impl', name: 'impl', brief: 'b' });
        await ctx.nextMessage(4000);
        await ctx.tool('done', { note: 'ok' });
      },
      impl: async ctx => {
        ctx.writeFile('src/api/refunds.ts', 'export {};\n');
        seen.impl.push(await ctx.nextMessage(2000));
        await ctx.tool('done', { note: 'done' });
      },
    },
    { repo, settings: { rules: { 'no-duplicates': false } } },
  );
  goal = d.startGoal({ request: 'r', lead: 'lead' });
  const { id } = d.pinNote(goal, 'src/api/', "Handlers don't touch the database directly; go through src/store.");
  await withTimeout(d.goals.get(goal)!.leadDone, 8000, 'lead done');
  assert.equal(seen.lead[0], null, 'not for another area');
  assert.match(seen.lead[1]!, /\[MetaHarness · note from the human on src\/api\] Handlers don't touch the database directly; go through src\/store\. \(You're working on src\/api\/orders.ts\.\)/);
  assert.equal(seen.lead[2], null, 'once per agent');
  assert.match(seen.impl[0]!, /note from the human on src\/api\][\s\S]*You're working on src\/api\/refunds.ts/);
  const calls = d.store.since(goal).filter(e => e.type === 'agent.tool_call' && e.data.paths);
  assert.deepEqual(calls.map(e => [e.agent, e.data.paths, e.data.edit ?? false]).slice(0, 2), [['lead', ['src/store/db.ts'], false], ['lead', ['src/api/orders.ts'], false]]);
  assert.ok(calls.some(e => e.agent === 'impl' && e.data.edit === true), 'edits are marked');
  assert.deepEqual(d.store.since(goal).filter(e => e.type === 'note.delivered').map(e => e.agent), ['lead', 'impl']);

  const file = d.keepNote(goal, id);
  assert.equal(file, join(cfg, 'rules', 'note-src-api.md'));
  assert.match(readFileSync(file, 'utf8'), /^---\nwhen: path\ndescription: the human's note on src\/api\npaths: src\/api, src\/api\/\*\*\n---\nHandlers don't touch the database directly/);
  assert.ok(d.config.rules.has('note-src-api'), 'agents started from now on get it as a rule');
  d.unpinNote(goal, id);
  assert.equal(d.goals.get(goal)!.notes.size, 0);
  await d.close();
});

test('the landed note lists the commits and the files, and how to read the diff', () => {
  const text = landedNote('main', 'a'.repeat(40), 'b'.repeat(40), [{ sha: 'c'.repeat(40), summary: 'Add x', agent: 'impl-1', paths: ['x.ts'], merge: false }], ['x.ts']);
  assert.equal(text, 'Work landed on main: 1 commit, aaaaaaa..bbbbbbb.\n- ccccccc impl-1: Add x\nFiles: x.ts.\nThe changes: `git diff --stat aaaaaaaaaaaa bbbbbbbbbbbb`, then the diff of the files that matter.');
});

test('comparing designs names symbols added, changed and removed', () => {
  const base = { sha: 'a', at: '', map: { file: null, overview: '', areas: [{ path: 'src', title: 'src', summary: '' }] }, edges: [], skipped: 0, problems: [] };
  const a = { ...base, files: [{ path: 'src/x.ts', size: 1, blob: '1', area: 'src', symbols: [{ kind: 'class', name: 'X', line: 1, hash: 'h1' }, { kind: 'function', name: 'gone', line: 5, hash: 'h2' }] }] };
  const b = { ...base, sha: 'b', files: [{ path: 'src/x.ts', size: 2, blob: '2', area: 'src', symbols: [{ kind: 'class', name: 'X', line: 1, hash: 'h9' }, { kind: 'function', name: 'fresh', line: 5, hash: 'h3' }] }] };
  const c = compareDesigns(a, b);
  assert.deepEqual([c.symbols.added.map(s => s.name), c.symbols.changed.map(s => s.name), c.symbols.removed.map(s => s.name)], [['fresh'], ['X'], ['gone']]);
  assert.deepEqual(summarize(c).highlights, ['added function fresh (src/x.ts)', 'removed function gone (src/x.ts)']);
  assert.ok(existsSync(join(import.meta.dirname, '..', 'defaults', 'languages', 'gdscript', 'grammar.wasm')));
});

test('flows come from the map; steps name areas by path or title; cycles are found', () => {
  const areas = [
    { path: 'src/api', title: 'the HTTP side', summary: '' },
    { path: 'src/store', title: 'store', summary: '' },
    { path: 'src/orders', title: 'Orders', summary: '' },
  ];
  const map = [
    '# Shop', '', '## src/api/', 'x', '',
    '## Flows', '',
    '- **Checkout**: `src/api/` → orders → `src/store/db.ts` — a request becomes a saved order',
    '- src/api -> Mailer',
    '- not a flow',
    '', '## src/store/', '- a → b inside an area section is no flow',
  ].join('\n');
  assert.deepEqual(parseFlows(map, areas), [
    { name: 'Checkout', steps: [{ label: '`src/api/`', area: 'src/api' }, { label: 'orders', area: 'src/orders' }, { label: '`src/store/db.ts`', area: 'src/store' }], text: 'a request becomes a saved order' },
    { name: 'src/api → Mailer', steps: [{ label: 'src/api', area: 'src/api' }, { label: 'Mailer' }], text: '' },
  ]);
  assert.deepEqual(cycles([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'c', to: 'd' }, { from: 'd', to: 'd' }]), [['a', 'b', 'c']]);
});

test('design scopes: the whole goal (with unmerged branches as a picture), a commit, a branch; each with a report', async () => {
  const repo = shopRepo();
  commitAll(repo, 'Flows', { 'ARCHITECTURE.md': MAP + '\n## Flows\n\n- Listing: `src/api/` → `src/store/` — orders are read from the store\n' });
  const { d } = team(
    {
      lead: async ctx => {
        await ctx.tool('spawn', { role: 'impl', name: 'impl', brief: 'b', worktree: true });
        await ctx.nextMessage(4000);
        await ctx.tool('done', { note: 'ok' });
      },
      impl: async ctx => {
        write(ctx.spec.cwd, { 'src/store/db.ts': "import { Orders } from '../api/orders.ts';\nexport const db = { all: () => [] };\nexport function refund() {\n  return 1;\n}\n" });
        agentGit(ctx, 'commit', '-qam', 'Refunds in the store');
        await ctx.tool('done', { note: 'on my branch' });
      },
    },
    { repo },
  );
  const goal = d.startGoal({ request: 'r', lead: 'lead' });
  await withTimeout(d.goals.get(goal)!.leadDone, 6000, 'lead done');
  await d.designIdle();
  commitAll(repo, 'List orders by day', { 'src/api/orders.ts': "import { db } from '../store/db.ts';\nexport class Orders {\n  list() {\n    return db.all();\n  }\n  byDay() {}\n}\n" });
  d.refreshGit(goal);

  const whole = await d.designScope(goal, { kind: 'goal' });
  assert.equal(whole.report!.totals.commits, 1);
  assert.deepEqual(whole.report!.areas.map(a => [a.path, a.added, a.removed, a.symbols]), [['src/api', 1, 0, { added: 1, changed: 1, removed: 0 }]]);
  const byDay = whole.change!.symbols.added[0];
  assert.deepEqual([byDay.name, byDay.line, byDay.end], ['byDay', 6, 6]);
  assert.deepEqual(whole.snapshot!.map.flows!.map(f => [f.name, f.steps.map(s => s.area)]), [['Listing', ['src/api', 'src/store']]]);

  // With the unmerged branch: the store now imports the api back, a cycle.
  const all = await d.designScope(goal, { kind: 'goal', branches: true });
  assert.deepEqual(all.scope!.merged, ['impl']);
  assert.deepEqual(all.scope!.conflicts, []);
  assert.match(all.snapshot!.sha, /^[0-9a-f]{40}$/);
  assert.notEqual(all.snapshot!.sha, git(repo, 'rev-parse', 'HEAD'));
  assert.deepEqual(all.report!.cycles, [{ areas: ['src/api', 'src/store'], new: true }]);
  assert.deepEqual(all.change!.edges.added, [{ from: 'src/store', to: 'src/api' }]);
  assert.deepEqual(all.report!.commits.map(c => [c.summary, c.agent ?? null]).sort(), [['List orders by day', null], ['Refunds in the store', 'impl']]);
  assert.equal(git(repo, 'status', '--porcelain'), '', 'nothing in the checkout moved');
  // Diffs read against the picture, and narrowed to an area.
  const diff = d.diffView(goal, { from: all.scope!.from, to: all.scope!.to, paths: ['src/store'] });
  assert.deepEqual(diff.files.map(f => f.path), ['src/store/db.ts']);
  // Doc comments read from the picture too, for the hover.
  const docs = await d.designDocs(goal, all.scope!.to, 'src/api/orders.ts');
  assert.deepEqual(docs.symbols.map(x => [x.name, x.line]), [['Orders', 2], ['list', 3], ['byDay', 6]]);
  await assert.rejects(d.designDocs(goal, all.scope!.to, '../x.ts'), /isn't a path in the repository/);

  const branch = await d.designScope(goal, { kind: 'branch', agent: 'impl' });
  assert.equal(branch.scope!.title, "impl's branch");
  assert.deepEqual(branch.report!.commits.map(c => c.agent), ['impl']);
  const file = branch.report!.files.find(f => f.path === 'src/store/db.ts')!;
  assert.deepEqual([file.added, file.removed, file.commits, file.agents], [4, 0, 1, ['impl']]);
  assert.deepEqual(branch.report!.hotspots, ['src/store/db.ts']);

  const sha = git(repo, 'rev-parse', 'HEAD');
  const one = await d.designScope(goal, { kind: 'commit', sha });
  assert.equal(one.scope!.title, `${sha.slice(0, 7)} List orders by day`);
  assert.equal(one.scope!.from, git(repo, 'rev-parse', 'HEAD^'));
  assert.ok(existsSync(join(d.home, 'goals', goal, 'design', 'reports', `${one.scope!.from}..${sha}.json`)), 'the report is kept');

  // Each landing keeps a report of its own and one for the goal so far.
  d.landed(d.goals.get(goal)!);
  await d.designIdle();
  const reports = readdirSync(join(d.home, 'goals', goal, 'design', 'reports'));
  const list = d.design.list(goal);
  assert.ok(reports.includes(`${list[0].sha}..${list[1].sha}.json`));
  // Commits name the areas they touched, for the Git tab.
  assert.deepEqual(d.gitView(goal).areas!.map(a => a.path), ['src/api', 'src/store', '']);
  await d.close();
});

test('code coloured by the language packs: GDScript, the patterns split apart, and ones the grammar lacks dropped', async () => {
  const packs = loadLanguages([]);
  const o = new Outliner(packs);
  const text = 'const MAX := 4\nfunc go(n: int) -> void:\n\tprint("hi", self.n) # say\n';
  const h = (await o.highlight(packs.get('gdscript')!, text))!;
  const lines = text.split('\n');
  const spans = (i: number) => {
    const out: string[] = [];
    for (let j = 0; j < h.lines[i].length; j += 3) out.push(`${lines[i].slice(h.lines[i][j], h.lines[i][j + 1])}:${h.kinds[h.lines[i][j + 2]]}`);
    return out;
  };
  assert.deepEqual(spans(0), ['const:keyword', 'MAX:constant', ':=:operator', '4:number']);
  assert.deepEqual(spans(1), ['func:keyword', 'go:function', 'n:parameter', 'int:type', '->:operator', 'void:type']);
  assert.deepEqual(spans(2), ['print:function', '"hi":string', 'self:builtin', 'n:property', '# say:comment']);
  for (const name of ['python', 'typescript', 'tsx', 'javascript']) assert.ok(await o.highlight(packs.get(name)!, 'x = 1\n'), `${name} colours`);

  assert.deepEqual(scmPatterns('; c\n(a) @x\n[(b) "c"] @y\n((d) @z (#match? @z "^[A-Z(]"))\n"if" @k'), ['(a) @x', '[(b) "c"] @y', '((d) @z (#match? @z "^[A-Z(]"))', '"if" @k']);
  const lenient = new Outliner(new Map([['gd', { ...packs.get('gdscript')!, name: 'gd', highlights: '(no_such_node) @keyword\n(comment) @comment' }]]));
  const c = (await lenient.highlight(lenient.packs.get('gd')!, '# hi\n'))!;
  assert.deepEqual(c.lines[0], [0, 4, c.kinds.indexOf('comment')], 'the pattern it knows still colours');
});

test('doc comments: above a definition or its docstring, a file header, and GDScript only with ##', async () => {
  const packs = loadLanguages([]);
  const o = new Outliner(packs);
  const ts = (await o.docs(packs.get('typescript')!, [
    "import x from './x';", '', '/**', ' * Rules: short notes.', ' *', ' * More detail.', ' */', '',
    'export type A = 1;', '', '/** Reads a rule. */', 'export function parse(a: string) {}', '',
    '// Small one.', '// Two lines.', 'export const go = () => 1;', '', 'class K {', '  m() {}', '}', '',
  ].join('\n')))!;
  assert.equal(ts.doc, 'Rules: short notes.\n\nMore detail.', 'the header, not the comment above a definition');
  const doc = (d: typeof ts, name: string) => d.symbols.find(s => s.name === name)?.doc;
  assert.equal(doc(ts, 'A'), undefined, 'a blank line parts a comment from what follows');
  assert.equal(doc(ts, 'parse'), 'Reads a rule.');
  assert.equal(doc(ts, 'go'), 'Small one.\nTwo lines.');
  assert.equal(doc(ts, 'K'), undefined, "a file with more in it than its class keeps its doc to itself");

  const py = (await o.docs(packs.get('python')!, [
    '"""Module doc."""', 'class Herd:', '    """A herd.', '', '    More.', '    """', '', '    # Moves it.', '    @staticmethod', '    def move():', '        pass', '',
  ].join('\n')))!;
  assert.equal(py.doc, 'Module doc.');
  assert.equal(doc(py, 'Herd'), 'A herd.\n\nMore.', 'a docstring, dedented');
  assert.equal(doc(py, 'move'), 'Moves it.', 'decorators between are skipped');

  const gd = (await o.docs(packs.get('gdscript')!, ['class_name Herd', 'extends Node', '## A herd.', '', '## Moves it.', 'func move():', '\tpass', '', '# plain', 'func stop():', '\tpass', ''].join('\n')))!;
  assert.equal(gd.doc, 'A herd.');
  assert.equal(doc(gd, 'Herd'), 'A herd.', 'a class_name file shares its doc with the class');
  assert.equal(doc(gd, 'move'), 'Moves it.');
  assert.equal(doc(gd, 'stop'), undefined, 'a plain # comment is no doc in GDScript');
});
