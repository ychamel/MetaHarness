import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import { SharedFolder } from '../src/shared.ts';
import { replayGoal } from '../src/recover.ts';
import { guardEnv, refusedGitCommand } from '../src/guard.ts';
import { FakeAdapter } from '../src/adapters/fake.ts';
import { execFileSync } from 'node:child_process';
import type { Daemon } from '../src/daemon.ts';
import type { FakeCtx } from '../src/adapters/fake.ts';
import { makeDaemon, makeRepo, settle, withTimeout } from './helpers.ts';

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-qm', message);
}

/** A repository with an ignored node_modules, as after npm install. */
function repoWithDependencies(): string {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', 'node_modules/\n', 'Ignore dependencies');
  mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'export default s => s;\n');
  return repo;
}

test('worktrees get copies of the dependencies; when the lead finishes, MetaHarness removes merged work and keeps the rest', async () => {
  const repo = repoWithDependencies();
  const seen: Record<string, string> = {};
  const d = makeDaemon(
    {
      architect: async ctx => {
        for (const name of ['merged', 'unmerged', 'dirty']) await ctx.tool('spawn', { role: 'implementer', name, brief: name, worktree: true });
        for (let finished = 0; finished < 3; ) finished += ((await ctx.tool('wait', { timeout: 5 })).match(/^- \w+:/gm) ?? []).length;
        git(ctx.spec.cwd, 'merge', '-q', '--no-edit', `mh/${ctx.spec.goal}/merged`);
        await ctx.tool('done', { note: 'Merged one.' });
      },
      implementer: async ctx => {
        const cwd = ctx.spec.cwd;
        seen[`${ctx.spec.agent}.dep`] = String(existsSync(join(cwd, 'node_modules', 'left-pad', 'index.js')));
        seen[`${ctx.spec.agent}.status`] = git(cwd, 'status', '--porcelain');
        seen[`${ctx.spec.agent}.prompt`] = ctx.spec.systemPrompt;
        if (ctx.spec.agent !== 'dirty') commitFile(cwd, `${ctx.spec.agent}.txt`, 'x\n', `Add ${ctx.spec.agent}`);
        else writeFileSync(join(cwd, 'wip.txt'), 'not committed\n');
        // What npm ci does first. The human's node_modules must survive it.
        if (ctx.spec.agent === 'merged') rmSync(join(cwd, 'node_modules') + '/', { recursive: true, force: true });
        await ctx.tool('done', { note: 'ok' });
      },
    },
    { repo },
  );
  const goal = d.startGoal({ request: 'Three pieces' });
  const note = await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  const wt = (n: string) => join(d.home, 'goals', goal, 'worktrees', n);

  assert.equal(seen['merged.dep'], 'true', 'node_modules is copied into the worktree');
  assert.equal(seen['merged.status'], '', 'and git ignores the copy');
  assert.match(seen['merged.prompt'], /node_modules is a copy of the checkout's, made with hard links/);
  assert.ok(existsSync(join(repo, 'node_modules', 'left-pad', 'index.js')), "deleting the copy leaves the checkout's alone");

  // Done right away, as the lead finishes: no command from anyone.
  assert.match(note, /MetaHarness removed 2 worktrees and deleted 1 merged branch\. Kept: /);
  assert.match(note, /dirty: 1 uncommitted change/);
  assert.match(note, new RegExp(`mh/${goal}/unmerged: 1 commit not merged into trunk`));
  assert.match(note, new RegExp(`mh clean ${goal} --force removes them`));
  assert.ok(!existsSync(wt('merged')) && !existsSync(wt('unmerged')) && existsSync(wt('dirty')));
  assert.equal(git(repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/mh/${goal}/`), `mh/${goal}/dirty\nmh/${goal}/unmerged`);
  assert.ok(existsSync(join(repo, 'node_modules', 'left-pad', 'index.js')));
  assert.equal(d.agent(goal, 'merged')!.state, 'ended', 'an agent whose worktree is gone ends');

  assert.throws(() => d.cleanGoals(undefined, true), /needs a goal/);
  assert.deepEqual(d.cleanGoals(goal).results[0].removed, [], 'without --force, what was kept stays');
  const forced = d.cleanGoals(goal.slice(0, 4), true).results[0];
  assert.deepEqual(forced.removed, [wt('dirty')]);
  assert.deepEqual(forced.deleted.sort(), [`mh/${goal}/dirty`, `mh/${goal}/unmerged`]);
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1, 'git forgets the worktrees too');
  assert.ok(!existsSync(join(d.home, 'goals', goal, 'worktrees')));
  assert.deepEqual(d.cleanGoals(goal).results, [], 'a second clean has nothing to do');
  await d.close();
});

test('cleanup waits for teammates still working, and mh clean refuses a goal in progress', async () => {
  let release!: () => void;
  const hold = new Promise<void>(r => (release = r));
  // A role woken by events never finishes, so the lead can be done while it works.
  const d = makeDaemon({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'cartographer', name: 'implementer-1', brief: 'b', worktree: true });
      await ctx.tool('done', { note: 'Handed off.' });
    },
    cartographer: async ctx => {
      await hold;
      await ctx.tool('done', { note: 'ok' });
    },
  });
  const goal = d.startGoal({ request: 'Busy' });
  const note = await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  assert.match(note, /MetaHarness removes the worktrees and merged branches once implementer-1 finishes/);
  const r = d.cleanGoals(goal, true);
  assert.deepEqual(r.results, []);
  assert.match(r.refused[0], /still running \(implementer-1 is working\)/);
  assert.ok(existsSync(join(d.home, 'goals', goal, 'worktrees', 'implementer-1')));

  release();
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!existsSync(join(d.home, 'goals', goal, 'worktrees', 'implementer-1')), 'cleaned once it finished');
  assert.equal(d.store.ofType('goal.cleaned').length, 1);
  await d.close();
});

test('the git guard: agents only add history, never push, and the repository\'s own hooks still run', async () => {
  const repo = makeRepo();
  const remote = makeRepo();
  git(remote, 'checkout', '-q', '--detach');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'branch', 'other');
  git(repo, 'branch', 'mine');
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho ran >> "$(git rev-parse --git-common-dir)/pre-commit-ran"\n', { mode: 0o755 });
  const d = makeDaemon({ '*': async () => {} }, { repo });
  const env = { ...process.env, ...guardEnv(d.guardDir, 'mine', repo) };
  const agent = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe', encoding: 'utf8' });
  const refused = (what: string, ...args: string[]) => assert.throws(() => agent(...args), /MetaHarness/, what);

  refused('delete a branch', 'branch', '-D', 'other');
  refused('delete its own branch', 'branch', '-D', 'mine');
  agent('commit', '-q', '--allow-empty', '-m', 'Agent commit');
  refused('rewind the shared branch', 'reset', '-q', '--hard', 'HEAD~1');
  refused('amend a shared commit', 'commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten');
  git(repo, 'branch', 'ahead');
  refused('move another branch back', 'branch', '-f', 'ahead', 'HEAD~1');
  refused('push', 'push', '-q', 'origin', 'trunk');
  agent('update-ref', 'refs/heads/mine', 'HEAD~1');
  agent('branch', 'scratch');
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'Agent commit');
  assert.match(readFileSync(join(repo, '.git', 'pre-commit-ran'), 'utf8'), /ran/, "the repository's pre-commit hook ran for the agent");
  git(repo, 'branch', '-D', 'other');
  assert.doesNotMatch(git(repo, 'branch'), /other/, 'the human is unaffected');

  // Every session gets the guard.
  const goal = d.startGoal({ request: 'r' });
  await new Promise(r => setTimeout(r, 50));
  const spec = (d as unknown as { adapters: Record<string, FakeAdapter> }).adapters.fake.started.find(s => s.spec.goal === goal)!.spec;
  assert.match(spec.env!.GIT_CONFIG_PARAMETERS, /core\.hooksPath/);
  await d.close();
});

test('commands that would push or delete branches and worktrees are refused before they run', () => {
  for (const c of ['git push', 'npm test && git push origin main', 'git -C /x push --force', 'git branch -D old', 'git branch --delete x', 'git branch -vd x', 'git worktree remove ../wt', 'git tag -d v1', 'git update-ref -d refs/heads/x']) {
    assert.ok(refusedGitCommand(c), c);
  }
  for (const c of ['git status', 'git branch', 'git branch -v', 'git branch new-thing', 'git commit -m "push the button"', 'git log --oneline', 'git worktree list', 'echo git push']) {
    assert.equal(refusedGitCommand(c), undefined, c);
  }
  // In the human's checkout, which teammates share, discarding uncommitted changes is refused too;
  // in an agent's own worktree it's its own business.
  const discards = ['git reset --hard', 'git reset --hard HEAD~1', 'git checkout -- src/a.ts', 'git checkout .', 'git checkout -f main', 'git restore src/a.ts', 'git restore --staged --worktree a', 'git clean -fd', 'git switch --discard-changes main'];
  for (const c of discards) {
    assert.match(refusedGitCommand(c, { sharedCheckout: true }) ?? '', /uncommitted changes in the human's checkout/, c);
    assert.equal(refusedGitCommand(c, { sharedCheckout: false }), undefined, c);
  }
  for (const c of ['git reset', 'git reset HEAD a.ts', 'git restore --staged a.ts', 'git clean -n', 'git checkout -b feature', 'git switch main', 'git stash', 'git stash pop']) {
    assert.equal(refusedGitCommand(c, { sharedCheckout: true }), undefined, c);
  }
  assert.ok(refusedGitCommand('git stash drop'), 'every worktree shares the stash');
  // Codex sends commands wrapped in a shell.
  assert.ok(refusedGitCommand(`/bin/bash -lc 'git reset --hard HEAD~1'`, { sharedCheckout: true }));
  assert.ok(refusedGitCommand(`/bin/bash -lc 'npm test && git push origin main'`));
  assert.ok(refusedGitCommand(`sh -c "git branch -D old"`));
  assert.equal(refusedGitCommand(`/bin/bash -lc 'git add c.txt && git commit -m "Add c"'`, { sharedCheckout: true }), undefined);
});

test('merge conflicts become events, and an agent that calls done mid-conflict is told', async () => {
  const repo = makeRepo();
  const seen: Record<string, string> = {};
  const d = makeDaemon(
    {
      architect: async ctx => {
        await ctx.tool('spawn', { role: 'implementer', name: 'impl', brief: 'Change the README', worktree: true });
        await ctx.tool('wait', { timeout: 5 });
        commitFile(ctx.spec.cwd, 'README.md', '# Lead version\n', 'Lead edits README');
        const branch = `mh/${ctx.spec.goal}/impl`;
        // Logged as a shell command, as a harness would, so the merge is put down to the lead.
        await ctx.run(`git merge ${branch}`, 1);
        assert.throws(() => git(ctx.spec.cwd, 'merge', '--no-edit', branch));
        seen.done = await ctx.tool('done', { note: 'Merged.' });
      },
      implementer: async ctx => {
        commitFile(ctx.spec.cwd, 'README.md', '# Implementer version\n', 'Implementer edits README');
        await ctx.tool('done', { note: 'ok' });
      },
    },
    { repo },
  );
  const goal = d.startGoal({ request: 'Conflict' });
  const note = await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  await settle();
  assert.match(seen.done, /a merge is still in progress in .* with conflicts in README\.md\. Finish it/);
  assert.match(note, /\(MetaHarness: when architect called done, a merge is still in progress/);
  assert.match(note, /A merge is still in progress in .*, with conflicts in README\.md\./);

  d.refreshGit(goal);
  const conflict = d.store.ofType('git.conflict').at(-1)!;
  assert.equal(conflict.agent, 'architect');
  assert.deepEqual(
    { op: conflict.data.op, branch: conflict.data.branch, from: conflict.data.from, files: conflict.data.files },
    { op: 'merge', branch: 'trunk', from: `mh/${goal}/impl`, files: ['README.md'] },
  );
  d.refreshGit(goal);
  assert.equal(d.store.ofType('git.conflict').length, 1, 'reported once');

  git(repo, 'merge', '--abort');
  d.refreshGit(goal);
  assert.equal(d.store.ofType('git.conflict_resolved').at(-1)!.data.how, 'aborted');

  assert.throws(() => git(repo, 'merge', '--no-edit', `mh/${goal}/impl`));
  d.refreshGit(goal);
  writeFileSync(join(repo, 'README.md'), '# Both\n');
  git(repo, 'commit', '-qam', 'Merge impl');
  d.refreshGit(goal);
  assert.equal(d.store.ofType('git.conflict').length, 2);
  assert.equal(d.store.ofType('git.conflict_resolved').at(-1)!.data.how, 'committed');
  await d.close();
});

test('the shared folder keeps every version, tells teammates what changed, and flags clashes', async () => {
  const seen: Record<string, string> = {};
  let d!: Daemon;
  const refresh = (ctx: FakeCtx) => d.refreshShared(ctx.spec.goal);
  d = makeDaemon({
    architect: async ctx => {
      ctx.writeShared('design.md', 'v1\n');
      refresh(ctx);
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build it' });
      await ctx.nextMessage(3000);
      ctx.writeShared('design.md', 'v2\n');
      refresh(ctx);
      await ctx.tool('send', { to: 'implementer-1', text: 'Updated the design.' });
      // Notes ride along with the next message that reaches the agent.
      seen.architect = String(await ctx.nextMessage(3000));
      await ctx.tool('wait', { timeout: 5 });
      await ctx.tool('done', { note: 'ok' });
    },
    implementer: async ctx => {
      seen.first = await ctx.tool('status', { text: 'Starting' });
      await ctx.tool('send', { to: 'architect', text: 'Started' });
      seen.second = String(await ctx.nextMessage(3000));
      // Not its document: a clash.
      ctx.writeShared('design.md', 'v3 by the implementer\n');
      refresh(ctx);
      seen.clash = await ctx.tool('status', { text: 'Edited design' });
      await ctx.tool('send', { to: 'architect', text: 'Done editing' });
      await ctx.tool('done', { note: 'ok' });
    },
  });
  const goal = d.startGoal({ request: 'Shared' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  const sharedDir = d.goals.get(goal)!.sharedDir;

  assert.doesNotMatch(seen.first, /Changed in the shared folder/, 'v1 was written before the implementer existed');
  assert.match(seen.second, /Changed in the shared folder .*: design\.md \(updated by architect, just now\)/);
  assert.match(seen.clash, /design\.md in the shared folder is architect's \(it wrote it first\), and your write replaced their version\. The version before is kept at .*\.history\/design\.md\/002-architect\.md/);
  assert.match(seen.architect, /implementer-1 changed design\.md in the shared folder, which you wrote first/);

  assert.deepEqual(readdirSync(join(sharedDir, '.history', 'design.md')), ['001-architect.md', '002-architect.md', '003-implementer-1.md']);
  assert.equal(readFileSync(join(sharedDir, '.history', 'design.md', '002-architect.md'), 'utf8'), 'v2\n');
  const writes = d.store.ofType('shared.write').map(e => `${e.data.path} v${e.data.version} ${e.data.by}`);
  assert.deepEqual(writes, ['design.md v1 architect', 'design.md v2 architect', 'design.md v3 implementer-1']);
  const clash = d.store.ofType('shared.clash')[0];
  assert.deepEqual([clash.data.owner, clash.data.by], ['architect', 'implementer-1']);
  await d.close();
});

test('a shared file deleted and written again carries on its versions, also after a restart', () => {
  const dir = join(makeRepo(), 'shared');
  mkdirSync(dir);
  const f = new SharedFolder(dir);
  writeFileSync(join(dir, 'a.md'), '1');
  assert.deepEqual(f.scan().map(c => c.path), ['a.md']);
  f.record('a.md', 'x');
  writeFileSync(join(dir, 'a.md'), '1');
  assert.deepEqual(f.scan(), [], 'same content is no change');
  rmSync(join(dir, 'a.md'));
  assert.deepEqual(f.scan().map(c => c.deleted), [true]);
  writeFileSync(join(dir, 'a.md'), '2');
  const [again] = f.scan();
  assert.equal(again.before?.owner, 'x');
  assert.equal(f.files.get('a.md')!.version, 2);

  const after = new SharedFolder(dir);
  after.seed(new Map([['a.md', { version: 2, owner: 'x' }]]));
  writeFileSync(join(dir, 'a.md'), '3');
  after.scan();
  assert.equal(after.files.get('a.md')!.version, 3);
  assert.equal(after.files.get('a.md')!.owner, 'x');
});

test('open conflicts and shared-file owners survive a restart', () => {
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>, agent?: string) => ({ seq: ++seq, ts: new Date().toISOString(), goal: 'g1', agent, type, data });
  const r = replayGoal([
    ev('goal.started', { request: 'r', dir: '/repo', sharedDir: '/s', branch: 'trunk', base: 'abc' }),
    ev('shared.write', { path: 'design.md', version: 1, by: 'architect' }, 'architect'),
    ev('shared.write', { path: 'design.md', version: 2, by: 'impl' }, 'impl'),
    ev('shared.write', { path: 'notes/x.md', version: 1, by: null }),
    ev('git.conflict', { op: 'merge', branch: 'trunk', sha: 'def', files: ['a'], dir: '/repo' }, 'architect'),
    ev('git.conflict', { op: 'merge', branch: 'mh/g1/impl', sha: 'fed', files: ['b'], dir: '/wt/impl' }, 'impl'),
    ev('git.conflict_resolved', { op: 'merge', branch: 'mh/g1/impl', how: 'committed', dir: '/wt/impl' }, 'impl'),
  ])!;
  assert.deepEqual(Object.fromEntries(r.shared), { 'design.md': { version: 2, owner: 'architect' }, 'notes/x.md': { version: 1, owner: undefined } });
  assert.deepEqual([...r.conflicts.entries()], [['/repo', { op: 'merge', sha: 'def', branch: 'trunk', agent: 'architect' }]]);
});

test('deleting goals: their folder and events go; unsaved work holds a goal back unless forced; a goal at work is refused', async () => {
  const d = makeDaemon({
    architect: async ctx => {
      if (ctx.spec.brief.includes('dirty')) {
        await ctx.tool('spawn', { role: 'implementer', name: 'dirty', brief: 'dirty', worktree: true });
        await ctx.tool('wait', { timeout: 5 });
      }
      if (ctx.spec.brief.includes('slow')) await ctx.sleep(5000);
      await ctx.tool('done', { note: 'ok' });
    },
    implementer: async ctx => {
      writeFileSync(join(ctx.spec.cwd, 'wip.txt'), 'not committed\n');
      await ctx.tool('done', { note: 'left it uncommitted' });
    },
  });
  const finished = (goal: string) => withTimeout((async () => { while (d.agent(goal, 'architect')?.state !== 'done') await settle(); })(), 5000, `goal ${goal} to finish`);
  const plain = d.startGoal({ request: 'plain' });
  const dirty = d.startGoal({ request: 'dirty' });
  const slow = d.startGoal({ request: 'slow' });
  await finished(plain);
  await finished(dirty);
  writeFileSync(join(d.home, 'goals', plain, 'shared', 'report.md'), '# Report\n');
  mkdirSync(join(d.home, 'goals', 'deadbeef', 'shared'), { recursive: true });

  const sizes = d.goalSizes();
  assert.ok(sizes.find(s => s.id === plain)!.bytes > 0);
  assert.equal(sizes.find(s => s.id === 'deadbeef')!.known, false, 'a folder the log has no goal for');

  const r = d.deleteGoals([plain, dirty, slow, 'deadbeef']);
  assert.deepEqual(r.deleted, [plain, 'deadbeef']);
  assert.equal(r.kept[0].goal, dirty);
  assert.match(r.kept[0].items[0], /uncommitted change/);
  assert.match(r.refused[0], new RegExp(`Goal ${slow} is still at work \\(architect\\)`));
  assert.ok(!existsSync(join(d.home, 'goals', plain)) && !existsSync(join(d.home, 'goals', 'deadbeef')));
  assert.equal(d.store.since(plain).length, 0);
  assert.ok(!d.listGoals().some(g => g.id === plain));
  assert.ok(d.listGoals().some(g => g.id === dirty), 'kept while its work is unsaved');

  assert.deepEqual(d.deleteGoals([dirty], true).deleted, [dirty]);
  assert.ok(!existsSync(join(d.home, 'goals', dirty)));
  assert.equal(git(d.project().dir, 'branch', '--list', `mh/${dirty}/*`), '', 'its branch went too');
  await d.close();
});
