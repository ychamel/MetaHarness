import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '../src/adapters/fake.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const role = '---\nharness: fake\nmodel: m\ngood_at: testing\n---\nYou are a test role.\n';

const fresh = (brief: string) => brief.includes('in a fresh session');

test('a context nearly full mid-turn: notes first, then a fresh session from a handoff at the next step boundary', async () => {
  let notesAsk = '';
  let handoff = '';
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A. Ping me with questions.' });
      for (let i = 0; i < 40; i++) if ((await ctx.tool('wait', { timeout: 5 })).includes('Finished:')) break;
      await ctx.tool('done', { note: 'Part A is built.' });
    },
    implementer: async ctx => {
      if (fresh(ctx.spec.brief)) {
        handoff = ctx.spec.brief;
        return void (await ctx.tool('done', { note: 'Finished part A in the fresh session.' }));
      }
      await ctx.tool('status', { text: 'Writing part A' });
      await ctx.tool('send', { to: 'architect', text: 'Starting on part A.' });
      ctx.context(85, 170_000);
      notesAsk = (await ctx.nextMessage(2000)) ?? '(nothing)';
      ctx.writeShared('notes/implementer-1.md', 'Part A: parser done, tests next.\n');
      // Still mid-step: the switch waits for this command to finish.
      await ctx.run('npm test', 300);
      while (!ctx.stopped()) await ctx.tool('wait', { timeout: 1 });
    },
  });
  const d = makeTeam({ roles: { architect: role, implementer: role }, adapters: { fake }, pause: { tickMs: 20 } });
  const goal = d.startGoal({ request: 'Build part A of the parser' });
  await withTimeout(d.goals.get(goal)!.leadDone, 8000, 'lead done');
  await settle();

  assert.match(notesAsk, /context window is 85% full/);
  assert.match(notesAsk, /shared\/notes\/implementer-1\.md/);
  const events = d.store.since(goal).filter(e => e.agent === 'implementer-1');
  const full = events.find(e => e.type === 'agent.context_full');
  const switched = events.find(e => e.type === 'agent.context_handoff');
  assert.equal(full?.data.notesAsked, true);
  assert.equal(switched?.data.midTurn, true);
  const ranTests = events.findIndex(e => e.type === 'agent.tool_result' && e.data.summary === 'done');
  assert.ok(ranTests >= 0 && ranTests < events.indexOf(switched!), 'the command finished before the switch');

  const impl = d.agent(goal, 'implementer-1')!;
  assert.equal(impl.harness, 'fake', 'same harness and model');
  assert.equal(impl.state, 'done');
  assert.equal(fake.started.filter(s => s.spec.agent === 'implementer-1').length, 2);
  assert.equal(fake.started.at(-1)!.resume, undefined, 'a new session, not the old one resumed');

  assert.match(handoff, /continuing as implementer-1, the implementer, in a fresh session: your last one stopped because its context window was 85% full/);
  assert.match(handoff, /## The goal \(the human's request\)\n\nBuild part A of the parser/, 'the handoff carries the goal');
  assert.match(handoff, /Build part A\. Ping me/, 'and the original brief');
  assert.match(handoff, /Writing part A/, 'and its progress: status lines');
  assert.match(handoff, /you → architect: Starting on part A\./, 'messages');
  assert.match(handoff, /notes\/implementer-1\.md\. Read them first/, 'its notes');
  assert.match(handoff, /## Your team now\n\n- architect \(architect\): (waiting|working)/, 'and its team');
  assert.doesNotMatch(handoff, /context window is 85% full, so in a few minutes/, 'the notes request was delivered, not carried over');
  await d.close();
});

test('a context nearly full between turns: no turn is spent on it; the next message starts the fresh session', async () => {
  let handoff = '';
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.' });
      await ctx.tool('wait', { timeout: 5 });
      await ctx.sleep(100);
      await ctx.tool('send', { to: 'implementer-1', text: 'Please also add tests.' });
      for (let i = 0; i < 40; i++) if ((await ctx.tool('wait', { timeout: 5 })).includes('Tests added')) break;
      await ctx.tool('done', { note: 'Part A is built and tested.' });
    },
    implementer: async ctx => {
      if (fresh(ctx.spec.brief)) {
        handoff = ctx.spec.brief;
        return void (await ctx.tool('done', { note: 'Tests added.' }));
      }
      await ctx.tool('done', { note: 'Part A built.' });
      // The harness reports the last call's usage after the turn has ended.
      setTimeout(() => ctx.context(91), 20);
    },
  });
  const d = makeTeam({ roles: { architect: role, implementer: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'Build part A' });
  await withTimeout(d.goals.get(goal)!.leadDone, 8000, 'lead done');
  await settle();

  const events = d.store.since(goal).filter(e => e.agent === 'implementer-1');
  assert.equal(events.find(e => e.type === 'agent.context_full')?.data.notesAsked, false, 'no turn just to write notes');
  assert.equal(events.find(e => e.type === 'agent.context_handoff')?.data.midTurn, false);
  assert.equal(fake.started.filter(s => s.spec.agent === 'implementer-1').length, 2);
  assert.match(handoff, /## New since then\n\n\[MetaHarness\] Message from architect: Please also add tests\./);
  assert.match(handoff, /## The goal/);
  const delivered = d.store.since(goal).find(e => e.type === 'message.delivered' && e.agent === 'implementer-1');
  assert.equal(delivered?.data.via, 'handoff');
  await d.close();
});

test('no handoff when the setting is off, or for a harness that compacted first', async () => {
  const fake = new FakeAdapter({
    architect: async ctx => {
      ctx.context(95);
      await ctx.tool('status', { text: 'still here' });
      await ctx.tool('done', { note: 'ok' });
    },
  });
  const off = makeTeam({ roles: { architect: role }, adapters: { fake }, settings: { approvals: 'ask', contextHandoffPct: 0 } });
  const g1 = off.startGoal({ request: 'r' });
  await withTimeout(off.goals.get(g1)!.leadDone, 5000, 'lead done');
  assert.equal(off.store.since(g1).filter(e => e.type.startsWith('agent.context')).length, 0);
  await off.close();

  const compacting = new FakeAdapter({
    architect: async ctx => {
      ctx.context(85);
      await ctx.nextMessage(1000);
      ctx.context(30);
      await ctx.sleep(100);
      await ctx.tool('done', { note: 'ok' });
    },
  });
  const d = makeTeam({ roles: { architect: role }, adapters: { fake: compacting } });
  const g2 = d.startGoal({ request: 'r' });
  await withTimeout(d.goals.get(g2)!.leadDone, 5000, 'lead done');
  assert.equal(d.store.since(g2).filter(e => e.type === 'agent.context_handoff').length, 0);
  assert.equal(compacting.started.length, 1);
  await d.close();
});

test('a session that starts nearly as full as the threshold is not handed off again', async () => {
  const fake = new FakeAdapter({
    architect: async ctx => {
      ctx.context(70);
      ctx.context(85);
      await ctx.tool('status', { text: 'still here' });
      await ctx.tool('done', { note: 'ok' });
    },
  });
  const d = makeTeam({ roles: { architect: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  assert.equal(d.store.since(goal).filter(e => e.type.startsWith('agent.context')).length, 0);
  assert.equal(d.agent(goal, 'architect')!.contextPct, 85);
  await d.close();
});
