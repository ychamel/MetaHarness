import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endTree, spawnTree } from '../src/procs.ts';
import { FakeAdapter, type FakeTurnScript } from '../src/adapters/fake.ts';
import { makeTeam, settle } from './helpers.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts bash with a script that prints the PIDs it leaves behind, one per line, and returns them once `n` are printed. */
async function start(script: string, n: number) {
  const proc = spawnTree('bash', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.setEncoding('utf8');
  await new Promise<void>(res => proc.stdout.on('data', (c: string) => ((out += c), out.trim().split('\n').length >= n && res())));
  return { proc, pids: out.trim().split('\n').map(Number) };
}

async function gone(pids: number[], ms = 4000) {
  const end = Date.now() + ms;
  while (pids.some(alive) && Date.now() < end) await settle();
  return pids.filter(alive);
}

test('ending a harness process ends what it started, in its group or not', { skip: process.platform === 'win32' }, async () => {
  // A background job stays in the group; setsid leaves it. cat waits for stdin, like a CLI.
  const { proc, pids } = await start('sleep 300 & echo $!; setsid sleep 301 & echo $!; cat', 2);
  assert.ok(pids.every(alive));
  endTree(proc, 200);
  assert.deepEqual(await gone([proc.pid!, ...pids]), [], 'nothing is left running');
});

test('a harness that exits by itself takes its leftover children with it', { skip: process.platform === 'win32' }, async () => {
  const { pids } = await start('sleep 300 & echo $!; sleep 0.2; exit 0', 1);
  assert.deepEqual(await gone(pids), []);
});

test('finished agents let their process go after a quiet spell, and resume when messaged', async () => {
  const echo: FakeTurnScript = async (ctx, text) => ctx.say(`Got: ${text}`);
  const adapter = new FakeAdapter({ architect: async ctx => void (await ctx.tool('done', { note: 'built it' })) }, {}, { architect: echo });
  const d = makeTeam({ roles: { architect: '---\nharness: fake\nmodel: m\ngood_at: x\n---\nx\n' }, adapters: { fake: adapter }, releaseMs: 60_000 });
  const goal = d.startGoal({ request: 'r' });
  const rec = () => d.agent(goal, 'architect')!;
  const end = Date.now() + 3000;
  while (rec().state !== 'done' && Date.now() < end) await settle();
  assert.equal(rec().state, 'done');

  d.releaseIdle(Date.now() + 30_000);
  assert.ok(rec().session, 'kept while it was only quiet for a while');
  d.releaseIdle(Date.now() + 61_000);
  assert.equal(rec().session, undefined, 'let go');
  const native = d.store.since(goal).find(e => e.type === 'agent.session')!.data.nativeSession;
  assert.equal(rec().resumeId, native);
  assert.ok(d.store.since(goal).some(e => e.type === 'agent.released'));

  d.deliver(goal, 'human', 'architect', 'One more thing.');
  const back = Date.now() + 3000;
  while (!d.store.since(goal).some(e => e.type === 'agent.text' && /Got: .*One more thing/s.test(String(e.data.text))) && Date.now() < back) await settle();
  assert.equal(adapter.started.at(-1)!.resume, native, 'the same session picked up the message');
  assert.ok(d.store.since(goal).some(e => e.type === 'agent.text' && /One more thing/.test(String(e.data.text))));
  await d.close();
});
