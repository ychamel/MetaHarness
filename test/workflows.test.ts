import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeScript } from '../src/adapters/fake.ts';
import { claudeArgs } from '../src/adapters/claude.ts';
import { isolationConfig, mcpServerConfig } from '../src/adapters/codex.ts';
import { writeAgentConfig } from '../src/adapters/agy.ts';
import type { SessionSpec } from '../src/adapters/types.ts';
import { claudeMcpDef } from '../src/mcpservers.ts';
import { doctorLines } from '../src/doctor.ts';
import { Daemon } from '../src/daemon.ts';
import { makeRepo, settle, withTimeout } from './helpers.ts';

/** A daemon over a config dir with the given files (path → content). */
function team(files: Record<string, string>, scripts: Record<string, FakeScript>) {
  const cfg = mkdtempSync(join(tmpdir(), 'mh-wf-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(cfg, path, '..'), { recursive: true });
    writeFileSync(join(cfg, path), text);
  }
  const fake = new FakeAdapter(scripts);
  const d = new Daemon({ home: mkdtempSync(join(tmpdir(), 'mh-home-')), repo: makeRepo(), dbPath: ':memory:', configDirs: [cfg], adapters: { fake }, pollMs: 0 });
  return { d, fake };
}

const role = (extra = '') => `---\nharness: fake\nmodel: m\n${extra}good_at: things\n---\nDo things.\n`;
const files = {
  'roles/architect.md': role(),
  'roles/designer.md': role('workflow: ui-design\n'),
  'workflows/feature-explore.md': '---\ngood_at: features where the approach is unclear\n---\n1. Explore.\n2. Continue with the `implementation` workflow.\n',
  'workflows/implementation.md': '---\ngood_at: building an approved design\n---\nImplementers in parallel get worktrees.\n',
  'workflows/ui-design.md': '---\ngood_at: UI work\n---\nSketch three layouts first.\n',
  'playbooks/legacy.md': 'An old playbook still works as a workflow.\n',
};

test('workflows: the lead gets its workflow, or the list; roles get theirs; the tool reads the next one', async () => {
  const seen: Record<string, string> = {};
  const { d, fake } = team(files, {
    architect: async ctx => {
      seen.next = await ctx.tool('workflow', { name: 'implementaton' });
      seen.list = await ctx.tool('workflow', {});
      await ctx.tool('spawn', { role: 'designer', brief: 'Design the UI' });
      await ctx.tool('wait', { timeout: 2 });
      await ctx.tool('done', {});
    },
  });
  const goal = d.startGoal({ request: 'Add themes', workflow: 'feature-explore' });
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  const prompt = (agent: string) => fake.started.find(s => s.spec.agent === agent)!.spec.systemPrompt;
  assert.match(prompt('architect'), /## Workflow: feature-explore[\s\S]*Continue with the `implementation` workflow/);
  assert.match(prompt('designer-1'), /## Workflow: ui-design[\s\S]*Sketch three layouts/, "a role's own workflow is in its prompt");
  assert.doesNotMatch(prompt('designer-1'), /feature-explore/);
  assert.match(seen.next, /Took "implementaton" to mean implementation[\s\S]*Implementers in parallel get worktrees/);
  assert.match(seen.list, /- feature-explore: features where the approach is unclear/);
  assert.match(seen.list, /- legacy: —/, 'playbooks still count');
  assert.throws(() => d.startGoal({ request: 'x', workflow: 'nope' }), /no workflow called "nope".*feature-explore/);

  const g2 = d.startGoal({ request: 'Something else' });
  await settle();
  const lead2 = fake.started.filter(s => s.spec.agent === 'architect').at(-1)!.spec.systemPrompt;
  assert.match(lead2, /## Workflows[\s\S]*- implementation: building an approved design/, 'without one, the lead sees the list');
  void g2;
  await d.close();
});

test('decisions: the human approves or sends back, and the answer reaches the agent', async () => {
  const got: (string | null)[] = [];
  const { d } = team(files, {
    architect: async ctx => {
      await ctx.tool('send', { to: 'human', text: 'Approve shared/design.md?', decision: true });
      got.push(await ctx.tool('wait', { timeout: 5 }));
      await ctx.tool('send', { to: 'human', text: 'Approve v2?', decision: true });
      got.push(await ctx.tool('wait', { timeout: 5 }));
      await ctx.tool('done', {});
    },
  });
  const goal = d.startGoal({ request: 'r' });
  const next = async () => {
    let item;
    while (!(item = d.humanInbox.find(i => i.kind === 'decision'))) await settle();
    return item;
  };
  const first = await withTimeout(next(), 3000, 'first decision');
  assert.equal(first.text, 'Approve shared/design.md?');
  assert.equal(d.resolveInbox(first.id, 'deny', 'Use CSS variables'), 'Sent back for architect.');
  const second = await withTimeout(next(), 3000, 'second decision');
  d.resolveInbox(second.id, 'approve', 'Ship it');
  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'lead done');
  assert.match(got[0]!, /Not approved\. What to change: Use CSS variables/);
  assert.match(got[1]!, /Approved\. Ship it/);
  await d.close();
});

test('role MCP servers reach each harness by name', () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-claude-home-'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { blender: { type: 'http', url: 'http://127.0.0.1:9191/' } } }));
  assert.deepEqual(claudeMcpDef('blender', '/somewhere', home), { type: 'http', url: 'http://127.0.0.1:9191/' });

  const spec = {
    agent: 'modeler', model: 'opus', systemPrompt: 'p', brief: 'b', cwd: '/repo', sharedDir: '/s', gitDirs: [], mcpUrl: 'http://127.0.0.1:7777/mcp/t', hookUrl: 'http://127.0.0.1:7777/hook/t',
    agentDir: mkdtempSync(join(tmpdir(), 'mh-agent-')),
    role: { name: 'modeler', harness: 'claude-code', model: 'opus', fallback: [], goodAt: '', instructions: '', helper: false, allow: [], autoApprove: 'read-only', mcp: ['figma', 'not-configured-anywhere'], worktree: false, file: '' },
    mcpServers: [{ name: 'figma', def: { command: 'figma-mcp', args: ['--stdio'] } }, { name: 'not-configured-anywhere' }],
  } as unknown as SessionSpec;
  const args = claudeArgs(spec, 'id');
  const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers;
  assert.deepEqual(Object.keys(cfg), ['metaharness', 'figma'], 'a name with no definition anywhere is left out');
  assert.ok(args.includes('mcp__figma'), 'its tools run without asking');

  assert.equal(isolationConfig(['blender', 'other'], ['blender'])['mcp_servers.blender.enabled'], undefined, "Codex keeps the role's own servers");
  assert.equal(isolationConfig(['blender', 'other'], ['blender'])['mcp_servers.other.enabled'], false, 'and turns off the rest');
  assert.deepEqual(mcpServerConfig(spec.mcpServers), { 'mcp_servers.figma.command': 'figma-mcp', 'mcp_servers.figma.args': ['--stdio'] });

  writeAgentConfig(spec, '/hook.ts');
  const agy = JSON.parse(readFileSync(join(spec.agentDir, '.agents', 'mcp_config.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(agy), ['metaharness', 'figma']);
});

test('mh doctor says which MCP names resolve on this machine', () => {
  const report = { id: 'codex', title: 'Codex', transport: 'codex-app-server' as const, path: '/bin/codex', version: '1', login: { signedIn: true, detail: '' }, models: ['m'], mcpNames: ['blender'] };
  const r = { name: 'modeler', harness: 'codex', model: 'm', fallback: [], goodAt: '', instructions: '', helper: false, allow: [], autoApprove: 'read-only' as const, mcp: ['blender', 'figma', 'local'], worktree: false, file: '/x/modeler.md' };
  const lines = doctorLines([report], [r], new Map([['local', {}]])).join('\n');
  assert.match(lines, /✓ mcp blender\s+from Codex's own config/);
  assert.match(lines, /✓ mcp local\s+from mcp\.json/);
  assert.match(lines, /✗ mcp figma\s+not configured here/);
});
