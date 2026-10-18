import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter, type FakeScript, type FakeTurnScript } from '../src/adapters/fake.ts';
import { probeHarness } from '../src/probe.ts';
import { makeTeam } from './helpers.ts';

/** A fake agent that follows the probe's instructions the way a model would. */
const follows: FakeScript = async ctx => {
  await ctx.tool('status', { text: 'probe started' });
  await ctx.run('sleep 20', 200);
  ctx.rateLimit({ status: 'ok', usedPct: 12 });
  const msg = (await ctx.nextMessage(1000)) ?? '';
  const code = /codeword is (\w+)/.exec(msg)?.[1];
  await ctx.tool('done', { note: code ? `codeword ${code}` : 'no codeword' });
};
const followUps: FakeTurnScript = async (ctx, text) => {
  const urgent = /interrupted (\w+)/.exec(text);
  if (urgent) return void (await ctx.tool('done', { note: `interrupted ${urgent[1]}` }));
  if (!/Follow-up/.test(text)) return;
  for (let i = 0; i < 3; i++) {
    if (!(await ctx.run('sleep 8', 300))) return;
    // A model takes a moment between steps; that's where the turn is paused.
    await ctx.sleep(150);
    if (ctx.stopped()) return;
  }
  await ctx.tool('done', { note: 'slept' });
};

test('mh test: a harness that does everything passes every check', async () => {
  const d = makeTeam({ roles: {}, adapters: { fake: new FakeAdapter({ probe: follows }, {}, { probe: followUps }) }, pause: { tickMs: 10 } });
  const r = await probeHarness(d, 'fake', 'm', { stepMs: 5000 });
  const by = Object.fromEntries(r.checks.map(c => [c.name, c]));
  assert.equal(by['MetaHarness tools (MCP)'].ok, true);
  assert.equal(by['Message during a turn'].ok, true, by['Message during a turn'].detail);
  assert.match(by['Message during a turn'].detail, /native/);
  assert.equal(by['Follow-up after done'].ok, true);
  assert.equal(by['Urgent message pauses the turn'].ok, true, by['Urgent message pauses the turn'].detail);
  assert.match(by['Urgent message pauses the turn'].detail, /^paused after the running command finished, natively/);
  assert.equal(by['Usage reported'].ok, true);
  assert.equal(by['Rate limits reported'].ok, true);
  assert.equal(d.humanInbox.length, 0, "the test's own notes don't stay in the Inbox");
  await d.close();
});

test('mh test: a harness without mid-turn delivery or interrupt says so', async () => {
  const fake = new FakeAdapter({ probe: follows }, { harness: 'plain', injectMidTurn: false, interrupt: false, resume: false }, { probe: followUps });
  const d = makeTeam({ roles: {}, adapters: { plain: fake } });
  const r = await probeHarness(d, 'plain', 'm', { stepMs: 5000 });
  const by = Object.fromEntries(r.checks.map(c => [c.name, c]));
  assert.equal(by['Message during a turn'].ok, false);
  assert.match(by['Message during a turn'].detail, /between turns|not in the done note/);
  assert.equal(by['Urgent message pauses the turn'].ok, false);
  await d.close();
});
