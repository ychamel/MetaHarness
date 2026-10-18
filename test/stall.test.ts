import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '../src/adapters/fake.ts';
import type { Daemon } from '../src/daemon.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const role = '---\nharness: fake\nmodel: m\ngood_at: testing\n---\nYou are a test role.\n';
const MIN = 60_000;

const until = (what: string, ok: () => boolean) =>
  withTimeout(
    (async () => {
      while (!ok()) await settle();
    })(),
    5000,
    what,
  );

const stalls = (d: Daemon, goal: string) => d.store.since(goal).filter(e => e.type === 'goal.stalled');

test('two teammates waiting on each other: the lead hears once; if the whole team stays stuck, the human does', async () => {
  const heard: string[] = [];
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.' });
      await ctx.tool('spawn', { role: 'reviewer', brief: 'Review part A.' });
      for (let i = 0; i < 3; i++) heard.push(await ctx.tool('wait', { timeout: 600 }));
    },
    implementer: async ctx => {
      await ctx.tool('send', { to: 'reviewer-1', text: 'Are you ready to review?' });
      while (!ctx.stopped()) await ctx.tool('wait', { timeout: 600 });
    },
    reviewer: async ctx => {
      await ctx.sleep(30);
      await ctx.tool('send', { to: 'implementer-1', text: 'Tell me when part A is ready.' });
      await ctx.tool('wait', { timeout: 600 });
    },
  });
  const d = makeTeam({ roles: { architect: role, implementer: role, reviewer: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'Build and review part A' });
  const a = (n: string) => d.agent(goal, n);
  // Each one's wait returned the other's message; now all three wait.
  await until('all waiting', () => ['architect', 'implementer-1', 'reviewer-1'].every(n => a(n)?.state === 'waiting') && !a('implementer-1')!.inbox.length && !a('reviewer-1')!.inbox.length);
  await until('the second waits', () => d.store.since(goal).filter(e => e.type === 'message.delivered').length === 2);
  await settle();

  d.checkStalls(Date.now() + 5 * MIN);
  assert.equal(stalls(d, goal).length, 0, 'not before stallMinutes');

  const t1 = Date.now() + 11 * MIN;
  d.checkStalls(t1);
  await until('the lead hears', () => heard.length === 1);
  assert.match(heard[0], /Nobody on the team has done anything for 10\+ minutes/);
  assert.match(heard[0], /- implementer-1 \(implementer\): waiting 11 min with nothing happening; reviewer-1 is waiting too\. Last from reviewer-1, just now: "Tell me when part A is ready\."/);
  assert.match(heard[0], /- reviewer-1 \(reviewer\): .*implementer-1 is waiting too/);
  assert.match(heard[0], /the plan left a gap/);
  assert.equal(stalls(d, goal)[0].data.told, 'lead');

  d.checkStalls(t1 + MIN);
  assert.equal(stalls(d, goal).length, 1, 'once per stuck spell');
  assert.equal(d.humanInbox.length, 0);

  // The lead did nothing about it: another stallMinutes later the human hears.
  await until('the lead waits again', () => a('architect')!.state === 'waiting');
  d.checkStalls(t1 + 11 * MIN);
  const item = d.humanInbox.find(i => i.kind === 'stalled');
  assert.ok(item, 'the human is told');
  assert.equal(item.agent, 'architect');
  assert.match(item.text, /architect \(the lead\) was told 11 minutes ago but nothing has moved/);
  assert.equal(stalls(d, goal).at(-1)!.data.told, 'human');
  d.checkStalls(t1 + 30 * MIN);
  assert.equal(d.humanInbox.filter(i => i.kind === 'stalled').length, 1);

  // Answering it reaches the lead.
  d.resolveInbox(item.id, 'dismiss', 'Tell the reviewer part A is on implementer-1’s branch.');
  await until('the lead gets the answer', () => heard.length === 2);
  assert.match(heard[1], /from human: Tell the reviewer/);
  await d.close();
});

test("waiting on a teammate who has finished is a stall; waiting while others work, or on the human, isn't", async () => {
  const heard: string[] = [];
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.' });
      await ctx.tool('spawn', { role: 'reviewer', brief: 'Review part A when it is ready.' });
      await ctx.tool('spawn', { role: 'documenter', brief: 'Document part A.' });
      for (let i = 0; i < 5; i++) heard.push(await ctx.tool('wait', { timeout: 600 }));
    },
    implementer: async ctx => void (await ctx.tool('done', { note: 'Part A is on my branch.' })),
    reviewer: async ctx => {
      await ctx.tool('send', { to: 'implementer-1', text: 'Tell me when part A is ready.' });
      await ctx.tool('wait', { timeout: 600 });
    },
    documenter: async ctx => {
      await ctx.tool('send', { to: 'human', text: 'British or American spelling?' });
      await ctx.tool('wait', { timeout: 600 });
    },
  });
  const d = makeTeam({ roles: { architect: role, implementer: role, reviewer: role, documenter: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'Build part A' });
  const a = (n: string) => d.agent(goal, n);
  await until('settled', () => a('reviewer-1')?.state === 'waiting' && a('documenter-1')?.state === 'waiting' && a('implementer-1')?.state === 'done' && a('architect')?.state === 'waiting');
  await until('the lead heard implementer-1 finish', () => heard.some(h => h.includes('Part A is on my branch')));
  await settle();

  const t = Date.now() + 11 * MIN;
  d.checkStalls(t);
  await until('the lead hears', () => heard.some(h => h.includes('From MetaHarness')));
  const report = heard.find(h => h.includes('From MetaHarness'))!;
  assert.match(report, /This teammate seems stuck, waiting for something that can't come:\n- reviewer-1 \(reviewer\): waiting 11 min with nothing happening; implementer-1 has finished\. Last to implementer-1/);
  assert.doesNotMatch(report, /documenter-1/, 'waiting on the human is not a stall');
  assert.doesNotMatch(report, /- architect/, 'the lead waits on teammates who are fine');
  assert.deepEqual((stalls(d, goal)[0].data.agents as { name: string }[]).map(x => x.name), ['reviewer-1']);
  await d.close();
});

test('an agent that stopped without calling done is not stuck, and stall reports can be turned off', async () => {
  const fake = new FakeAdapter({
    architect: async ctx => void ctx.say('I stopped early.'),
  });
  const d = makeTeam({ roles: { architect: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('idle', () => d.agent(goal, 'architect')?.state === 'idle');
  d.checkStalls(Date.now() + 60 * MIN);
  assert.equal(stalls(d, goal).length, 0);
  await d.close();

  const waiting = new FakeAdapter({ architect: async ctx => void (await ctx.tool('wait', { timeout: 600 })) });
  const off = makeTeam({ roles: { architect: role }, adapters: { fake: waiting }, settings: { approvals: 'ask', stallMinutes: 0 } });
  const g2 = off.startGoal({ request: 'r' });
  await until('waiting', () => off.agent(g2, 'architect')?.state === 'waiting');
  off.checkStalls(Date.now() + 60 * MIN);
  assert.equal(stalls(off, g2).length, 0);
  await off.close();
});
