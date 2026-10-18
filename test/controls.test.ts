import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Daemon } from '../src/daemon.ts';
import { FakeAdapter, type FakeScript, type FakeTurnScript } from '../src/adapters/fake.ts';
import { startServer } from '../src/server.ts';
import { makeDaemon, makeRepo, makeTeam, settle, withTimeout } from './helpers.ts';

const role = '---\nharness: fake\nmodel: m\ngood_at: x\n---\nx\n';
const configDir = join(import.meta.dirname, '..', '.metaharness');

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await settle();
  }
}

/** A long command, then waiting; later turns say what they got. */
const working: FakeScript = async ctx => {
  await ctx.tool('status', { text: 'running' });
  if (await ctx.run('npm test', 300)) ctx.say('tests passed');
  await ctx.sleep(300);
  if (await ctx.run('npm run build', 300)) ctx.say('built');
};
const echo: FakeTurnScript = async (ctx, text) => ctx.say(`Got: ${text}`);

for (const [harness, manifest] of [
  ['fake', {}],
  ['restartable', { harness: 'restartable', interrupt: false, injectMidTurn: false }],
] as const) {
  test(`pause waits for the current step, holds messages, and resume carries on (${harness})`, async () => {
    const adapter = new FakeAdapter({ architect: working }, manifest, { architect: echo });
    const d = makeTeam({ roles: { architect: role.replace('fake', harness) }, adapters: { [harness]: adapter }, pause: { tickMs: 10 } });
    const goal = d.startGoal({ request: 'r' });
    await until(() => d.agent(goal, 'architect')?.status === 'running', 'running');
    assert.equal(d.pauseAgent(goal, 'architect'), 'Pausing architect once its current step finishes.');
    assert.equal(d.snapshot(goal).goals[0].agents[0].pausing, true);
    await until(() => d.agent(goal, 'architect')!.state === 'paused', 'paused');
    const ev = () => d.store.since(goal);
    assert.ok(ev().some(e => e.type === 'agent.text' && e.data.text === 'tests passed'), 'the running command finished');
    assert.ok(!ev().some(e => e.type === 'agent.text' && e.data.text === 'built'), 'the next one never started');

    d.deliver(goal, 'human', 'architect', 'Also update the README.');
    await settle();
    assert.ok(!ev().some(e => e.type === 'message.delivered'), 'nothing reaches a paused agent');
    assert.equal(d.pauseAgent(goal, 'architect'), 'architect is already paused.');

    assert.equal(d.unpauseAgent(goal, 'architect'), 'Resumed architect.');
    await until(() => ev().some(e => e.type === 'agent.text' && /Got: .*Also update the README.*paused you between steps/s.test(String(e.data.text))), 'carried on with the message');
    if (harness === 'restartable') assert.equal(adapter.started.at(-1)!.resume, ev().find(e => e.type === 'agent.session')!.data.nativeSession, 'the same session resumed');
    assert.deepEqual(ev().filter(e => ['agent.paused', 'agent.resumed'].includes(e.type)).map(e => e.type), ['agent.paused', 'agent.resumed']);
    await d.close();
  });
}

test('ending a goal stops everyone and cleans up; spawning yourself; opening a session by hand', async () => {
  const d = makeDaemon({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'b', worktree: true });
      await ctx.tool('wait', { timeout: 30 });
    },
    implementer: async ctx => void (await ctx.nextMessage(30_000)),
    scout: async ctx => void (await ctx.tool('done', { note: 'Found it in src/a.ts.' })),
  });
  const goal = d.startGoal({ request: 'r' });
  await until(() => d.agent(goal, 'implementer-1')?.state === 'working', 'implementer working');

  const spawned = await d.command({ cmd: 'agent.spawn', goal, role: 'scout', brief: 'Where is a?' });
  assert.match(String(spawned.result), /^Started scout-1 \(fake · /);
  await until(() => d.humanInbox.some(i => i.agent === 'scout-1' && i.kind === 'done'), "the scout's answer comes to you");

  const open = d.openNative(goal, 'implementer-1');
  assert.match(open.command!, /^cd '.*worktrees\/implementer-1' && fake --resume fake-/);
  assert.match(open.note, /still running: pause it first/);

  const ended = d.endGoal(goal);
  assert.match(ended, /^Ended goal \w+; stopped architect, implementer-1\. MetaHarness removed 1 worktree and deleted 1 merged branch\./);
  assert.equal(d.snapshot(goal).goals[0].status, 'ended');
  assert.ok([...d.goals.get(goal)!.agents.values()].every(a => ['ended', 'done'].includes(a.state)));
  assert.equal(d.humanInbox.filter(i => i.kind === 'stopped').length, 0, 'ending a goal leaves no "stopped" notes for you');
  await d.close();
});

test('past goals: listed, and rebuilt from the log after a restart; agent detail', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-test-'));
  const repo = makeRepo();
  const daemon = () => new Daemon({ home, repo, configDirs: [configDir], adapters: { fake: new FakeAdapter({}) }, harnessOverride: 'fake', pollMs: 0 });
  const a = daemon();
  const goal = a.startGoal({ request: 'Write the README' });
  await withTimeout(a.goals.get(goal)!.leadDone, 3000, 'lead done');
  const live = a.agentDetail(goal, 'architect');
  assert.match(String(live.systemPrompt), /## Your role: architect/);
  assert.equal(live.live, true);
  await a.close();

  const b = daemon();
  b.recover();
  assert.equal(b.goals.size, 0, 'a finished goal is not resumed');
  const [listed] = b.listGoals();
  assert.deepEqual([listed.id, listed.status, listed.live, listed.agents], [goal, 'done', false, 1]);
  const s = b.snapshot(goal);
  assert.equal(s.goals[0].agents[0].name, 'architect');
  assert.equal(s.goals[0].agents[0].state, 'done');
  assert.match(String(s.goals[0].agents[0].doneNote), /Finished: Write the README/);
  assert.ok(s.harnesses.fake.reportsCost, 'what each harness can report comes along');
  const detail = b.agentDetail(goal, 'architect');
  assert.deepEqual([detail.live, detail.brief, detail.systemPrompt], [false, 'Write the README', null]);
  await b.close();
});

test('the daemon serves the web app without the token; the API needs it', async () => {
  const d = makeDaemon();
  const server = await startServer(d, 0, 'secret');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.equal((await fetch(`${base}/goals`)).status, 401);
    assert.equal((await fetch(`${base}/agent?goal=x&name=y`)).status, 401);
    const goals = await (await fetch(`${base}/goals?token=secret`)).json();
    assert.deepEqual(goals, { goals: [] });
  } finally {
    server.close();
    await d.close();
  }
});
