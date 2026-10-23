import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/server.ts';
import { resolveName } from '../src/fuzzy.ts';
import { makeDaemon, settle, withTimeout } from './helpers.ts';

test('a small scripted team completes the milestone-0 scenario', async () => {
  const d = makeDaemon();
  const goal = d.startGoal({ request: 'Add per-user rate limiting to /api/upload', playbook: 'feature' });
  const note = await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  await settle();
  assert.match(note, /implementer-1 finished part B/);

  const g = d.goals.get(goal)!;
  assert.deepEqual([...g.agents.keys()].sort(), ['architect', 'implementer-1', 'scout-1']);
  for (const a of g.agents.values()) assert.equal(a.state, 'done', `${a.name} should be done`);
  assert.equal(g.agents.get('scout-1')!.parent, 'implementer-1');
  assert.equal(g.agents.get('scout-1')!.quick, true);
  assert.equal(g.agents.get('scout-1')!.cwd, g.agents.get('implementer-1')!.cwd, "a quick helper works in its caller's worktree");

  const events = d.store.since(goal);
  const delivered = events.filter(e => e.type === 'message.delivered');
  assert.ok(
    delivered.some(e => e.agent === 'architect' && e.data.from === 'implementer-1' && e.data.via === 'wait'),
    "the implementer's question reaches the architect through wait()",
  );
  assert.ok(
    delivered.some(e => e.agent === 'implementer-1' && e.data.from === 'architect' && e.data.via === 'inject'),
    "the architect's answer is injected into the implementer's running turn",
  );
  const implText = events.filter(e => e.agent === 'implementer-1' && e.type === 'agent.text').map(e => String(e.data.text));
  assert.ok(implText.some(t => t.includes('Async. I updated design.md')), 'the implementer saw the answer');
  assert.ok(implText.some(t => t.includes('router.use')), "the quick helper's answer came back inline");

  assert.ok(existsSync(join(g.sharedDir, 'design.md')));
  assert.match(readFileSync(join(g.sharedDir, 'notes', 'implementer-1.md'), 'utf8'), /async/);
  assert.equal(d.humanInbox.filter(i => i.kind === 'done').length, 1, 'only the lead reports to the human');
  assert.ok((g.agents.get('architect')!.cost ?? 0) > 0, 'usage is tracked');
  await d.close();
});

