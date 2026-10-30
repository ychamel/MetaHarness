import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../src/daemon.ts';
import { FakeAdapter, demoScripts } from '../src/adapters/fake.ts';
import { makeRepo } from './helpers.ts';

/** A daemon over a personal and a repository config folder. */
function setup() {
  const personal = mkdtempSync(join(tmpdir(), 'mh-personal-'));
  const repo = mkdtempSync(join(tmpdir(), 'mh-repo-cfg-'));
  mkdirSync(join(repo, 'roles'));
  writeFileSync(join(repo, 'roles', 'architect.md'), '<!-- kept -->\n---\nharness: fake\nmodel: opus\ngood_at: design\ncolor: blue\n---\nThink first.\n');
  mkdirSync(join(personal, 'roles'));
  writeFileSync(join(personal, 'roles', 'architect.md'), '---\nharness: fake\nmodel: sonnet\n---\nMine.\n');
  mkdirSync(join(repo, 'playbooks'));
  writeFileSync(join(repo, 'playbooks', 'old.md'), 'Do the old thing.\n');
  const d = new Daemon({ home: mkdtempSync(join(tmpdir(), 'mh-home-')), repo: makeRepo(), dbPath: ':memory:', configDirs: [personal, repo], adapters: { fake: new FakeAdapter(demoScripts) }, pollMs: 0, settings: { approvals: 'ask' } });
  return { d, personal, repo };
}

test('config: the view says where each role comes from, and what it overrides', async () => {
  const { d } = setup();
  const v = (await d.command({ cmd: 'config.get' })) as any;
  assert.deepEqual(v.scopes.map((s: { scope: string }) => s.scope), ['personal', 'repo']);
  const arch = v.roles.find((r: { name: string }) => r.name === 'architect');
  assert.equal(arch.scope, 'repo');
  assert.equal(arch.overrides, 'personal');
  assert.equal(arch.model, 'opus');
  const wf = (name: string) => v.workflows.find((w: { name: string }) => w.name === name);
  assert.equal(wf('old').scope, 'repo');
  assert.equal(wf('map-bootstrap').scope, 'built-in', 'the built-in workflow shows, marked built-in');
  assert.ok(v.rules.some((r: { name: string; scope: string; on: boolean }) => r.name === 'map' && r.scope === 'built-in' && r.on));
  assert.equal(v.methodology.from, 'built-in');
  assert.ok(v.harnesses.some((h: { id: string }) => h.id === 'claude-code'));
});

test('config: saving a role writes its file, keeps unknown keys and comments, and applies at once', async () => {
  const { d, repo } = setup();
  await d.command({
    cmd: 'role.save', scope: 'repo', name: 'architect', previous: { name: 'architect', scope: 'repo' },
    harness: 'fake', model: 'opus-2', goodAt: 'design,\nand reviews', fallback: ['codex/gpt-6-sol'], helper: false, worktree: true,
    mcp: [], autoApprove: 'none', allow: ['Bash(npm test*)', 'Bash(git log*)'], instructions: 'Think harder.',
  });
  const text = readFileSync(join(repo, 'roles', 'architect.md'), 'utf8');
  assert.match(text, /^<!-- kept -->\n---\n/);
  assert.match(text, /model: opus-2\n/);
  assert.match(text, /good_at: design, and reviews\n/);
  assert.match(text, /worktree: true\n/);
  assert.match(text, /auto_approve: none\n/);
  assert.match(text, /allow: Bash\(npm test\*\), Bash\(git log\*\)\n/);
  assert.match(text, /color: blue\n/);
  assert.doesNotMatch(text, /helper:/);
  assert.match(text, /---\nThink harder\.\n$/);
  const r = d.project().config.roles.get('architect')!;
  assert.equal(r.model, 'opus-2');
  assert.deepEqual(r.allow, ['Bash(npm test*)', 'Bash(git log*)']);
  assert.equal(r.worktree, true);
  assert.equal(r.autoApprove, 'none');
});

test('config: renaming or moving a role removes the old file; names and clashes are checked', async () => {
  const { d, repo, personal } = setup();
  await d.command({ cmd: 'role.save', scope: 'personal', name: 'lead', previous: { name: 'architect', scope: 'repo' }, harness: 'fake', instructions: 'x' });
  assert.ok(!existsSync(join(repo, 'roles', 'architect.md')));
  assert.ok(existsSync(join(personal, 'roles', 'lead.md')));
  // The personal architect shows through again.
  assert.equal(d.project().config.roles.get('architect')!.model, 'sonnet');
  await assert.rejects(d.command({ cmd: 'role.save', scope: 'personal', name: 'architect', harness: 'fake' }), /already a role called architect/);
  await assert.rejects(d.command({ cmd: 'role.save', scope: 'repo', name: '../x', harness: 'fake' }), /name uses letters/);
  await assert.rejects(d.command({ cmd: 'role.save', scope: 'repo', name: 'x' }), /needs a harness/);
  await d.command({ cmd: 'role.delete', scope: 'personal', name: 'lead' });
  assert.ok(!d.project().config.roles.has('lead'));
});

