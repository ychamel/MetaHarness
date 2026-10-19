import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeArgs, claudeUsage, claudeWindow, parseReset, rateLimitInfo } from '../src/adapters/claude.ts';
import { codexRateLimit, isolationConfig } from '../src/adapters/codex.ts';
import { BUILTIN_PROFILES, findBin, inspect, profileFromFile } from '../src/harnesses.ts';
import type { SessionSpec } from '../src/adapters/types.ts';

const spec: SessionSpec = {
  goal: 'g', agent: 'architect', model: 'opus', systemPrompt: 'prompt', brief: 'brief', cwd: '/repo', sharedDir: '/shared', gitDirs: [],
  mcpUrl: 'http://127.0.0.1:7777/mcp/abc', hookUrl: '', agentDir: '/agent', mcpServers: [],
  role: { name: 'architect', harness: 'claude-code', model: 'opus', fallback: [], goodAt: '', instructions: '', helper: false, allow: ['Bash(npm test*)'], autoApprove: 'read-only', mcp: [], worktree: false, file: '' },
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

test('Claude Code resumes under the same session ID', () => {
  const args = claudeArgs(spec, 'session-1', true);
  assert.equal(args[args.indexOf('--resume') + 1], 'session-1');
  assert.ok(!args.includes('--session-id'));
});

test('rate-limit reports from Claude Code and Codex become one shape', () => {
  assert.deepEqual(rateLimitInfo({ status: 'allowed_warning', utilization: 0.912, resetsAt: 1_800_000_000, rateLimitType: 'five_hour' }), {
    status: 'warning', usedPct: 91, resetsAt: 1_800_000_000_000, window: '5h',
  });
  assert.equal(rateLimitInfo({ status: 'rejected' })?.status, 'limited');
  assert.equal(rateLimitInfo({ status: 'allowed' })?.status, 'ok');
  assert.equal(rateLimitInfo(undefined), undefined);
  // An allowed turn gives no utilization of its own, only every window's.
  assert.deepEqual(
    rateLimitInfo({
      status: 'allowed', resetsAt: 1_792_459_800, rateLimitType: 'five_hour',
      unifiedWindows: { five_hour: { utilization: 0.54, resetsAt: 1_792_459_800 }, seven_day: { utilization: 0.69, resetsAt: 1_792_728_000 } },
    }),
    {
      status: 'ok', usedPct: 69, resetsAt: 1_792_728_000_000, window: '7d',
      windows: [{ name: '5h', usedPct: 54, resetsAt: 1_792_459_800_000 }, { name: '7d', usedPct: 69, resetsAt: 1_792_728_000_000 }],
    },
  );

  const snap = {
    primary: { usedPercent: 40, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    secondary: { usedPercent: 85, resetsAt: 1_800_500_000, windowDurationMins: 10080 },
  };
  assert.deepEqual(codexRateLimit(snap), {
    status: 'ok', usedPct: 85, resetsAt: 1_800_500_000_000, window: '7d',
    windows: [{ name: '5h', usedPct: 40, resetsAt: 1_800_000_000_000 }, { name: '7d', usedPct: 85, resetsAt: 1_800_500_000_000 }],
  });
  assert.equal(codexRateLimit({ ...snap, rateLimitReachedType: 'rate_limit_reached' })?.status, 'limited');
  assert.equal(codexRateLimit({}), undefined, 'a sparse update with nothing in it says nothing');
  // Past 100% Codex runs on credits: a warning, not a refusal.
  const over = codexRateLimit({ primary: { usedPercent: 100, windowDurationMins: 300 }, credits: { hasCredits: true, unlimited: false, balance: '12.50' } });
  assert.equal(over?.status, 'warning');
  assert.match(over?.note ?? '', /running on credits \(balance 12\.50\)/);
});

test("Claude Code's /usage text becomes windows with reset times", () => {
  const now = Date.parse('2026-10-18T10:00:00Z');
  const text = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 37% used · resets Oct 19, 2:20am (Asia/Tokyo)',
    'Current week (all models): 57% used · resets Oct 23, 7am (Asia/Tokyo)',
    'Current week (Sonnet only): 100% used · resets Oct 23, 7am (Asia/Tokyo)',
    '',
    "What's contributing to your limits usage?",
    'Last 24h · 1403 requests · 28 sessions',
  ].join('\n');
  assert.deepEqual(claudeUsage(text, now), {
    status: 'limited', usedPct: 100, resetsAt: Date.parse('2026-10-22T22:00:00Z'), window: '7d sonnet',
    windows: [
      { name: '5h', usedPct: 37, resetsAt: Date.parse('2026-10-18T17:20:00Z') },
      { name: '7d', usedPct: 57, resetsAt: Date.parse('2026-10-22T22:00:00Z') },
      { name: '7d sonnet', usedPct: 100, resetsAt: Date.parse('2026-10-22T22:00:00Z') },
    ],
  });
  assert.equal(claudeUsage('You are using an API key.'), undefined, 'an API key has no plan windows');
  assert.equal(parseReset('Jan 2, 9am (UTC)', Date.parse('2026-12-30T12:00:00Z')), Date.parse('2027-01-02T09:00:00Z'), 'into next year');
  assert.equal(parseReset('3pm (UTC)', Date.parse('2026-10-18T16:00:00Z')), Date.parse('2026-10-19T15:00:00Z'), 'a time already past today is tomorrow');
  assert.equal(parseReset('12:30am (Nowhere/Zone)', Date.UTC(2026, 9, 18, 12)) !== undefined, true, 'an unknown zone falls back to the machine');
  assert.equal(claudeWindow('seven_day_opus'), '7d opus');
  assert.equal(claudeWindow('five_hour'), '5h');
});

test('a user profile can put a known transport on another binary and provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-bin-'));
  const bin = join(dir, 'fakeclaude');
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9 (Fake)"; exit 0; fi\nif [ "$1" = "models" ]; then printf "glm-5.1  GLM 5.1\\nglm-5-air  GLM 5 Air\\n"; exit 0; fi\nexit 3\n');
  chmodSync(bin, 0o755);
  const p = profileFromFile(
    '/x/harnesses/glm.md',
    `---\ntitle: Claude Code on GLM\nbin: ${bin}\ntransport: claude-stream\nenv: ANTHROPIC_BASE_URL=https://example.test/anthropic, API_TIMEOUT_MS=60000\nmodels_cmd: ${bin} models\nstatus_cmd: ${bin} status\n---\nNotes.\n`,
  );
  assert.equal(p.transport, 'claude-stream');
  assert.deepEqual(p.env, { ANTHROPIC_BASE_URL: 'https://example.test/anthropic', API_TIMEOUT_MS: '60000' });
  const r = await inspect(p);
  assert.equal(r.version, '9.9.9');
  assert.deepEqual(r.models, ['glm-5.1', 'glm-5-air']);
  assert.equal(r.login?.signedIn, false, 'status_cmd exiting non-zero means signed out');

  const unknown = profileFromFile('/x/harnesses/claude-code.md', '---\ntransport: telepathy\n---\n', BUILTIN_PROFILES[0]);
  assert.equal(unknown.transport, undefined, "a transport MetaHarness doesn't have isn't guessed at");
  assert.equal(unknown.bin, 'claude', 'what the file leaves out comes from the built-in profile');
  assert.equal(findBin('definitely-not-a-real-binary-xyz'), undefined);
});
