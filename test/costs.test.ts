import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ClaudeAdapter } from '../src/adapters/claude.ts';
import type { HarnessAdapter } from '../src/adapters/types.ts';
import { replayGoal } from '../src/recover.ts';
import { startServer } from '../src/server.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const fakeClaude = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const near = (a: number | undefined, b: number, what: string) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-6, `${what}: ${a} ≠ ${b}`);

test("Claude Code's usage arrives call by call; its cost is split by kind of token, and its cache lifetime is learned", async () => {
  const d = makeTeam({
    roles: { architect: '---\nharness: claude-code\nmodel: haiku\ngood_at: x\n---\nx\n' },
    adapters: { 'claude-code': new ClaudeAdapter({ bin: fakeClaude }) },
  });
  const server = await startServer(d, 0, 'secret');
  const goal = d.startGoal({ request: 'Read a.txt' });
  const usage = () => d.store.since(goal).filter(e => e.type === 'usage' && e.agent === 'architect');
  await withTimeout(
    (async () => {
      while (!usage().some(e => Number(e.data.costUsd) > 0.06)) await settle();
    })(),
    5000,
    'the first turn',
  );
  // Before the turn's end: input and cache counts, call by call (the repeated message counts once).
  const live = usage().filter(e => e.data.costUsd === 0);
  assert.deepEqual(
    live.map(e => e.data.cacheWrite),
    [28939, 28939 + 1135],
  );
  const a = d.agent(goal, 'architect')!;
  assert.deepEqual(a.tokens, { tokensIn: 928, tokensOut: 574, cacheRead: 28939, cacheWrite: 30074 });
  near(a.cost, 0.0668399, 'cost');
  assert.equal(a.costSource, 'harness');
  // Haiku is $1 per million input tokens; a 1-hour cache write costs twice that, a read a tenth.
  near(a.costSplit?.input, 928e-6, 'input');
  near(a.costSplit?.output, 574 * 5e-6, 'output');
  near(a.costSplit?.cacheRead, 28939 * 0.1e-6, 'cache reads');
  near(a.costSplit?.cacheWrite, 30074 * 2e-6, 'cache writes');
  const view = d.snapshot(goal).goals[0].agents[0];
  assert.equal(view.cacheMinutes, 60, 'the 1-hour cache was seen in the usage');
  assert.ok(view.cacheUntil! > Date.now() + 59 * 60_000);

  // The next turn is priced as it runs, from what the last one cost.
  d.deliver(goal, 'human', 'architect', 'Again.');
  await withTimeout(
    (async () => {
      while (!usage().some(e => Number(e.data.costUsd) > 0.0668399 && Number(e.data.costUsd) < 0.13)) await settle();
    })(),
    5000,
    'a running estimate',
  );
  await d.close();
  server.close();
});

test('tokens from a harness without costs are priced from the settings, and the log keeps it all', async () => {
  const tokenOnly: HarnessAdapter = {
    manifest: { harness: 'tok', injectMidTurn: false, resume: false, interrupt: false, reportsCost: false, reportsContext: false, reportsRateLimits: false },
    start: async (_spec, ev) => {
      setImmediate(() => {
        ev.turnStarted();
        ev.usage({ tokensIn: 1000, cacheRead: 9000, tokensOut: 500 });
        ev.turnEnded();
      });
      return { nativeId: 'tok-1', busy: () => false, send: async () => {}, stop: async () => {} };
    },
  };
  const d = makeTeam({
    roles: { architect: '---\nharness: tok\nmodel: m\ngood_at: x\n---\nx\n' },
    adapters: { tok: tokenOnly },
  });
  await d.command({ cmd: 'settings.save', scope: 'repo', patch: { models: { 'tok/m': { prices: { input: 2, output: 8, cacheRead: 0.5 } } } } });
  const goal = d.startGoal({ request: 'r' });
  await withTimeout(
    (async () => {
      while (d.agent(goal, 'architect')?.cost === undefined) await settle();
    })(),
    2000,
    'usage',
  );
  const a = d.agent(goal, 'architect')!;
  near(a.cost, (1000 * 2 + 500 * 8 + 9000 * 0.5) / 1e6, 'estimated cost');
  assert.equal(a.costSource, 'prices');
  near(a.costSplit?.cacheRead, 0.0045, 'cache reads');

  const r = replayGoal(d.store.since(goal))!.agents.get('architect')!;
  assert.deepEqual(r.tokens, { tokensIn: 1000, tokensOut: 500, cacheRead: 9000, cacheWrite: 0 });
  near(r.cost, 0.0105, 'replayed cost');
  assert.equal(r.costSource, 'prices');

  // A price changed later counts for the work already done.
  await d.command({ cmd: 'settings.save', scope: 'repo', patch: { models: { 'tok/m': { prices: { input: 4, output: 8 } } } } });
  near(d.snapshot(goal).goals[0].agents[0].cost ?? undefined, (1000 * 4 + 500 * 8 + 9000 * 4) / 1e6, 'cost at the new prices');
  await d.close();
});
