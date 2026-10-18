import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpAdapter, acpToolRequest } from '../src/adapters/acp.ts';
import type { SessionEvents, SessionSpec } from '../src/adapters/types.ts';
import type { Daemon } from '../src/daemon.ts';
import type { MhEvent } from '../src/types.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'fake-acp.mjs');
const role = (model: string) => `---\nharness: opencode\nmodel: ${model}\ngood_at: x\n---\nYou lead.\n`;

function setup(t: TestContext, pause: { graceMs?: number } = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'mh-acp-')), 'acp.log');
  const acp = new AcpAdapter({ id: 'opencode', bin: process.execPath, args: [FIXTURE], env: { FAKE_ACP_LOG: log } });
  const d = makeTeam({ roles: { architect: role('free/fast') }, adapters: { opencode: acp }, pause: { tickMs: 10, settleMs: 0, ...pause } });
  // Closed even when an assertion fails, so no agent process is left running.
  t.after(() => d.close());
  const received = () => readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { d, received };
}

async function until(d: Daemon, goal: string, pred: (e: MhEvent) => boolean, what: string): Promise<MhEvent> {
  return withTimeout(
    (async () => {
      for (;;) {
        const hit = d.store.since(goal).find(pred);
        if (hit) return hit;
        await settle();
      }
    })(),
    5000,
    what,
  );
}

test('ACP: a session with our MCP server, the role\'s model, the git guard, usage; an urgent message pauses it between steps', async t => {
  const { d, received } = setup(t);
  const goal = d.startGoal({ request: 'BRIEF:steps' });
  await until(d, goal, e => e.type === 'agent.tool_call', 'first step');
  d.deliver(goal, 'human', 'architect', 'Stop, change of plan.', true);
  await until(d, goal, e => e.type === 'agent.text' && /Got: .*Stop, change of plan/.test(String(e.data.text)), 'the message as the next prompt');

  const ev = d.store.since(goal);
  const paused = ev.find(e => e.type === 'agent.paused_between_steps')!;
  assert.equal(paused.data.cut, false, 'the running step finished first');
  assert.equal(ev.filter(e => e.type === 'agent.tool_call').length, 1, 'and no further step started');
  assert.deepEqual(ev.filter(e => e.type === 'agent.tool_result').map(e => e.data.ok), [true]);
  assert.ok(ev.some(e => e.type === 'usage' && e.data.costUsd === 0.0123 && e.data.contextPct === 5));
  assert.ok(ev.some(e => e.type === 'usage' && e.data.tokensIn === 1200));

  const r = received();
  assert.match(String(r[0].env.GIT_CONFIG_PARAMETERS), /core\.hooksPath/, 'the git guard reaches the harness');
  const created = r.find(m => m.method === 'session/new').params;
  assert.equal(created.cwd, d.goals.get(goal)!.dir);
  assert.deepEqual(created.mcpServers[0], { type: 'http', name: 'metaharness', url: '', headers: [] });
  assert.deepEqual(created.additionalDirectories, [d.goals.get(goal)!.sharedDir]);
  assert.equal(r.find(m => m.method === 'session/set_config_option').params.value, 'free/fast');
  const prompts = r.filter(m => m.method === 'session/prompt').map(m => m.params.prompt);
  assert.deepEqual(prompts[0][0].annotations, { audience: ['assistant'] }, 'the system prompt goes first, for the assistant');
  assert.match(prompts[0][0].text, /## Your role: architect/);
  assert.ok(r.some(m => m.method === 'session/cancel'));
  assert.match(prompts[1].at(-1).text, /Your turn was paused between steps/);
  assert.equal(prompts[1].length, 1, 'the system prompt only goes with the first prompt');
});

test('ACP: a normal message waits a moment for the harness, then pauses the turn between steps', async t => {
  const { d } = setup(t, { graceMs: 50 });
  const goal = d.startGoal({ request: 'BRIEF:steps' });
  await until(d, goal, e => e.type === 'agent.tool_call', 'first step');
  d.deliver(goal, 'human', 'architect', 'FYI: tests live in test/.');
  await until(d, goal, e => e.type === 'agent.text' && /Got: .*FYI/.test(String(e.data.text)), 'the message as the next prompt');
  const paused = d.store.ofType('agent.paused_between_steps')[0];
  assert.deepEqual([paused.data.urgent, paused.data.cut], [false, false]);
});

test('ACP: waiting messages ride on the output of a command run through MetaHarness', async t => {
  const { d } = setup(t, { graceMs: 5000 });
  const goal = d.startGoal({ request: 'BRIEF:terminal' });
  // Queued before the session is up, so it's waiting when the command finishes.
  d.deliver(goal, 'human', 'architect', 'Heads up: use port 8080.');
  const said = await until(d, goal, e => e.type === 'agent.text' && /^Output: /.test(String(e.data.text)), 'the command output');
  assert.match(String(said.data.text), /^Output: hi\n+\[MetaHarness\] Message from human: Heads up: use port 8080\./);
  assert.ok(d.store.since(goal).some(e => e.type === 'message.delivered' && e.data.via === 'tool_result'));
  assert.equal(d.store.ofType('agent.paused_between_steps').length, 0, 'no pause needed');
});

test('ACP: permission requests go through the approval policy', async t => {
  const { d } = setup(t);
  const goal = d.startGoal({ request: 'BRIEF:permission' });
  const said = await until(d, goal, e => e.type === 'agent.text' && /^push:/.test(String(e.data.text)), 'the answers');
  assert.equal(said.data.text, 'push:reject status:once edit:once', 'push refused, read-only command and an edit in its folder allowed, never "always"');
  assert.ok(d.store.since(goal).some(e => e.type === 'approval.refused' && /git push/.test(String(e.data.detail))));
  // ACP has no room for the reason, so it follows as a notice: the agent's next prompt.
  await until(d, goal, e => e.type === 'agent.text' && /Got: \[MetaHarness\] MetaHarness refused Bash: git push origin main\. Agents commit but don't push/.test(String(e.data.text)), 'the reason');
  assert.equal(d.humanInbox.filter(i => i.kind === 'approval').length, 0, 'nothing needed the human');
});

test('ACP: resuming a session, and a model the harness won\'t run', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'mh-acp-')), 'acp.log');
  const acp = new AcpAdapter({ id: 'opencode', bin: process.execPath, args: [FIXTURE], env: { FAKE_ACP_LOG: log } });
  const noop = () => {};
  const events: SessionEvents = {
    turnStarted: noop, turnEnded: noop, text: noop, toolCall: noop, toolResult: noop, usage: noop, exited: noop, rateLimit: noop,
    approval: async () => ({ allow: false }), decide: async () => ({ allow: false }), pull: () => undefined,
  };
  const dir = mkdtempSync(join(tmpdir(), 'mh-acp-cwd-'));
  const spec = (model: string): SessionSpec => ({
    goal: 'g', agent: 'a', role: { name: 'r' } as SessionSpec['role'], model, systemPrompt: '', brief: '', cwd: dir, sharedDir: dir, gitDirs: [],
    mcpUrl: 'http://127.0.0.1:1/mcp/x', hookUrl: '', agentDir: dir, mcpServers: [], callTool: async () => '',
  });
  const s = await acp.start(spec('free/default'), events, { resume: 'sess-old' });
  assert.equal(s.nativeId, 'sess-old');
  await s.stop();
  const resumed = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(m => m.method === 'session/resume');
  assert.equal(resumed.params.sessionId, 'sess-old');
  await assert.rejects(acp.start(spec('gpt-9000'), events), /won't use model gpt-9000: unknown model gpt-9000\. It offers: free\/default, free\/fast/);
});

