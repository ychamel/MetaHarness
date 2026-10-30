import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from '../src/adapters/fake.ts';
import { sandboxFilesystem } from '../src/adapters/codex.ts';
import { Daemon } from '../src/daemon.ts';
import { pathsOutside } from '../src/readonly.ts';
import { loadRegistry, nesting } from '../src/projects.ts';
import { makeRepo, withTimeout } from './helpers.ts';

const role = (extra = '') => `---\nharness: fake\nmodel: m\n${extra}good_at: x\n---\nx\n`;

/** A daemon started with no folder, the way `mh daemon` is: a personal config with one role, and a lead that waits. */
function bareDaemon(home = mkdtempSync(join(tmpdir(), 'mh-home-'))) {
  mkdirSync(join(home, 'roles'), { recursive: true });
  writeFileSync(join(home, 'roles', 'architect.md'), role());
  const fake = new FakeAdapter({ '*': async ctx => void (await ctx.tool('wait', { timeout: 600 })) });
  const d = new Daemon({ home, dbPath: ':memory:', adapters: { fake }, pollMs: 0, settings: { approvals: 'ask' } });
  return { d, home };
}

/** A repository with a role of its own in .metaharness. */
function repoWithRole(name: string): string {
  const dir = makeRepo();
  mkdirSync(join(dir, '.metaharness', 'roles'), { recursive: true });
  writeFileSync(join(dir, '.metaharness', 'roles', `${name}.md`), role());
  return realpathSync(dir);
}

test('one daemon holds several projects: each goal works in its own folder with its own setup, and nothing falls back to where the daemon started', async () => {
  const { d, home } = bareDaemon();
  assert.throws(() => d.startGoal({ request: 'r' }), /Open a project first/);

  const a = realpathSync(makeRepo());
  const b = repoWithRole('designer');
  assert.ok(d.openProject(a).project, 'a folder without its own setup opens at once');
  const asked = d.openProject(b);
  assert.equal(asked.needsTrust, true, 'a folder with its own setup asks first');
  assert.deepEqual(asked.setup?.roles, ['designer']);
  assert.throws(() => d.startGoal({ request: 'r', project: b }), /trust it first/);
  const opened = d.openProject(b, { trust: true });
  assert.ok(opened.project?.trusted);

  const ga = d.startGoal({ request: 'in a', project: a });
  const gb = d.startGoal({ request: 'in b', project: opened.project!.id });
  assert.equal(d.goals.get(ga)!.dir, a);
  assert.equal(d.goals.get(gb)!.dir, b);
  assert.equal(d.agent(ga, 'architect')!.cwd, a);
  assert.equal(d.agent(gb, 'architect')!.cwd, b);
  // b's own role is b's alone.
  assert.ok(d.project(b).config.roles.has('designer'));
  assert.ok(!d.project(a).config.roles.has('designer'));
  assert.ok(!d.config.roles.has('designer'), 'the personal config has no project in it');
  assert.equal(d.spawnAgent(ga, { role: 'designer', brief: 'x', parent: 'architect' }).ok, false);
  assert.equal(d.spawnAgent(gb, { role: 'designer', brief: 'x', parent: 'architect' }).ok, true);

  const list = d.listProjects();
  assert.deepEqual(list.map(p => p.dir), [b, a], 'most recently opened first');
  assert.equal(list.find(p => p.dir === a)!.running, 1);
  assert.deepEqual(loadRegistry(home).map(p => [p.dir, p.trusted]), [[b, true], [a, true]], 'remembered across restarts');
  assert.ok(d.listGoals().every(g => g.project === d.project(g.dir).id));

  // Setup is read and saved per project; naming none, the personal folder alone.
  assert.ok(d.configView({ project: b }).roles.some(r => r.name === 'designer' && r.scope === 'repo'));
  assert.deepEqual(d.configView().scopes.map(s => s.scope), ['personal']);
  assert.throws(() => d.forgetProject(a), /still running/);
  await d.close();
});

