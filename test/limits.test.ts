import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter, type FakeScript } from '../src/adapters/fake.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const HOUR = 3600_000;

const role = (harness: string, model: string, fallback = '') =>
  `---\nharness: ${harness}\nmodel: ${model}\n${fallback ? `fallback: ${fallback}\n` : ''}good_at: testing\n---\nYou are a test role.\n`;

/** An architect that spawns one teammate in `spawnRole`, collects what it hears, and finishes when the teammate does. */
function leadScript(spawnRole: string, heard: string[]): FakeScript {
  return async ctx => {
    heard.push(await ctx.tool('spawn', { role: spawnRole, brief: 'Build part A. Ping me with questions.' }));
    for (let i = 0; i < 40; i++) {
      const w = await ctx.tool('wait', { timeout: 5 });
      heard.push(w);
      if (w.includes('Finished:')) break;
    }
    await ctx.tool('done', { note: 'Part A is built.' });
  };
}

test('near the limit agents are asked for notes; at the limit they move to a backup with a handoff', async () => {
  const heard: string[] = [];
  const got: string[] = [];
  let handoff = '';
  const primary = new FakeAdapter({
    architect: leadScript('implementer', heard),
    implementer: async ctx => {
      await ctx.tool('status', { text: 'Writing part A' });
      await ctx.tool('send', { to: 'architect', text: 'Starting on part A.' });
      ctx.rateLimit({ status: 'ok', usedPct: 92, resetsAt: Date.now() + 2 * HOUR, window: 'five_hour' });
      got.push((await ctx.nextMessage(2000)) ?? '(nothing)');
      ctx.writeShared('notes/implementer-1.md', 'Part A: parser done, tests next.\n');
      ctx.rateLimit({ status: 'limited', resetsAt: Date.now() + 2 * HOUR });
      await ctx.sleep(50);
    },
  });
  const backup = new FakeAdapter(
    {
      implementer: async ctx => {
        handoff = ctx.spec.brief;
        await ctx.tool('done', { note: 'Finished part A from the handoff.' });
      },
    },
    { harness: 'backup' },
  );
  const d = makeTeam({
    roles: { architect: role('fake', 'lead-model'), implementer: role('fake', 'sol', 'backup/backup-model') },
    adapters: { fake: primary, backup },
  });
  const goal = d.startGoal({ request: 'Build part A' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  await settle();

  assert.match(got[0], /at 92% of its limit/, 'the implementer is warned mid-turn');
  assert.match(got[0], /shared\/notes\/implementer-1\.md/);
  const impl = d.agent(goal, 'implementer-1')!;
  assert.equal(impl.harness, 'backup');
  assert.equal(impl.model, 'backup-model');
  assert.equal(impl.state, 'done');
  const moved = d.store.since(goal).find(e => e.type === 'agent.moved');
  assert.deepEqual(moved?.data.to, { harness: 'backup', model: 'backup-model' });

  assert.match(handoff, /taking over as implementer-1/);
  assert.match(handoff, /Build part A\. Ping me/, 'the handoff carries the original brief');
  assert.match(handoff, /Writing part A/, 'and its status lines');
  assert.match(handoff, /you → architect: Starting on part A\./, 'and its messages');
  assert.match(handoff, /notes\/implementer-1\.md\. Read them first/, 'and points to its notes');
  assert.match(handoff, /It worked in .* on trunk, which teammates share/, 'and says where the work is');

  assert.ok(heard.some(h => /implementer-1 moved from fake · sol to backup · backup-model/.test(h)), 'the lead is told about the move');
  assert.equal(d.accounts.get('fake')?.status, 'limited');
  const lead = d.store.since(goal).find(e => e.type === 'agent.limited' && e.agent === 'architect');
  assert.ok(lead, 'the lead shares the account, and with no backup it waits for the reset');
  assert.equal(d.agent(goal, 'architect')!.harness, 'fake');
  await d.close();
});

test('a limit that resets soon is waited out, then the agent carries on', async () => {
  const primary = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('status', { text: 'Designing' });
      ctx.rateLimit({ status: 'limited', resetsAt: Date.now() + 100 });
    },
  });
  const d = makeTeam({ roles: { architect: role('fake', 'm') }, adapters: { fake: primary }, limits: { marginMs: 0 } });
  const goal = d.startGoal({ request: 'Design it' });
  await withTimeout(
    (async () => {
      while (!d.store.since(goal).some(e => e.type === 'agent.text' && /should have reset/.test(String(e.data.text)))) await settle();
    })(),
    3000,
    'carry on',
  );
  const events = d.store.since(goal);
  const states = events.filter(e => e.type === 'agent.state').map(e => e.data.state);
  assert.ok(states.includes('limited'), `states were ${states.join(', ')}`);
  assert.ok(events.some(e => e.type === 'agent.limited' && e.data.known === true));
  assert.ok(!events.some(e => e.type === 'agent.idle' && events.indexOf(e) < events.findIndex(x => x.data.state === 'limited')), 'a refused turn is not "stopped without done"');
  assert.equal(d.agent(goal, 'architect')!.harness, 'fake', 'no move for a short wait');
  await d.close();
});

