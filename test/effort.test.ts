import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldEfforts, nearestEffort, splitEffort } from '../src/effort.ts';
import { claudeArgs } from '../src/adapters/claude.ts';
import { AgyAdapter } from '../src/adapters/agy.ts';
import { AcpAdapter } from '../src/adapters/acp.ts';
import { FakeAdapter } from '../src/adapters/fake.ts';
import type { SessionSpec } from '../src/adapters/types.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

test('an effort becomes the nearest level a harness takes', () => {
  assert.equal(nearestEffort('high', ['low', 'medium', 'high']), 'high');
  assert.equal(nearestEffort('max', ['low', 'medium', 'high']), 'high');
  assert.equal(nearestEffort('ultra', ['low', 'medium', 'high', 'xhigh', 'max']), 'max');
  assert.equal(nearestEffort('minimal', ['low', 'high']), 'low');
  assert.equal(nearestEffort('medium', ['low', 'high']), 'low', 'a tie goes to the lower level');
  assert.equal(nearestEffort('high', []), undefined);
  assert.deepEqual(splitEffort('codex/gpt-6-sol@high'), { model: 'codex/gpt-6-sol', effort: 'high' });
  assert.deepEqual(splitEffort('opus'), { model: 'opus' });
});

test("models listed once per effort fold into one model with its efforts", () => {
  const f = foldEfforts(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-opus-5-5-high', 'claude-opus-5-5-low', 'gpt-oss-120b-medium', 'plain']);
  assert.deepEqual(f.models, ['gemini-3.8-flash', 'claude-opus-5-5', 'gpt-oss-120b-medium', 'plain']);
  assert.deepEqual(f.efforts['gemini-3.8-flash'], ['low', 'medium', 'high']);
  assert.deepEqual(f.variants['claude-opus-5-5-low'], { model: 'claude-opus-5-5', effort: 'low' });
  assert.equal(f.variants['gpt-oss-120b-medium'], undefined, 'one effort alone is part of the name');
});

const spec = (model: string, effort?: string): SessionSpec => ({
  goal: 'g', agent: 'a', model, ...(effort ? { effort } : {}), systemPrompt: '', brief: '', cwd: '/repo', sharedDir: '/shared', gitDirs: [], mcpUrl: 'http://x/mcp/t', hookUrl: '', agentDir: '/agent', mcpServers: [],
  role: { name: 'a', harness: 'claude-code', model, fallback: [], goodAt: '', instructions: '', helper: false, allow: [], autoApprove: 'read-only', mcp: [], worktree: false, file: '' },
  callTool: async () => '',
});

test('Claude Code gets --effort, at a level it takes', () => {
  const args = claudeArgs(spec('opus', 'ultra'), 's');
  assert.equal(args[args.indexOf('--effort') + 1], 'max');
  assert.ok(!claudeArgs(spec('opus'), 's').includes('--effort'));
});

test("Antigravity runs the listed variant of a bare model, nearest the effort", async () => {
  const bin = join(mkdtempSync(join(tmpdir(), 'mh-agy-')), 'agy');
  writeFileSync(bin, '#!/bin/sh\nprintf "Fetching available models...\\ngemini-3.8-flash-high\\tGemini (High)\\ngemini-3.8-flash-medium\\tx\\ngemini-3.8-flash-low\\tx\\n"\n');
  chmodSync(bin, 0o755);
  const agy = new AgyAdapter({ bin });
  assert.equal(await agy.modelFor('gemini-3.8-flash', 'xhigh'), 'gemini-3.8-flash-high');
  assert.equal(await agy.modelFor('gemini-3.8-flash'), 'gemini-3.8-flash-medium', 'medium when the role has no effort');
  assert.equal(await agy.modelFor('gemini-3.8-flash-low', 'high'), 'gemini-3.8-flash-low', 'a name with its effort is used as written');
  assert.equal(await agy.modelFor('other', 'high'), 'other');
});

test('a role\'s effort reaches its agent, and a backup can carry its own', async () => {
  const fake = new FakeAdapter({ architect: async ctx => void (await ctx.tool('done', { note: 'ok' })) });
  const d = makeTeam({ roles: { architect: '---\nharness: fake\nmodel: m\neffort: high\nfallback: fake/n@low, fake/o\ngood_at: x\n---\nx\n' }, adapters: { fake } });
  assert.deepEqual(d.routes(d.config.roles.get('architect')!), [
    { harness: 'fake', model: 'm', effort: 'high' },
    { harness: 'fake', model: 'n', effort: 'low' },
    { harness: 'fake', model: 'o', effort: 'high' },
  ]);
  const goal = d.startGoal({ request: 'r' });
  await settle();
  assert.equal(fake.started[0].spec.effort, 'high');
  assert.equal(d.snapshot(goal).goals[0].agents[0].effort, 'high');
  assert.equal(d.store.since(goal).find(e => e.type === 'agent.spawned')!.data.effort, 'high');
  await d.close();
});

test('ACP: the effort goes through the agent\'s thinking-level option', async t => {
  const log = join(mkdtempSync(join(tmpdir(), 'mh-acp-')), 'acp.log');
  const acp = new AcpAdapter({ id: 'opencode', bin: process.execPath, args: [join(import.meta.dirname, 'fixtures', 'fake-acp.mjs')], env: { FAKE_ACP_LOG: log } });
  const d = makeTeam({ roles: { architect: '---\nharness: opencode\nmodel: free/fast\neffort: xhigh\ngood_at: x\n---\nx\n' }, adapters: { opencode: acp } });
  t.after(() => d.close());
  const goal = d.startGoal({ request: 'hello' });
  await withTimeout((async () => { while (!d.store.since(goal).some(e => e.type === 'agent.text')) await settle(); })(), 5000, 'an answer');
  const sets = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(m => m.method === 'session/set_config_option').map(m => m.params);
  assert.deepEqual(sets.map(p => [p.configId, p.value]), [['model', 'free/fast'], ['thought', 'high']]);
});
