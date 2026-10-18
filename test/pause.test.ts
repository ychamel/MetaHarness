import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter, type FakeScript } from '../src/adapters/fake.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const role = '---\nharness: fake\nmodel: m\ngood_at: x\n---\nx\n';

/** Runs one command of `ms`, then reports whether it finished, as the agent's text. */
const oneCommand = (ms: number): FakeScript => async ctx => {
  await ctx.tool('status', { text: 'running' });
  const finished = await ctx.run('npm test', ms);
  ctx.say(finished ? 'command finished' : 'command cut short');
  await ctx.sleep(200);
};

for (const [what, ms, maxWaitMs, expect] of [
  ['an urgent message waits for the running command, then pauses the turn', 300, 5000, { text: 'command finished', cut: false }],
  ['a command that runs past the longest wait is interrupted anyway', 5000, 300, { text: 'command cut short', cut: true }],
] as const) {
  test(what, async () => {
    const d = makeTeam({ roles: { architect: role }, adapters: { fake: new FakeAdapter({ architect: oneCommand(ms) }) }, pause: { tickMs: 10, maxWaitMs } });
    const goal = d.startGoal({ request: 'r' });
    await withTimeout((async () => { while (d.agent(goal, 'architect')?.status !== 'running') await settle(); })(), 2000, 'running');
    d.deliver(goal, 'human', 'architect', 'Stop.', true);
    const paused = await withTimeout(
      (async () => {
        for (;;) {
          const e = d.store.ofType('agent.paused_between_steps')[0];
          if (e) return e;
          await settle();
        }
      })(),
      3000,
      'paused',
    );
    assert.equal(paused.data.cut, expect.cut);
    await settle();
    assert.ok(d.store.since(goal).some(e => e.type === 'agent.text' && e.data.text === expect.text));
    await d.close();
  });
}
