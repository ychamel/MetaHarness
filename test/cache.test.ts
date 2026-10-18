import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '../src/adapters/fake.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const role = '---\nharness: fake\nmodel: m\ngood_at: x\n---\nx\n';

test("a parent hears when a child's prompt cache is about to expire; an idle one isn't woken for it", async () => {
  let heard = '';
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'b' });
      await ctx.tool('wait', { timeout: 5 }); // implementer-1's done note
      heard = await ctx.tool('wait', { timeout: 5 });
    },
    implementer: async ctx => void (await ctx.tool('done', { note: 'built it' })),
  });
  const d = makeTeam({ roles: { architect: role, implementer: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  const lead = d.agent(goal, 'architect')!;
  const waitFor = (what: string, ok: () => boolean) =>
    withTimeout(
      (async () => {
        while (!ok()) await settle();
      })(),
      3000,
      what,
    );
  await waitFor('the second wait', () => d.agent(goal, 'implementer-1')?.state === 'done' && lead.state === 'waiting' && lead.inbox.length === 0);
  await settle();

  // implementer-1's 5-minute cache has 30 seconds left: the waiting architect is told.
  const child = d.agent(goal, 'implementer-1')!;
  const now = Date.now();
  child.lastCallAt = now - 4.5 * 60_000;
  child.contextTokens = 80_000;
  d.checkCaches(now);
  await waitFor('the reminder', () => !!heard);
  assert.match(heard, /Prompt cache about to expire for implementer-1 \(in about 30 s, 80k tokens of context\)/);
  const told = () => d.store.since(goal).filter(e => e.type === 'agent.cache_expiring');
  assert.deepEqual(told().map(e => [e.agent, e.data.told]), [['implementer-1', 'parent']]);
  d.checkCaches(now + 1000);
  assert.equal(told().length, 1, 'once per idle spell');

  // Small contexts aren't worth it; the lead's own cache is the human's to decide on.
  await waitFor('the lead idle', () => lead.state === 'idle');
  child.lastCallAt = now - 4.5 * 60_000 + 1;
  child.contextTokens = 5000;
  lead.lastCallAt = now - 4.5 * 60_000;
  lead.contextTokens = 50_000;
  d.checkCaches(now);
  assert.deepEqual(told().slice(1).map(e => [e.agent, e.data.told]), [['architect', 'human']]);

  // The architect is idle now: a child's reminder doesn't start a turn for it.
  child.contextTokens = 90_000;
  child.lastCallAt = now - 4.5 * 60_000 + 2;
  const turns = d.store.since(goal).filter(e => e.agent === 'architect' && e.type === 'agent.state' && e.data.state === 'working').length;
  d.checkCaches(now);
  await settle();
  assert.equal(told().at(-1)!.data.told, 'nobody');
  assert.equal(d.store.since(goal).filter(e => e.agent === 'architect' && e.type === 'agent.state' && e.data.state === 'working').length, turns);
  await d.close();
});