test('config: workflows move from playbooks/ on save; guidelines and MCP servers save and reset', async () => {
  const { d, repo, personal } = setup();
  await d.command({ cmd: 'workflow.save', scope: 'repo', name: 'old', previous: { name: 'old', scope: 'repo' }, goodAt: 'old things', body: '1. Do it.' });
  assert.ok(!existsSync(join(repo, 'playbooks', 'old.md')));
  assert.equal(readFileSync(join(repo, 'workflows', 'old.md'), 'utf8'), '---\ngood_at: old things\n---\n1. Do it.\n');
  assert.equal(d.project().config.workflows.get('old')!.goodAt, 'old things');

  await d.command({ cmd: 'guide.save', scope: 'personal', which: 'methodology', text: 'Be kind.' });
  assert.equal(d.project().config.methodology, 'Be kind.');
  const v = (await d.command({ cmd: 'config.get' })) as any;
  assert.equal(v.methodology.from, 'personal');
  await d.command({ cmd: 'guide.save', scope: 'personal', which: 'methodology', text: '' });
  assert.ok(!existsSync(join(personal, 'methodology.md')));
  assert.match(d.project().config.methodology, /team of AI agents/);

  writeFileSync(join(repo, 'mcp.json'), JSON.stringify({ note: 'mine', mcpServers: { a: { command: 'a' } } }));
  await d.command({ cmd: 'mcp.save', scope: 'repo', name: 'blender', def: { command: 'uvx', args: ['blender-mcp'] } });
  assert.deepEqual(d.project().config.mcp.get('blender'), { command: 'uvx', args: ['blender-mcp'] });
  await d.command({ cmd: 'mcp.save', scope: 'repo', name: 'a', def: null });
  const doc = JSON.parse(readFileSync(join(repo, 'mcp.json'), 'utf8'));
  assert.equal(doc.note, 'mine');
  assert.deepEqual(Object.keys(doc.mcpServers), ['blender']);
  await assert.rejects(d.command({ cmd: 'mcp.save', scope: 'repo', name: 'b', def: {} }), /command to run or a URL/);
});

test('shared files: latest text, a kept version, and nothing outside the folder', async () => {
  const { d } = setup();
  const goal = 'abcd1234';
  const dir = join(d.home, 'goals', goal, 'shared');
  mkdirSync(join(dir, '.history', 'design.md'), { recursive: true });
  writeFileSync(join(dir, 'design.md'), 'v2');
  writeFileSync(join(dir, '.history', 'design.md', '001-architect.md'), 'v1');
  writeFileSync(join(dir, '.history', 'design.md', '002-reviewer.md'), 'v2');
  const f = d.sharedFile(goal, 'design.md');
  assert.equal(f.text, 'v2');
  assert.deepEqual(f.versions, [{ version: 1, by: 'architect' }, { version: 2, by: 'reviewer' }]);
  assert.equal(d.sharedFile(goal, 'design.md', 1).text, 'v1');
  assert.throws(() => d.sharedFile(goal, '../../token'), /isn't a file in the shared folder/);
  assert.throws(() => d.sharedFile(goal, '.history/design.md/001-architect.md'), /isn't a file/);
  assert.equal(d.sharedFile(goal, 'missing.md').exists, false);
});

test('settings: each folder keeps its own settings.json; the repository wins, key by key', async () => {
  const personal = mkdtempSync(join(tmpdir(), 'mh-personal-'));
  const repo = mkdtempSync(join(tmpdir(), 'mh-repo-'));
  writeFileSync(join(repo, 'prices.json'), JSON.stringify({ 'gpt-old': { input: 1, cachedInput: 0.1, output: 4 } }));
  const d = new Daemon({ home: mkdtempSync(join(tmpdir(), 'mh-home-')), repo: makeRepo(), dbPath: ':memory:', configDirs: [personal, repo], adapters: { fake: new FakeAdapter(demoScripts) }, pollMs: 0 });
  assert.equal(d.project().config.settings.approvals, 'gatekeeper', 'the default');
  assert.deepEqual(d.project().config.settings.models['gpt-old'].prices, { input: 1, output: 4, cacheRead: 0.1 }, 'the old prices.json still counts');

  await d.command({ cmd: 'settings.save', scope: 'personal', patch: { approvals: 'ask', cacheRemindSec: 90, models: { 'codex/sol': { prices: { input: 1.25, output: 10 }, cacheMinutes: 10 } } } });
  await d.command({ cmd: 'settings.save', scope: 'repo', patch: { approvals: 'harness', models: { 'codex/sol': { cacheMinutes: 30 } } } });
  const s = d.project().config.settings;
  assert.equal(s.approvals, 'harness');
  assert.equal(s.cacheRemindSec, 90);
  assert.deepEqual(s.models['codex/sol'], { prices: { input: 1.25, output: 10 }, cacheMinutes: 30 });
  const v = (await d.command({ cmd: 'config.get' })) as any;
  assert.deepEqual(v.settings.files.map((f: any) => f.values.approvals), ['ask', 'harness']);

  // null removes a key, and a model with nothing left.
  await d.command({ cmd: 'settings.save', scope: 'repo', patch: { approvals: null, models: { 'codex/sol': null } } });
  assert.equal(d.project().config.settings.approvals, 'ask');
  assert.deepEqual(JSON.parse(readFileSync(join(repo, 'settings.json'), 'utf8')), {});
  await d.close();
});
