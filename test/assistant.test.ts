import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeAdapter, type FakeCtx } from '../src/adapters/fake.ts';
import { assistantDecision } from '../src/assistant.ts';
import { ASSISTANT, ASSISTANT_STREAM } from '../src/daemon.ts';
import { startServer } from '../src/server.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const role = (extra = '') => `---\nharness: fake\nmodel: m\n${extra}good_at: x\n---\nx\n`;

/** A scripted assistant that answers by calling its MetaHarness tools over MCP, as a real one would. */
async function answer(ctx: FakeCtx, question: string) {
  const c = new Client({ name: 'assistant', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(ctx.spec.mcpUrl)));
  const call = async (name: string, args: Record<string, unknown> = {}) => ((await c.callTool({ name, arguments: args })) as any).content[0].text as string;
  if (/who did/i.test(question)) {
    const goals = JSON.parse(await call('goals'));
    const lines = await call('events', { goal: goals[0].id, search: 'finished' });
    ctx.say(`Goal ${goals[0].id}: ${lines.split('\n').length} matching lines.\n${lines}`);
  } else if (/cheaper/i.test(question)) {
    const cfg = JSON.parse(await call('config'));
    ctx.say(`Roles I can see: ${cfg.roles.map((r: { name: string }) => r.name).join(', ')}; built in: ${cfg.builtInRoles.join(', ')}.`);
    ctx.say(await call('propose', { summary: 'Run the implementer on m2, which is cheaper', command: 'role.update', args: { name: 'implementer', changes: { model: 'm2' } } }));
    ctx.say(await call('propose', { summary: 'Start a goal', command: 'goal.start', args: { request: 'x' } }));
  }
  await c.close();
}

