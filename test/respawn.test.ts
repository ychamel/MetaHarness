import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { FakeAdapter } from '../src/adapters/fake.ts';
import { replayGoal } from '../src/recover.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const role = (harness: string, model: string, fallback = '') =>
  `---\nharness: ${harness}\nmodel: ${model}\n${fallback ? `fallback: ${fallback}\n` : ''}good_at: testing\n---\nYou are a test role.\n`;

const until = (what: string, ok: () => boolean) =>
  withTimeout(
    (async () => {
      while (!ok()) await settle();
    })(),
    5000,
    what,
  );

test('a crashed teammate: its spawner is told what it can do, respawns it under its name, and the crashed one keeps its history', async () => {
  const heard: string[] = [];
  const replies: string[] = [];
  const firstMessages: string[] = [];
  let runs = 0;
  const backup = new FakeAdapter(
    {
      implementer: async ctx => {
        firstMessages.push(ctx.spec.brief);
        await ctx.tool('done', { note: 'Part A is built, on the backup.' });
      },
    },
    { harness: 'fake2' },
  );
  const fake = new FakeAdapter(
    {
      architect: async ctx => {
        await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.', worktree: true });
        await ctx.tool('send', { to: 'implementer-1', text: 'Use the parser in src/parse.ts.' });
        for (let i = 0; i < 3; i++) {
          const w = await ctx.tool('wait', { timeout: 5 });
          heard.push(w);
          if (i === 0) replies.push(await ctx.tool('respawn', { name: 'implementer-1', note: 'Pick up where you were.' }));
          if (i === 1) replies.push(await ctx.tool('respawn', { name: 'implementer-1', on: 'fake2/m2' }));
        }
        await ctx.tool('done', { note: 'Part A is built.' });
      },
      implementer: async ctx => {
        runs++;
        await ctx.tool('status', { text: 'Writing the parser' });
        ctx.crash('the CLI exited with code 1: INTERNAL');
      },
    },
    {},
    {
      // The resumed session's first turn: it gets as far as a crash again.
      implementer: async (ctx, text) => {
        firstMessages.push(text);
        ctx.crash('the CLI exited with code 1 again');
      },
    },
  );
  const d = makeTeam({ roles: { architect: role('fake', 'm'), implementer: role('fake', 'm', 'fake2/m2') }, adapters: { fake, fake2: backup } });
  const goal = d.startGoal({ request: 'Build part A' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'the lead finishes');

  // The crash reaches the lead with its reason and the ways to carry on.
  assert.match(heard[0], /implementer-1 crashed before calling done \(the CLI exited with code 1: INTERNAL\)/);
  assert.match(heard[0], /call respawn with name: implementer-1\. Its session resumes where it stopped; add fresh: true .* or on: fake2\/m2 to run it there/);
  assert.match(replies[0], /Started implementer-1 again on fake · m, resuming its session\. The crashed one is kept as implementer-1-crashed\. implementer-1 reports to you/);

  // The first respawn resumed the crashed session, told why.
  const resumed = fake.started.at(-1)!;
  assert.ok(resumed.resume, 'resumed');
  assert.match(firstMessages[0], /Your session crashed \(the CLI exited with code 1: INTERNAL\), and architect started it again/);
  assert.match(firstMessages[0], /From architect: Pick up where you were\./);

  // It crashed again; the second respawn ran it on the backup from a handoff.
  assert.match(heard[1], /crashed before calling done \(the CLI exited with code 1 again\)/);
  assert.match(replies[1], /Started implementer-1 again on fake2 · m2, from a handoff\. The crashed one is kept as implementer-1-crashed-2/);
  assert.match(firstMessages[1], /You're taking over as implementer-1, the implementer\. Until now fake · m did this work, and it stopped because it crashed \(the CLI exited with code 1 again\)/);
  assert.match(firstMessages[1], /Commits on mh\/.*\/implementer-1|No commits on mh\/.*\/implementer-1/);
  assert.match(heard[2], /implementer-1: Part A is built, on the backup\./);
  assert.equal(runs, 1, 'resuming never ran the script from the start');

  // Each crash is a node of its own, with its history; the name went to the replacement, with the worktree.
  const g = d.goals.get(goal)!;
  const now = d.agent(goal, 'implementer-1')!;
  assert.equal(now.harness, 'fake2');
  assert.equal(now.doneNote, 'Part A is built, on the backup.');
  assert.ok(now.worktree, 'the worktree passed on');
  assert.equal(d.agent(goal, 'implementer-1-crashed')!.state, 'crashed');
  assert.equal(d.agent(goal, 'implementer-1-crashed')!.worktree, undefined);
  assert.equal(d.agent(goal, 'implementer-1-crashed-2')!.state, 'crashed');
  const events = d.store.since(goal);
  const of = (name: string) => events.filter(e => e.agent === name);
  assert.ok(of('implementer-1-crashed').some(e => e.type === 'agent.status' && e.data.text === 'Writing the parser'));
  assert.ok(of('implementer-1-crashed').some(e => e.type === 'agent.crashed'));
  assert.ok(events.some(e => e.type === 'message.sent' && e.data.to === 'implementer-1-crashed' && e.data.text === 'Use the parser in src/parse.ts.'), 'messages to it are renamed too');
  assert.deepEqual(events.filter(e => e.type === 'agent.renamed').map(e => [e.agent, e.data.from]), [['implementer-1-crashed', 'implementer-1'], ['implementer-1-crashed-2', 'implementer-1']]);
  assert.ok(!of('implementer-1').some(e => e.type === 'agent.crashed'), 'the replacement never crashed');
  assert.equal(existsSync(`${d.home}/goals/${goal}/agents/implementer-1-crashed-2`), true, 'a fresh session left the folder behind');

  // A restart rebuilds the same team.
  const r = replayGoal(events)!;
  assert.deepEqual([...r.agents.keys()].sort(), ['architect', 'implementer-1', 'implementer-1-crashed', 'implementer-1-crashed-2']);
  assert.equal(r.agents.get('implementer-1')!.harness, 'fake2');
  assert.equal(r.agents.get('implementer-1-crashed')!.state, 'crashed');
  assert.equal(r.lead, 'architect');
  assert.equal(g.lead, 'architect');
  await d.close();
});

test('only a crashed agent, by its spawner, the lead or the human', async () => {
  const said: string[] = [];
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.' });
      await ctx.tool('spawn', { role: 'implementer', name: 'other', brief: 'Build part B.' });
      await ctx.tool('wait', { timeout: 5 });
      said.push(await ctx.tool('respawn', { name: 'other' }));
      await ctx.tool('wait', { timeout: 5 });
    },
    implementer: async ctx => {
      if (ctx.spec.agent !== 'implementer-1') return void (await ctx.tool('wait', { timeout: 5 }));
      await ctx.tool('spawn', { role: 'implementer', name: 'sub', brief: 'Build part A2.' });
      ctx.crash('boom');
    },
  });
  const d = makeTeam({ roles: { architect: role('fake', 'm'), implementer: role('fake', 'm') }, adapters: { fake } });
  const goal = d.startGoal({ request: 'Build A and B' });
  await until('implementer-1 crashed', () => d.agent(goal, 'implementer-1')?.state === 'crashed');
  await until('the lead tried', () => said.length > 0);
  assert.match(said[0], /other hasn't crashed \(it's \w+\), so there's nothing to respawn/);

  assert.deepEqual(d.respawnAgent(goal, 'implementer-1', { by: 'other' }), { ok: false, error: 'Only architect (who spawned implementer-1) or the lead can respawn it.' });
  assert.match((d.respawnAgent(goal, 'nobody', { by: 'human' }) as { error: string }).error, /There's no agent called nobody\. Crashed teammates: implementer-1/);
  assert.match((d.respawnAgent(goal, 'implementer-1', { by: 'human', on: 'elsewhere' }) as { error: string }).error, /implementer runs on fake\/m; "elsewhere" isn't one of them/);
  const r = d.respawnAgent(goal, 'implementer-1', { by: 'human', fresh: true });
  assert.ok(r.ok);
  assert.match(r.text, /in a fresh session, from a handoff\. The crashed one is kept as implementer-1-crashed\. implementer-1 reports to architect/);
  // Its helper still reports to implementer-1: now the replacement.
  assert.equal(d.agent(goal, 'sub')!.parent, 'implementer-1');
  await d.close();
});

test('a crashed lead: the human hears in the Inbox and respawns it; the Inbox item goes', async () => {
  let runs = 0;
  const fake = new FakeAdapter({
    architect: async ctx => {
      if (++runs === 1) return ctx.crash('out of memory');
      await ctx.tool('done', { note: 'Planned it.' });
    },
  });
  const d = makeTeam({ roles: { architect: role('fake', 'm') }, adapters: { fake } });
  const goal = d.startGoal({ request: 'Plan it' });
  await until('the human hears', () => d.humanInbox.some(i => i.kind === 'crash'));
  const item = d.humanInbox.find(i => i.kind === 'crash')!;
  assert.match(item.text, /architect crashed before calling done \(out of memory\)/);
  assert.match(item.text, /mh respawn architect \(--fresh to start it over from a handoff\)/);

  const r = d.respawnAgent(goal, 'architect', { by: 'human', fresh: true });
  assert.ok(r.ok);
  assert.ok(!d.humanInbox.some(i => i.kind === 'crash'), 'the crash item is resolved');
  assert.match(await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'the new lead finishes'), /^Planned it\./);
  assert.equal(d.agent(goal, 'architect')!.isLead, true);
  assert.equal(d.agent(goal, 'architect-crashed')!.isLead, false);
  assert.equal(replayGoal(d.store.since(goal))!.lead, 'architect');
  await d.close();
});
