import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git.ts';
import type { FakeCtx } from '../src/adapters/fake.ts';
import { makeDaemon, makeRepo, withTimeout } from './helpers.ts';

/** What a scripted agent does in its working directory: write a file and commit it. */
function commitFile(ctx: FakeCtx, file: string, content: string, message: string): void {
  writeFileSync(join(ctx.spec.cwd, file), content);
  git(ctx.spec.cwd, 'add', file);
  git(ctx.spec.cwd, 'commit', '-qm', message);
}

test('parallel implementers work in their own worktrees, build on each other, and the lead merges', async () => {
  const repo = makeRepo();
  const repoHead = git(repo, 'rev-parse', 'HEAD');
  const seen: Record<string, string> = {};
  const d = makeDaemon(
    {
      architect: async ctx => {
        commitFile(ctx, 'DESIGN.md', 'api.js serves, client.js calls it\n', 'Design');
        await ctx.tool('spawn', { role: 'implementer', name: 'api', brief: 'Write api.js' });
        await ctx.tool('spawn', { role: 'implementer', name: 'client', brief: 'Write client.js on top of api.js' });
        for (let finished = 0; finished < 2; ) finished += ((await ctx.tool('wait', { timeout: 5 })).match(/^- (api|client):/gm) ?? []).length;
        const goal = ctx.spec.goal;
        // The reviewer's branch starts at the client's tip, so two branches share that commit.
        seen.reviewerSpawn = await ctx.tool('spawn', { role: 'reviewer', brief: 'Review client', from: 'client' });
        seen.review = await ctx.tool('wait', { timeout: 5 });
        git(ctx.spec.cwd, 'merge', '-q', '--no-ff', '--no-edit', `mh/${goal}/api`);
        git(ctx.spec.cwd, 'merge', '-q', '--no-ff', '--no-edit', `mh/${goal}/client`);
        await ctx.tool('done', { note: 'Merged api and client.' });
      },
      implementer: async ctx => {
        seen[`${ctx.spec.agent}.cwd`] = ctx.spec.cwd;
        seen[`${ctx.spec.agent}.sawDesign`] = String(existsSync(join(ctx.spec.cwd, 'DESIGN.md')));
        if (ctx.spec.agent === 'api') {
          commitFile(ctx, 'api.js', 'export const api = () => 42;\n', 'Add api');
          await ctx.tool('send', { to: 'client', text: `api.js is committed on mh/${ctx.spec.goal}/api` });
        } else {
          await ctx.nextMessage(3000);
          // Before merging, the client's worktree doesn't have the api, and nothing it does touches the api's.
          seen.clientHadApiFirst = String(existsSync(join(ctx.spec.cwd, 'api.js')));
          git(ctx.spec.cwd, 'merge', '-q', '--no-edit', `mh/${ctx.spec.goal}/api`);
          commitFile(ctx, 'client.js', "import { api } from './api.js';\n", 'Add client');
        }
        await ctx.tool('done', { note: 'committed' });
      },
      reviewer: async ctx => {
        await ctx.tool('done', { note: `files: ${readdirSync(ctx.spec.cwd).filter(f => f.endsWith('.js')).sort().join(' ')}` });
      },
    },
    { repo },
  );
  const goal = d.startGoal({ request: 'Build api and client in parallel' });
  const note = await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  const g = d.goals.get(goal)!;
  const main = `mh/${goal}/main`;

  // Separate worktrees under the goal folder, each on its own branch.
  const lead = g.agents.get('architect')!;
  assert.equal(lead.worktree?.branch, main);
  assert.equal(g.agents.get('api')!.worktree?.branch, `mh/${goal}/api`);
  assert.notEqual(seen['api.cwd'], seen['client.cwd']);
  for (const a of ['api', 'client']) assert.ok(seen[`${a}.cwd`].startsWith(join(d.home, 'goals', goal, 'worktrees')));
  assert.equal(seen['api.sawDesign'], 'true', "a new branch starts from its spawner's latest commit");
  assert.equal(seen.clientHadApiFirst, 'false');
  assert.match(seen.reviewerSpawn, new RegExp(`on branch mh/${goal}/reviewer-1`));
  assert.match(seen.review, /files: api\.js client\.js/, 'from: client starts the reviewer on the client branch');

  // The goal branch has everything; the human's checkout is untouched.
  const onMain = git(repo, 'ls-tree', '--name-only', main).split('\n');
  for (const f of ['DESIGN.md', 'api.js', 'client.js']) assert.ok(onMain.includes(f), `${f} on ${main}`);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), repoHead);
  assert.equal(git(repo, 'branch', '--show-current'), 'trunk');
  assert.ok(!existsSync(join(repo, 'api.js')));

  // The human hears where the work is and what's left unmerged.
  assert.match(note, new RegExp(`on branch ${main}, 5 commits ahead`));
  assert.doesNotMatch(note, /Not merged/, 'the reviewer committed nothing, so every branch with work is merged');

  d.refreshGit(goal);
  const ev = d.store.since(goal);
  const commits = ev.filter(e => e.type === 'git.commit').map(e => `${e.agent}: ${e.data.summary}`);
  assert.deepEqual(commits.filter(c => /Add (api|client)/.test(c)), ['api: Add api', 'client: Add client']);
  const merges = ev.filter(e => e.type === 'git.merge').map(e => `${e.agent}: ${e.data.from} → ${e.data.into}${e.data.fastForward ? ' (ff)' : ''}`);
  assert.deepEqual(merges, [
    `client: mh/${goal}/api → mh/${goal}/client (ff)`,
    `architect: mh/${goal}/api → ${main}`,
    `architect: mh/${goal}/client → ${main}`,
  ]);
  d.refreshGit(goal);
  assert.equal(d.store.since(goal).length, ev.length, 'nothing is reported twice');

  const spawned = ev.find(e => e.type === 'agent.spawned' && e.agent === 'api')!;
  assert.equal(spawned.data.branch, `mh/${goal}/api`);
  await d.close();
});

test('a bad "from" is explained, and the spawn goes nowhere', async () => {
  let reply = '';
  const d = makeDaemon({
    architect: async ctx => {
      reply = await ctx.tool('spawn', { role: 'implementer', brief: 'x', from: 'nobody-here' });
      await ctx.tool('done', {});
    },
  });
  const goal = d.startGoal({ request: 'Bad from' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  assert.match(reply, /there's no "nobody-here".*Teammates with branches: architect/);
  assert.equal(d.goals.get(goal)!.agents.size, 1);
  await d.close();
});

test('outside a git repository the team shares the directory, and is told so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-nogit-'));
  const d = makeDaemon(undefined, { repo: dir });
  const r = await d.command({ cmd: 'goal.start', request: 'No git here' });
  const goal = String(r.goal);
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  assert.match(String(r.notice), /No worktrees for this goal: .* isn't a git repository/);
  for (const a of d.goals.get(goal)!.agents.values()) {
    if (!a.quick) assert.equal(a.cwd, dir);
    assert.equal(a.worktree, undefined);
  }
  await d.close();
});

test('uncommitted changes in the repository are pointed out', async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'README.md'), 'edited but not committed\n');
  const d = makeDaemon(undefined, { repo });
  const r = await d.command({ cmd: 'goal.start', request: 'Dirty repo' });
  assert.match(String(r.notice), /uncommitted changes aren't in the agents' worktrees.*Initial commit/);
  await withTimeout(d.goals.get(String(r.goal))!.leadDone, 5000, 'lead done');
  await d.close();
});