test('tools forgive small mistakes and explain the rest', async () => {
  const replies: Record<string, string> = {};
  const d = makeDaemon({
    architect: async ctx => {
      replies.typoRole = await ctx.tool('spawn', { role: 'implementr', brief: 'Do part A' });
      replies.unknownRole = await ctx.tool('spawn', { role: 'astronaut', brief: 'x' });
      replies.unknownPerson = await ctx.tool('send', { to: 'bob', text: 'hello' });
      replies.noText = await ctx.tool('send', { to: 'implementer-1' });
      replies.altKeys = await ctx.tool('send', { recipient: 'implementer', message: 'by role, with other key names' });
      replies.typoTool = await ctx.tool('sned', { to: 'implementer-1', text: 'typo in the tool name' });
      replies.wait0 = await ctx.tool('wait', { timeout: 0 });
      replies.team = await ctx.tool('team', 'please');
      replies.held = await ctx.tool('done', {});
      replies.waited = await ctx.tool('wait', { timeout: 5 });
      replies.done = await ctx.tool('done', {});
    },
    implementer: async ctx => {
      await ctx.nextMessage(2000);
      await ctx.tool('done', { note: 'ok' });
    },
  });
  const goal = d.startGoal({ request: 'Check leniency' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');

  assert.match(replies.typoRole, /Took "implementr" to mean implementer/);
  assert.match(replies.typoRole, /Started implementer-1/);
  assert.match(replies.unknownRole, /no role called "astronaut".*Roles you can spawn/);
  assert.match(replies.unknownPerson, /nobody called "bob".*implementer-1/);
  assert.match(replies.noText, /needs some text/);
  assert.match(replies.altKeys, /Sent to implementer-1/);
  assert.match(replies.typoTool, /Used send for "sned"/);
  assert.equal(replies.wait0, 'Nothing new.');
  assert.match(replies.team, /Roles you can spawn/);
  // Its result isn't whole while a teammate it spawned still works: done is held, and it decides.
  assert.match(replies.held, /Not done yet.*\n- implementer-1 \(implementer\): /);
  assert.match(replies.held, /wait for their results/);
  assert.match(replies.waited, /implementer-1.*ok/s);
  await settle();
  assert.match(replies.done, /^Done\. The human has your note/);
  assert.equal(d.store.ofType('agent.done_held').length, 1);
  await d.close();
});

test('an agent that stops without calling done still reports back', async () => {
  const d = makeDaemon({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Do something' });
      const w = await ctx.tool('wait', { timeout: 5 });
      await ctx.tool('done', { note: w });
    },
    implementer: async ctx => {
      ctx.say('I wrote the code but forgot to call done.');
    },
  });
  const goal = d.startGoal({ request: 'Forgetful teammate' });
  const note = await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  assert.match(note, /implementer-1 stopped without calling done.*forgot to call done/);
  await d.close();
});

test('a slow quick helper hands control back and answers later', async () => {
  const d = makeDaemon(
    {
      architect: async ctx => {
        const first = await ctx.tool('spawn', { role: 'scout', brief: 'Slow lookup', quick: true });
        const later = await ctx.tool('wait', { timeout: 5 });
        await ctx.tool('done', { note: `${first} || ${later}` });
      },
      scout: async ctx => {
        await ctx.sleep(300);
        await ctx.tool('done', { note: 'the slow answer' });
      },
    },
    { quickTimeoutMs: 100 },
  );
  const goal = d.startGoal({ request: 'Slow helper' });
  const note = await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  assert.match(note, /scout-1 is still working/);
  assert.match(note, /scout-1: the slow answer/);
  await d.close();
});

test('the human can message a finished agent, which resumes to answer', async () => {
  const d = makeDaemon();
  const goal = d.startGoal({ request: 'Resume test' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  await settle();
  const r = await d.command({ cmd: 'agent.message', goal, to: 'impl', text: 'Did you add tests?' });
  assert.match(String(r.result), /Took "impl" to mean implementer-1/);
  await settle();
  const ev = d.store.since(goal);
  assert.ok(ev.some(e => e.type === 'message.delivered' && e.agent === 'implementer-1' && e.data.via === 'resume'));
  assert.ok(ev.some(e => e.type === 'agent.text' && e.agent === 'implementer-1' && String(e.data.text).includes('Did you add tests?')));
  assert.equal(d.agent(goal, 'implementer-1')!.state, 'done', 'back to done after answering');
  await d.close();
});

test('client API: token required, state and event replay', async () => {
  const d = makeDaemon();
  const server = await startServer(d, 0, 'secret');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/state`)).status, 401);
    const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    const started = await (await fetch(`${base}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ cmd: 'goal.start', request: 'API test' }) })).json();
    await withTimeout(d.goals.get(started.goal)!.leadDone, 5000, 'lead done');
    const state = await (await fetch(`${base}/state`, { headers: auth })).json();
    assert.equal(state.goals[0].agents.length, 3);
    const bad = await fetch(`${base}/commands`, { method: 'POST', headers: auth, body: JSON.stringify({ cmd: 'nope' }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Unknown command/);

    const ctrl = new AbortController();
    const res = await fetch(`${base}/events?goal=${started.goal}&since=0`, { headers: auth, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('"agent.done"')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /^id: \d+\ndata: \{"seq":/);
    ctrl.abort();
  } finally {
    server.close();
    await d.close();
  }
});

test('resolveName', () => {
  assert.deepEqual(resolveName('Reviewer', ['reviewer', 'scout']), { match: 'reviewer', guessed: false, suggestions: [] });
  assert.equal(resolveName('rev', ['reviewer', 'scout']).match, 'reviewer');
  assert.equal(resolveName('reviwer', ['reviewer', 'scout']).match, 'reviewer');
  assert.equal(resolveName('xyz', ['reviewer', 'scout']).match, undefined);
});
