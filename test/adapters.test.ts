import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeArgs } from '../src/adapters/claude.ts';
import { isolationConfig } from '../src/adapters/codex.ts';
import type { SessionSpec } from '../src/adapters/types.ts';

const spec: SessionSpec = {
  goal: 'g', agent: 'architect', model: 'opus', systemPrompt: 'prompt', brief: 'brief', cwd: '/repo', sharedDir: '/shared',
  mcpUrl: 'http://127.0.0.1:7777/mcp/abc',
  role: { name: 'architect', harness: 'claude-code', model: 'opus', goodAt: '', instructions: '', helper: false, allow: ['Bash(npm test*)'], file: '' },
  callTool: async () => '',
};

test('Claude Code gets only MetaHarness tools, no user settings, and no native subagents', () => {
  const args = claudeArgs(spec, 'session-1');
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(after('--setting-sources'), 'project,local');
  assert.equal(after('--disallowedTools'), 'Agent');
  assert.equal(after('--permission-prompt-tool'), 'mcp__metaharness__approval');
  assert.deepEqual(JSON.parse(after('--mcp-config')), { mcpServers: { metaharness: { type: 'http', url: spec.mcpUrl } } });
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--model'));
  assert.deepEqual(allowed, ['mcp__metaharness', 'Bash(npm test*)']);
});

test("Codex threads turn off the user's MCP servers, plugins and apps, but keep ours", () => {
  const cfg = isolationConfig(['blender', 'metaharness', 'weird name']);
  assert.equal(cfg['mcp_servers.blender.enabled'], false);
  assert.equal(cfg['mcp_servers.metaharness.enabled'], undefined);
  assert.equal(cfg['mcp_servers.weird name.enabled'], undefined, 'names that would break the dotted path are skipped');
  for (const f of ['plugins', 'apps', 'remote_plugin', 'skill_search', 'tool_suggest']) assert.equal(cfg[`features.${f}`], false);
});
