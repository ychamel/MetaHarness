import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('by default the team works in the human checkout, like native subagents', async () => {
  const repo = makeRepo();
  const seen: Record<string, string> = {};
  const d = makeDaemon(
    {
      architect: async ctx => {
        // Not committed: a teammate in the same folder sees it straight away.
        writeFileSync(join(ctx.spec.cwd, 'DESIGN.md'), 'draft\n');
        seen.spawn = await ctx.tool('spawn', { role: 'reviewer', brief: 'Look at DESIGN.md' });
        seen.review = await ctx.tool('wait', { timeout: 5 });
        commitFile(ctx, 'DESIGN.md', 'final\n', 'Design');
        await ctx.tool('done', { note: 'Designed.' });
      },
      reviewer: async ctx => {
        await ctx.tool('done', { note: `cwd ${ctx.spec.cwd}; design says ${readFileSync(join(ctx.spec.cwd, 'DESIGN.md'), 'utf8').trim()}` });
      },
    },
    { repo },
  );
  const goal = d.startGoal({ request: 'Design it' });
  const note = await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  const g = d.goals.get(goal)!;
  for (const a of g.agents.values()) {
    assert.equal(a.cwd, repo, `${a.name} works in the checkout`);
    assert.equal(a.worktree, undefined);
  }
  assert.match(seen.spawn, /in the shared folder/);
  assert.match(seen.review, new RegExp(`cwd ${repo}; design says draft`));
  assert.equal(git(repo, 'branch', '--show-current'), 'trunk');
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'Design', 'commits land on the branch the human has checked out');
  assert.equal(git(repo, 'for-each-ref', `refs/heads/mh/${goal}/`), '', 'no branches are made for anyone');
  assert.match(note, new RegExp(`The team's work is in ${repo} on trunk: 1 commit since the goal started\\.`));
  await d.close();
});

test('a workflow can give parallel implementers worktrees; the lead merges them into the checked-out branch', async () => {
  const repo = makeRepo();
  const seen: Record<string, string> = {};
  const d = makeDaemon(
    {
      architect: async ctx => {
        commitFile(ctx, 'DESIGN.md', 'api.js serves, client.js calls it\n', 'Design');
        seen.apiSpawn = await ctx.tool('spawn', { role: 'implementer', name: 'api', brief: 'Write api.js', worktree: true });
        await ctx.tool('spawn', { role: 'implementer', name: 'client', brief: 'Write client.js on top of api.js', worktree: 'true' });
        for (let finished = 0; finished < 2; ) finished += ((await ctx.tool('wait', { timeout: 5 })).match(/^- (api|client):/gm) ?? []).length;
        const goal = ctx.spec.goal;
        // `from` implies a worktree: the reviewer gets the client's code. Two branches then share that commit.
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

  assert.equal(g.agents.get('architect')!.cwd, repo, 'the lead works in the checkout');
  assert.equal(g.agents.get('api')!.worktree?.branch, `mh/${goal}/api`);
  assert.match(seen.apiSpawn, new RegExp(`in its own worktree on branch mh/${goal}/api`));
  assert.notEqual(seen['api.cwd'], seen['client.cwd']);
  for (const a of ['api', 'client']) assert.ok(seen[`${a}.cwd`].startsWith(join(d.home, 'goals', goal, 'worktrees')));
  assert.equal(seen['api.sawDesign'], 'true', 'a worktree starts from the latest commit');
  assert.equal(seen.clientHadApiFirst, 'false');
  assert.match(seen.reviewerSpawn, new RegExp(`on branch mh/${goal}/reviewer-1`));
  assert.match(seen.review, /files: api\.js client\.js/, 'from: client starts the reviewer on the client branch');

  // Everything is merged into the human's branch, in their checkout.
  assert.equal(git(repo, 'branch', '--show-current'), 'trunk');
  for (const f of ['DESIGN.md', 'api.js', 'client.js']) assert.ok(existsSync(join(repo, f)), `${f} in the checkout`);
  assert.match(note, /on trunk: 5 commits since the goal started\./);
  assert.doesNotMatch(note, /not merged/, 'the reviewer committed nothing, so every branch with work is merged');

  d.refreshGit(goal);
  const ev = d.store.since(goal);
  const commits = ev.filter(e => e.type === 'git.commit').map(e => `${e.agent ?? '-'}: ${e.data.summary}`);
  assert.deepEqual(commits.filter(c => /Add (api|client)/.test(c)), ['api: Add api', 'client: Add client']);
  const merges = ev.filter(e => e.type === 'git.merge').map(e => `${e.data.from} → ${e.data.into}${e.data.fastForward ? ' (ff)' : ''}`);
  assert.deepEqual(merges, [`mh/${goal}/api → mh/${goal}/client (ff)`, `mh/${goal}/api → trunk`, `mh/${goal}/client → trunk`]);
  d.refreshGit(goal);
  assert.equal(d.store.since(goal).length, ev.length, 'nothing is reported twice');
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
  assert.match(reply, /there's no "nobody-here".*Teammates with worktrees: none/);
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

test('uncommitted changes in the checkout are pointed out', async () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'README.md'), 'edited but not committed\n');
  const d = makeDaemon(undefined, { repo });
  const r = await d.command({ cmd: 'goal.start', request: 'Dirty repo' });
  assert.match(String(r.notice), /works in your checkout.*on trunk\. You have uncommitted changes: the agents will see them/);
  await withTimeout(d.goals.get(String(r.goal))!.leadDone, 5000, 'lead done');
  await d.close();
});
