import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainApproval, parseChoices, termIn } from '../ui/src/beginner.ts';
import { atLeast, machineLines } from '../src/doctor.ts';

/** Beginner mode: approvals explained in plain words before the command itself. */

test('an approval in plain words: what it does, how risky, whether it can be undone', () => {
  const cases: [string, string, string][] = [
    ['Bash: git push origin main', 'Sends commits', 'high'],
    ['Bash: git reset --hard HEAD~1', 'Throws away changes', 'high'],
    ['Bash: git commit -m "x"', 'Saves the current changes', 'low'],
    ['Bash: rm -rf build', 'Deletes files', 'high'],
    ['Bash: npm install left-pad', 'Installs code libraries', 'medium'],
    ['Bash: npm test', 'Runs the project’s tests', 'low'],
    ['Bash: node --test test/a.test.ts', 'Runs the project’s tests', 'low'],
    ['Bash: curl https://example.com -o x', 'Downloads something', 'medium'],
    ['Write: src/app.ts', 'Changes a file: src/app.ts', 'low'],
  ];
  for (const [text, summary, risk] of cases) {
    const e = explainApproval(text);
    assert.ok(e.summary.startsWith(summary), `${text} → ${e.summary}`);
    assert.equal(e.risk, risk, text);
    assert.ok(e.undo.length > 0, text);
  }
});

test('an explanation looks past cd and env assignments, and says when there are more steps', () => {
  assert.match(explainApproval('Bash: cd web && NODE_ENV=test npm test').summary, /^Runs the project’s tests to check the code works$/);
  assert.match(explainApproval('Bash: git add -A && git commit -m x').summary, /^Marks changed files.*, and more steps$/);
});

test("what it doesn't recognize stays cautious and points at the command", () => {
  const e = explainApproval('Bash: frobnicate --all');
  assert.equal(e.risk, 'medium');
  assert.match(e.summary, /doesn’t recognize/);
  assert.match(explainApproval('WebFetch: https://x').summary, /Uses the WebFetch tool/);
});

test("a message's choices: the list under Options:, the recommended one marked", () => {
  const text = 'Which login should the app use?\n\nOptions:\n1. Email and password (recommended)\n2. Google sign-in — needs a Google account\n3. Both\n\nSay which and I carry on.';
  assert.deepEqual(parseChoices(text), [
    { label: 'Email and password', recommended: true },
    { label: 'Google sign-in — needs a Google account', recommended: false },
    { label: 'Both', recommended: false },
  ]);
  assert.deepEqual(parseChoices('**Options:**\n- Keep it\n- Remove it (recommended)').map(c => c.recommended), [false, true]);
  assert.deepEqual(parseChoices('Options:\n1. Only one'), [], 'one option is no choice');
  assert.deepEqual(parseChoices('Should I go on?\n1. a numbered list without the Options line\n2. b'), []);
});

test('a label is matched to its glossary entry as a whole word, the longer name first', () => {
  assert.equal(termIn('Harness')?.term, 'harness');
  assert.equal(termIn('MCP servers')?.term, 'mcp servers');
  assert.equal(termIn('Gatekeeper role')?.term, 'gatekeeper');
  assert.equal(termIn('Backups, best first')?.term, 'backups');
  assert.equal(termIn('Prompt caches')?.term, 'prompt cache', 'a plural counts');
  assert.equal(termIn('Remodel'), undefined, 'not inside another word');
  assert.equal(termIn('Save to'), undefined);
});

test('doctor checks the machine and gives the command that fixes each problem', () => {
  const ok = machineLines({ node: '24.3.0', git: '2.45.1', uiBuilt: true, dir: '/mh', platform: 'linux' }).join('\n');
  assert.doesNotMatch(ok, /✗|Fix:/);
  const bad = machineLines({ node: '22.1.0', git: '2.20.0', uiBuilt: false, dir: 'C:\mh', platform: 'win32' }).join('\n');
  assert.match(bad, /✗ Node 22\.1\.0: MetaHarness needs 24 or newer\. Fix: winget install OpenJS\.NodeJS/);
  assert.match(bad, /✗ git 2\.20\.0: .*Fix: winget install Git\.Git/);
  assert.match(bad, /✗ Web app: not built yet\. Fix: cd "C:\mh" && npm run ui:build/);
  assert.match(machineLines({ node: '24.0.0', uiBuilt: true, dir: '/mh', platform: 'darwin' }).join('\n'), /✗ git: not installed\. Fix: brew install git/);
  assert.ok(atLeast('2.28.0', '2.28') && atLeast('2.100', '2.28') && !atLeast('2.9', '2.28'));
});
