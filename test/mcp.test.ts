import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Daemon } from '../src/daemon.ts';
import { FakeAdapter } from '../src/adapters/fake.ts';
import { claudeToolRequest } from '../src/adapters/claude.ts';
import type { HarnessAdapter, SessionSpec } from '../src/adapters/types.ts';
import { startServer } from '../src/server.ts';
import { makeRepo } from './helpers.ts';

const configDir = join(import.meta.dirname, '..', '.metaharness');

/** Records the MCP URL each agent is given, and keeps the agent alive until released. */
function capturingAdapter(urls: Map<string, string>, release: Promise<void>): HarnessAdapter {
  const inner = new FakeAdapter({
    '*': async ctx => {
      await release;
      await ctx.tool('done', { note: 'released' });
    },
  });
  return {
    manifest: inner.manifest,
    // Claude Code's permission prompt is what calls the approval tool.
    toolRequest: claudeToolRequest,
    start: (spec: SessionSpec, ev) => {
      urls.set(spec.agent, spec.mcpUrl);
      return inner.start(spec, ev);
    },
  };
}

test('agents reach their tools over MCP, each under its own identity', async () => {
  const urls = new Map<string, string>();
  let release!: () => void;
  const released = new Promise<void>(r => (release = r));
  const d = new Daemon({
    home: mkdtempSync(join(tmpdir(), 'mh-mcp-')),
    repo: makeRepo(),
    dbPath: ':memory:',
    configDirs: [configDir],
    adapters: { fake: capturingAdapter(urls, released) },
    harnessOverride: 'fake',
    pollMs: 0,
  });
  const server = await startServer(d, 0, 'secret');
  const clients: Client[] = [];
  try {
    const goal = d.startGoal({ request: 'MCP test' });
    d.spawnAgent(goal, { role: 'implementer', brief: 'stand by', parent: 'architect' });
    await new Promise(r => setTimeout(r, 30));

    const connect = async (agent: string) => {
      const url = urls.get(agent);
      assert.ok(url?.includes('/mcp/'), `${agent} got an MCP URL`);
      const c = new Client({ name: 'test', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(url!)));
      clients.push(c);
      return c;
    };
    const arch = await connect('architect');
    const impl = await connect('implementer-1');
    const text = (r: any) => r.content.map((c: { text: string }) => c.text).join('');

    const tools = (await arch.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(tools, ['approval', 'done', 'send', 'spawn', 'status', 'team', 'wait', 'workflow']);

    assert.match(text(await arch.callTool({ name: 'team', arguments: {} })), /implementer-1 \(implementer/);
    // Alias keys survive the MCP layer and reach the lenient hub.
    assert.match(text(await arch.callTool({ name: 'send', arguments: { recipient: 'implementer-1', message: 'hello over MCP' } })), /Sent to implementer-1/);
    const got = text(await impl.callTool({ name: 'wait', arguments: { timeout: '0' } }));
    // The fake session has the message injected (it is busy), so wait finds the inbox empty or the message.
    assert.ok(got === 'Nothing new.' || got.includes('hello over MCP'));
    assert.ok(d.store.since(goal).some(e => e.type === 'message.delivered' && e.agent === 'implementer-1'));

    // The approval tool parks the request in the human Inbox until it's answered.
    // The whole command reaches the human, however long, and the agent's status line is left alone.
    await impl.callTool({ name: 'status', arguments: { text: 'Running the tests' } });
    const longCommand = `npm install left-pad && ${'echo filler && '.repeat(40)}rm -rf ./dist  # END-OF-COMMAND`;
    const pending = impl.callTool({ name: 'approval', arguments: { tool_name: 'Bash', input: { command: longCommand } } });
    await new Promise(r => setTimeout(r, 50));
    const item = d.humanInbox.find(i => i.kind === 'approval');
    assert.ok(item, 'approval request reached the Inbox');
    assert.equal(item!.text, `Bash: ${longCommand}`);
    const waiting = d.snapshot(goal).goals[0].agents.find(a => a.name === 'implementer-1')!;
    assert.equal(waiting.awaitingApproval, 1);
    assert.equal(waiting.status, 'Running the tests');
    assert.match(d.resolveInbox(item!.id, 'deny', 'Not now'), /Denied/);
    assert.deepEqual(JSON.parse(text(await pending)), { behavior: 'deny', message: 'Not now' });
    const after = d.snapshot(goal).goals[0].agents.find(a => a.name === 'implementer-1')!;
    assert.equal(after.awaitingApproval, 0);
    assert.equal(after.status, 'Running the tests');

    // Reads anywhere, and the role's commands, pass the policy without reaching the human.
    assert.deepEqual(JSON.parse(text(await impl.callTool({ name: 'approval', arguments: { tool_name: 'Read', input: { file_path: '/tmp/shot.png' } } }))), {
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/shot.png' },
    });
    assert.ok(!d.humanInbox.some(i => i.kind === 'approval'));
    const agentTool = JSON.parse(text(await impl.callTool({ name: 'approval', arguments: { tool_name: 'Agent', input: { prompt: 'x' } } })));
    assert.equal(agentTool.behavior, 'deny');
    assert.match(agentTool.message, /spawn tool/);

    const bad = await fetch(`${d.mcpBase}/mcp/deadbeef`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 404);
  } finally {
    release();
    for (const c of clients) await c.close();
    server.close();
    await d.close();
  }
});