test('spawns go to a backup when the primary is limited or not runnable here', async () => {
  const heard: string[] = [];
  const fake = new FakeAdapter({
    architect: async ctx => {
      heard.push(await ctx.tool('spawn', { role: 'implementer', brief: 'x' }));
      heard.push(await ctx.tool('spawn', { role: 'reporter', brief: 'y' }));
      heard.push(await ctx.tool('spawn', { role: 'orphan', brief: 'z' }));
      await ctx.tool('done', {});
    },
  });
  const d = makeTeam({
    roles: {
      architect: role('fake', 'm'),
      implementer: role('busy', 'sol', 'fake/cheap'),
      reporter: role('antigravity', 'gemini', 'fake/flash'),
      orphan: role('nowhere', 'm'),
    },
    adapters: { fake, busy: new FakeAdapter({}, { harness: 'busy' }) },
  });
  d.accounts.set('busy', { id: 'busy', status: 'limited', resetsAt: Date.now() + 2 * HOUR, warned: new Set() });
  const goal = d.startGoal({ request: 'r' });
  await withTimeout(d.goals.get(goal)!.leadDone, 3000, 'lead done');
  assert.match(heard[0], /Started implementer-1 \(fake · cheap\).*backup fake · cheap, because busy is at its limit/);
  assert.match(heard[1], /Started reporter-1 \(fake · flash\).*because MetaHarness can't run antigravity yet/);
  assert.match(heard[2], /can't run nowhere yet.*mh doctor/);
  await d.close();
});

test('an urgent message interrupts: natively, or by restarting the session from its ID', async () => {
  const seen: (string | null)[] = [];
  const working: FakeScript = async ctx => {
    await ctx.tool('status', { text: 'Heads down' });
    seen.push(await ctx.nextMessage(3000));
  };
  const native = new FakeAdapter({ architect: working });
  const restartable = new FakeAdapter({ architect: working }, { harness: 'plain', interrupt: false, injectMidTurn: false });
  for (const [harness, adapter] of [['fake', native], ['plain', restartable]] as const) {
    const d = makeTeam({ roles: { architect: role(harness, 'm') }, adapters: { [harness]: adapter } });
    const goal = d.startGoal({ request: 'r' });
    await withTimeout(
      (async () => {
        while (d.agent(goal, 'architect')?.status !== 'Heads down') await settle();
      })(),
      2000,
      'status',
    );
    d.deliver(goal, 'human', 'architect', 'Stop, the spec changed.', true);
    await withTimeout(
      (async () => {
        while (!d.store.since(goal).some(e => e.type === 'agent.text' && /Got it: Message from human \(urgent\): Stop/.test(String(e.data.text)))) await settle();
      })(),
      3000,
      `${harness}: the message arrives as the next turn`,
    );
    const events = d.store.since(goal);
    assert.equal(events.find(e => e.type === 'agent.interrupted')?.data.how, harness === 'fake' ? 'native' : 'restart');
    assert.ok(events.some(e => e.type === 'message.delivered' && e.data.via === 'interrupt'));
    if (harness === 'plain') {
      assert.equal(restartable.started.length, 2);
      assert.equal(restartable.started[1].resume, events.find(e => e.type === 'agent.session')?.data.nativeSession, 'the same session is resumed');
    }
    await d.close();
  }
  assert.equal(seen[0], '[interrupted]', 'the native interrupt reaches the running turn');
});
