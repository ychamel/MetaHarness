import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../src/daemon.ts';
import { FakeAdapter, type FakeScript, type FakeTurnScript } from '../src/adapters/fake.ts';
import { git } from '../src/git.ts';
import { makeDaemon, makeRepo, settle, withTimeout } from './helpers.ts';

const configDir = join(import.meta.dirname, '..', '.metaharness');

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await settle();
  }
}

test('after a restart, agents cut off mid-turn resume their sessions; finished ones resume when messaged', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-test-'));
  const repo = makeRepo();
  // Two daemons in turn on the same home and repository, as when you restart `mh daemon`.
  const daemon = (adapter: FakeAdapter) => new Daemon({ home, repo, configDirs: [configDir], adapters: { fake: adapter }, harnessOverride: 'fake', pollMs: 0 });

  const before: Record<string, FakeScript> = {
    architect: async ctx => {
      await ctx.tool('send', { to: 'human', text: 'Which database should part B use?' });
      await ctx.tool('spawn', { role: 'documenter', brief: 'Write the README.' });
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.', worktree: true });
      for (let i = 0; i < 20; i++) await ctx.tool('wait', { timeout: 5 });
    },
    documenter: async ctx => void (await ctx.tool('done', { note: 'README written.' })),
    implementer: async ctx => {
      git(ctx.spec.cwd, 'commit', '--allow-empty', '-qm', 'Part A, first pass');
      await ctx.tool('status', { text: 'Building A' });
      await ctx.nextMessage(2000);
    },
  };
  // Without mid-turn delivery, a message to the busy implementer waits in its inbox.
  const d1 = daemon(new FakeAdapter(before, { injectMidTurn: false }));
  const goal = d1.startGoal({ request: 'Build parts A and B' });
  await until(() => d1.agent(goal, 'implementer-1')?.status === 'Building A' && d1.agent(goal, 'documenter-1')?.state === 'done', 'team at work');
  d1.refreshGit();
  const impl1 = d1.agent(goal, 'implementer-1')!;
  const implSession = impl1.session!.nativeId;
  const leadSession = d1.agent(goal, 'architect')!.session!.nativeId;
  const docSession = d1.agent(goal, 'documenter-1')!.session!.nativeId;
  d1.deliver(goal, 'human', 'implementer-1', 'Also handle part B.');
  void d1.requestApproval(impl1, 'Bash', 'rm -rf build');
  await d1.close();
  // Work goes on while no daemon runs.
  git(impl1.worktree!.path, 'commit', '--allow-empty', '-qm', 'Part A, second pass');

  const turns: Record<string, string[]> = { architect: [], implementer: [], documenter: [] };
  const record = (role: string, then: FakeTurnScript): FakeTurnScript => async (ctx, text) => {
    turns[role].push(text);
    await then(ctx, text);
  };
  const after = new FakeAdapter({}, { injectMidTurn: false }, {
    architect: record('architect', async (ctx, text) => {
      if (text.includes('implementer-1 finished')) await ctx.tool('done', { note: 'Parts A and B are built.' });
    }),
    implementer: record('implementer', async ctx => void (await ctx.tool('done', { note: 'A and B are built.' }))),
    documenter: record('documenter', async ctx => void (await ctx.tool('done', { note: 'Usage section added.' }))),
  });
  const d2 = daemon(after);
  try {
    assert.deepEqual(d2.recover(), [{ goal, request: 'Build parts A and B', resumed: ['architect', 'implementer-1'], later: ['documenter-1'] }]);
    const resumedFrom = (role: string) => after.started.find(s => s.spec.role.name === role)?.resume;
    assert.equal(resumedFrom('implementer'), implSession, 'the implementer continues its own session');
    assert.equal(resumedFrom('architect'), leadSession);
    assert.equal(resumedFrom('documenter'), undefined, 'a finished agent waits for a message');

    const g = d2.goals.get(goal)!;
    await withTimeout(g.leadDone, 5000, 'lead done after the restart');
    assert.match(turns.implementer[0], /MetaHarness restarted while you were working/);
    assert.match(turns.implementer[0], /Message from human: Also handle part B\./, 'the queued message arrives with the restart note');
    assert.match(turns.architect[0], /documenter-1 \(documenter\): done\. It finished: README written\./, 'the lead hears how its team stands');

    // The human's question is still open; the approval for the old session is not.
    assert.deepEqual(d2.humanInbox.filter(i => i.kind !== 'done').map(i => [i.kind, i.text]), [['question', 'Which database should part B use?']]);
    assert.ok(d2.store.since(goal).some(e => e.type === 'inbox.resolved' && e.data.why === 'the daemon restarted'));

    // Commits already reported aren't reported again; the one made in between is.
    d2.refreshGit();
    const commits = d2.store.since(goal).filter(e => e.type === 'git.commit').map(e => e.data.summary);
    assert.deepEqual(commits, ['Part A, first pass', 'Part A, second pass']);

    d2.deliver(goal, 'human', 'documenter-1', 'Add a usage section.');
    await until(() => turns.documenter.length > 0, 'documenter resumed');
    assert.equal(resumedFrom('documenter'), docSession);
    assert.match(turns.documenter[0], /Message from human: Add a usage section\./);
  } finally {
    await d2.close();
  }
});

test('a goal whose lead has finished is not picked up again', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-test-'));
  const repo = makeRepo();
  const daemon = () => new Daemon({ home, repo, configDirs: [configDir], adapters: { fake: new FakeAdapter({}) }, harnessOverride: 'fake', pollMs: 0 });
  const d1 = daemon();
  const goal = d1.startGoal({ request: 'Say hello' });
  await withTimeout(d1.goals.get(goal)!.leadDone, 3000, 'lead done');
  await d1.close();
  const d2 = daemon();
  assert.deepEqual(d2.recover(), []);
  assert.equal(d2.goals.size, 0);
  await d2.close();
});

test("commits in the human's checkout are named after the agent whose command made them", async () => {
  const d = makeDaemon({
    architect: async ctx => {
      await ctx.run('git commit -qm "Tidy the README"', 1);
      git(ctx.spec.cwd, 'commit', '--allow-empty', '-qm', 'Tidy the README');
      await ctx.tool('done', { note: 'Tidied.' });
    },
  });
  const goal = d.startGoal({ request: 'Tidy up' });
  await withTimeout(d.goals.get(goal)!.leadDone, 3000, 'lead done');
  d.refreshGit();
  const commit = d.store.since(goal).find(e => e.type === 'git.commit');
  assert.equal(commit?.agent, 'architect');
  assert.equal(commit?.data.summary, 'Tidy the README');
  await d.close();
});