test('the assistant answers from its read-only tools, and changes the setup only when the human applies its proposal', async () => {
  const fake = new FakeAdapter(
    { assistant: ctx => answer(ctx, ctx.spec.brief), implementer: async ctx => void (await ctx.tool('done', { note: 'finished the parser' })), architect: async ctx => void (await ctx.tool('spawn', { role: 'implementer', brief: 'b' })) },
    {},
    { assistant: answer },
  );
  const d = makeTeam({ roles: { architect: role(), implementer: role(), assistant: role('helper: true\n') }, adapters: { fake } });
  const server = await startServer(d, 0, 'secret');
  const goal = d.startGoal({ request: 'Write a parser' });
  const stream = () => d.store.since(ASSISTANT_STREAM);
  const waitFor = (what: string, ok: () => boolean) =>
    withTimeout(
      (async () => {
        while (!ok()) await settle();
      })(),
      4000,
      what,
    );
  await waitFor('the implementer', () => d.agent(goal, 'implementer-1')?.doneNote !== undefined);

  const conv = d.assistant.conv;
  d.assistant.ask('Who did the work?', `goal ${goal}`);
  await waitFor('an answer', () => stream().some(e => e.type === 'assistant.text'));
  const said = stream().find(e => e.type === 'assistant.text')!.data.text as string;
  assert.match(said, new RegExp(`Goal ${goal}`));
  assert.match(said, /implementer-1 .*finished the parser/);
  assert.deepEqual(stream().filter(e => e.type === 'assistant.tool').map(e => e.data.tool), ['goals', 'events']);
  assert.match(stream().find(e => e.type === 'assistant.asked')!.data.text as string, /Who did the work/);
  assert.ok(stream().every(e => e.data.conv === conv));

  // A change is only proposed; the human applies it. Anything but setup can't be proposed.
  d.assistant.ask('Make it cheaper');
  await waitFor('a proposal', () => stream().filter(e => e.type === 'assistant.text').length >= 4);
  const texts = stream().filter(e => e.type === 'assistant.text').map(e => String(e.data.text));
  assert.match(texts[1], /Roles I can see: architect, assistant, cartographer, illustrator, implementer, prototyper, researcher, writer; built in: gatekeeper/);
  assert.match(texts[3], /can't propose goal.start/);
  const p = stream().find(e => e.type === 'assistant.proposal')!;
  assert.equal(p.data.summary, 'Run the implementer on m2, which is cheaper');
  const file = d.config.roles.get('implementer')!.file;
  assert.match(readFileSync(file, 'utf8'), /model: m\n/, 'not applied yet');
  await d.command({ cmd: 'assistant.apply', id: p.data.id });
  assert.match(readFileSync(file, 'utf8'), /model: m2\n/);
  assert.match(readFileSync(file, 'utf8'), /good_at: x/, 'the rest of the role is kept');
  await assert.rejects(d.command({ cmd: 'assistant.apply', id: p.data.id }), /already applied/);

  // A new conversation starts fresh; the assistant isn't a role teams can spawn, and only reads.
  await d.command({ cmd: 'assistant.reset' });
  assert.notEqual(d.assistant.conv, conv);
  assert.equal(fake.started.filter(s => s.spec.role.name === 'assistant').length, 1);
  assert.equal(d.spawnAgent(goal, { role: 'assistant', brief: 'b', parent: 'architect' }).ok, false);
  assert.equal(assistantDecision({ kind: 'shell', tool: 'Bash', detail: 'git log --oneline | head' }).allow, true);
  assert.equal(assistantDecision({ kind: 'shell', tool: 'Bash', detail: 'rm -rf src' }).allow, false);
  assert.equal(assistantDecision({ kind: 'edit', tool: 'Edit', detail: 'a.ts', path: join(d.project().dir, 'a.ts') }).allow, false);
  await d.close();
  server.close();
});

test('the panel switches the assistant to another model and effort, keeping the conversation, and turns write mode on and off', async () => {
  const heard = (ctx: FakeCtx, text: string) => void ctx.say(`heard: ${text.split('\n').at(-1)}`);
  const fake = new FakeAdapter({ assistant: async ctx => heard(ctx, ctx.spec.brief) }, {}, { assistant: async (ctx, text) => heard(ctx, text) });
  const d = makeTeam({ roles: { assistant: role('helper: true\n') }, adapters: { fake } });
  const texts = () => d.store.since(ASSISTANT_STREAM).filter(e => e.type === 'assistant.text').map(e => String(e.data.text));
  const answered = (n: number) =>
    withTimeout(
      (async () => {
        while (texts().length < n || d.assistant.busy()) await settle();
      })(),
      4000,
      `answer ${n}`,
    );
  const started = () => fake.started.filter(s => s.spec.role.name === 'assistant');

  d.assistant.ask('first');
  await answered(1);
  assert.equal(started()[0].spec.model, 'm');
  await assert.rejects(d.command({ cmd: 'assistant.set', harness: 'nowhere', model: 'x' }), /can't run nowhere/);

  await d.command({ cmd: 'assistant.set', harness: 'fake', model: 'm2', effort: 'high' });
  d.assistant.ask('second');
  await answered(2);
  assert.equal(started().length, 2, 'a new model is a new session');
  const next = started()[1].spec;
  assert.equal(next.model, 'm2');
  assert.equal(next.effort, 'high');
  assert.match(next.brief, /taking over this conversation[\s\S]*The human: first[\s\S]*You: heard: first[\s\S]*---\n\nsecond$/);
  assert.equal(((await d.command({ cmd: 'assistant.state' })) as any).route.model, 'm2');

  // Made the default: its role file takes the pick, and the session carries on.
  await d.command({ cmd: 'assistant.make_default' });
  const file = d.config.roles.get('assistant')!.file;
  assert.match(readFileSync(file, 'utf8'), /model: m2\n[\s\S]*effort: high\n|effort: high\n[\s\S]*model: m2\n/);
  assert.deepEqual(d.assistant.choice, { write: false });
  assert.equal(((await d.command({ cmd: 'assistant.state' })) as any).route.model, 'm2');
  await assert.rejects(d.command({ cmd: 'assistant.make_default' }), /already runs on its role's/);
  await d.command({ cmd: 'assistant.set', harness: 'fake', model: 'm2', effort: 'high' });

  // Write mode: it hears so once, and its harness's tools may change things.
  const edit = { kind: 'edit', tool: 'Edit', detail: 'a.ts', path: join(d.project().dir, 'a.ts') } as const;
  assert.equal(d.outsiderDecision(ASSISTANT, edit).allow, false);
  await d.command({ cmd: 'assistant.set', write: true });
  assert.equal(d.outsiderDecision(ASSISTANT, edit).allow, true);
  assert.equal(assistantDecision({ kind: 'delegate', tool: 'Task', detail: 'x' }, true).allow, false);
  d.assistant.ask('third');
  await answered(3);
  assert.equal(started().length, 2, 'write mode keeps the session');
  assert.ok(d.store.since(ASSISTANT_STREAM).some(e => e.type === 'assistant.settings' && e.data.write === true));

  // A new conversation goes back to reading, on the model picked.
  await d.command({ cmd: 'assistant.reset' });
  assert.deepEqual(d.assistant.choice, { harness: 'fake', model: 'm2', effort: 'high', write: false });
  await d.command({ cmd: 'assistant.set', model: '', effort: '' });
  assert.deepEqual(d.assistant.choice, { write: false });
  await d.close();
});

test('making a pick the default writes the built-in assistant out first, with its instructions', async () => {
  const d = makeTeam({ roles: { architect: role() }, adapters: { fake: new FakeAdapter({}) } });
  d.assistant.set({ harness: 'claude-code', model: 'haiku', effort: 'low' });
  const r = (await d.command({ cmd: 'assistant.make_default' })) as { file: string };
  const text = readFileSync(r.file, 'utf8');
  assert.match(text, /harness: claude-code\n/);
  assert.match(text, /model: haiku\n/);
  assert.match(text, /effort: low\n/);
  // The old primary's harness stays with backups named by model alone; the new model isn't its own backup.
  assert.match(text, /fallback: antigravity\/gemini-3.8-flash-high\n/);
  assert.match(text, /You're the assistant in MetaHarness's web app/);
  assert.match(r.file, /mh-config-/, 'in the first config folder (personal, when there is one)');
  assert.equal(d.config.roles.get('assistant')!.model, 'haiku');
  await d.close();
});