test('restarted, the daemon picks up goals in every project, each in its own', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-home-'));
  const dbPath = join(home, 'mh.db');
  const a = realpathSync(makeRepo());
  const b = realpathSync(makeRepo());
  const make = () => {
    mkdirSync(join(home, 'roles'), { recursive: true });
    writeFileSync(join(home, 'roles', 'architect.md'), role());
    return new Daemon({ home, dbPath, adapters: { fake: new FakeAdapter({ '*': async ctx => void (await ctx.tool('wait', { timeout: 600 })) }) }, pollMs: 0, settings: { approvals: 'ask' } });
  };
  const d1 = make();
  d1.openProject(a);
  d1.openProject(b);
  const ga = d1.startGoal({ request: 'a', project: a });
  const gb = d1.startGoal({ request: 'b', project: b });
  await d1.close();
  const d2 = make();
  const back = d2.recover();
  assert.deepEqual(back.map(r => r.goal).sort(), [ga, gb].sort());
  assert.equal(d2.goals.get(ga)!.project.dir, a);
  assert.equal(d2.goals.get(gb)!.project.dir, b);
  await d2.close();
});

test("an agent reads its project, its goal's folder and the temporary folder without asking; anywhere else, it asks", async () => {
  const { d } = bareDaemon();
  const a = realpathSync(makeRepo());
  const b = realpathSync(makeRepo());
  writeFileSync(join(b, 'secret.txt'), 'b only\n');
  symlinkSync(join(b, 'secret.txt'), join(a, 'link.txt'));
  d.openProject(a);
  d.openProject(b);
  const goal = d.startGoal({ request: 'r', project: a });
  const lead = d.agent(goal, 'architect')!;
  const read = (path: string) => d.toolPolicy(lead, { kind: 'read', tool: 'Read', detail: path, path });
  assert.deepEqual(read(join(a, 'README.md')), { allow: true });
  assert.deepEqual(read('README.md'), { allow: true }, 'relative to its folder');
  assert.deepEqual(read(join(d.goals.get(goal)!.sharedDir, 'notes.md')), { allow: true });
  assert.deepEqual(read(join(tmpdir(), 'x.log')), { allow: true });
  assert.equal(read(join(b, 'secret.txt')), 'ask', 'another project');
  assert.equal(read('/etc/hostname'), 'ask');
  assert.equal(read('../../../etc/hostname'), 'ask', 'out of its folder by ..');
  assert.equal(read(join(a, 'link.txt')), 'ask', 'a link counts where it leads');
  assert.equal(read(join(homedir(), '.ssh', 'id_ed25519')), 'ask');

  // Read-only commands are approved by themselves only when what they read is in the project.
  assert.deepEqual(await d.requestApproval(lead, 'Bash', 'cat README.md && git log --oneline'), { allow: true });
  void d.requestApproval(lead, 'Bash', `cat ${join(b, 'secret.txt')}`);
  const item = await withTimeout(
    new Promise<(typeof d.humanInbox)[number]>(res => {
      const t = setInterval(() => {
        const i = d.humanInbox.find(x => x.kind === 'approval');
        if (i) (clearInterval(t), res(i));
      }, 10);
    }),
    2000,
    'the read outside comes to the human',
  );
  assert.match(item.note ?? '', /outside the project/);
  await d.close();
});

test('pathsOutside finds what a command reads outside, following cd, and leaves patterns alone', () => {
  const root = '/work/app';
  const inside = (p: string) => p === root || p.startsWith(root + '/') || p.startsWith('/tmp/');
  const out = (cmd: string) => pathsOutside(cmd, root, inside, '/home/me');
  assert.deepEqual(out('cat src/a.ts README.md'), []);
  assert.deepEqual(out("grep -rn '/api/v1' src"), [], "grep's pattern isn't a path");
  assert.deepEqual(out("sed -n '/start/,/end/p' notes/x.md"), []);
  assert.deepEqual(out("jq '.a/.b' data.json"), []);
  assert.deepEqual(out("find . -name '*.ts' -path '*/src/*'"), []);
  assert.deepEqual(out('cat /tmp/build.log'), []);
  assert.deepEqual(out('cat ../other/secret.txt'), ['../other/secret.txt']);
  assert.deepEqual(out('cat ~/.ssh/id_rsa'), ['~/.ssh/id_rsa']);
  assert.deepEqual(out('ls $HOME/projects'), ['$HOME/projects']);
  assert.deepEqual(out('cat $SECRET_FILE'), ['$SECRET_FILE'], "a path it can't resolve counts");
  assert.deepEqual(out('cd .. && ls'), ['..', '/work'], 'and what runs there');
  assert.deepEqual(out('cd src && cat ../../x'), ['../../x']);
  assert.deepEqual(out('git -C /work/lib log'), ['/work/lib']);
  assert.deepEqual(out('rg --file=/etc/patterns x'), ['--file=/etc/patterns']);
  assert.deepEqual(out("bash -lc 'cat /etc/hosts'"), ['/etc/hosts'], 'inside a shell -c too');
  assert.deepEqual(out('find / -name passwd'), ['/']);
});