test('ACP tool calls as the approval policy sees them', () => {
  assert.equal(acpToolRequest({ title: 'bash', kind: 'execute', rawInput: { command: 'npm test' } }).detail, 'npm test');
  assert.equal(acpToolRequest({ title: 'bash', kind: 'execute', rawInput: { command: 'npm test' } }).kind, 'shell');
  assert.deepEqual(acpToolRequest({ title: 'edit', kind: 'edit', locations: [{ path: '/r/a.ts' }] }), { kind: 'edit', tool: 'edit', detail: '/r/a.ts', path: '/r/a.ts' });
  assert.equal(acpToolRequest({ title: 'read', kind: 'read', rawInput: { filePath: '/r/a.ts' } }).kind, 'read');
  assert.equal(acpToolRequest({ title: 'task', name: 'task', kind: 'other' }).kind, 'delegate');
  assert.equal(acpToolRequest({ title: 'question', name: 'question' }).kind, 'ask_user');
  assert.equal(acpToolRequest({ title: 'webfetch', kind: 'fetch' }).kind, 'other', 'fetching asks');
  // OpenCode's code mode: one execute tool runs code that calls MCP tools.
  const code = (c: string) => acpToolRequest({ title: 'execute', name: 'execute', kind: 'other', rawInput: { code: c } });
  assert.deepEqual([code('return await tools.metaharness.status({ text: "hi" });').kind, code('await tools.metaharness.done({})').server], ['mcp', 'metaharness']);
  assert.deepEqual([code('return tools.blender.render({})').kind, code('return tools.blender.render({})').server], ['mcp', 'blender']);
  assert.equal(code('return await tools.opencode.list_mcp_resources();').kind, 'read');
  assert.equal(code('await tools.opencode.worktree_remove({ name: "x" })').kind, 'mcp', "a server the role doesn't name asks (toolPolicy)");
  assert.equal(code('await tools.a.x(); await tools.b.y()').kind, 'other');
  assert.equal(code('return 1 + 1').kind, 'other');
});