test("Codex's permission profile: the machine readable, other projects and MetaHarness's home not, the agent's places writable", () => {
  const fs = sandboxFilesystem({ cwd: '/mh/goals/g/worktrees/impl-1', sharedDir: '/mh/goals/g/shared', gitDirs: ['/work/app/.git'], readRoots: ['/work/app', '/mh/goals/g', '/mh/git-guard'], denyRead: ['/work/lib', '/mh'] });
  assert.equal(fs[':root'], 'read');
  assert.equal(fs['/work/lib'], 'deny');
  assert.equal(fs['/mh'], 'deny');
  assert.equal(fs['/mh/goals/g'], 'read', 'its goal folder, inside the denied home');
  assert.equal(fs['/mh/git-guard'], 'read', 'the git hooks run from there');
  assert.equal(fs['/work/app'], 'read');
  for (const w of ['/mh/goals/g/worktrees/impl-1', '/mh/goals/g/shared', '/work/app/.git', ':slash_tmp', ':tmpdir']) assert.equal(fs[w], 'write', w);
});

test('nesting: a folder inside another project, or holding some', () => {
  assert.deepEqual(nesting('/w/app', ['/w', '/x']), { inside: '/w', contains: [] });
  assert.deepEqual(nesting('/w', ['/w/app', '/w/lib', '/wx']), { inside: undefined, contains: ['/w/app', '/w/lib'] });
});

test("the folder browser lists the daemon's folders, marking repositories, setups and projects", async () => {
  const { d } = bareDaemon();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'mh-browse-')));
  mkdirSync(join(parent, 'plain'));
  mkdirSync(join(parent, 'repo', '.git'), { recursive: true });
  mkdirSync(join(parent, '.hidden'));
  mkdirSync(join(parent, 'set', '.metaharness'), { recursive: true });
  writeFileSync(join(parent, 'file.txt'), 'x');
  d.openProject(join(parent, 'plain'));
  const v = d.browseFolders(parent);
  assert.deepEqual(v.dirs.map(x => x.name), ['plain', 'repo', 'set']);
  assert.deepEqual(v.dirs.map(x => [x.git, x.setup, x.project]), [[false, false, true], [true, false, false], [false, true, false]]);
  assert.equal(v.parent, join(parent, '..').replace(/\/$/, '') === parent ? null : realpathSync(join(parent, '..')));
  assert.ok(d.browseFolders(parent, true).dirs.some(x => x.name === '.hidden'));

  // A new project: the folder, a git repository in it, opened.
  const made = d.createProject(join(parent, 'fresh'));
  assert.equal(made.project?.git, true);
  assert.throws(() => d.createProject('relative/path'), /full path/);
  assert.ok(readFileSync(join(parent, 'fresh', '.git', 'HEAD'), 'utf8'));
  // Cloning: into a new folder, then opened like any folder.
  const cloned = await d.cloneProject(makeRepo(), join(parent, 'cloned'));
  assert.equal(cloned.project?.dir, join(parent, 'cloned'));
  assert.ok(readFileSync(join(parent, 'cloned', 'README.md'), 'utf8'));
  await assert.rejects(d.cloneProject(join(parent, 'nope'), join(parent, 'c2')), /git clone failed/);
  await d.close();
});
