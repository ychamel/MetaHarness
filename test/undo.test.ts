import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDaemon, makeRepo, settle, withTimeout } from './helpers.ts';

/** Undoing a finished goal: the project as it was before, as one new commit. */

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('undo a goal: files back as they were, one new commit, the goal’s work kept in history', async () => {
  const repo = makeRepo();
  const d = makeDaemon(
    {
      architect: async ctx => {
        ctx.writeFile('README.md', '# Changed by the team\n');
        ctx.writeFile('feature.txt', 'new\n');
        sh(ctx.spec.cwd, 'add', '-A');
        sh(ctx.spec.cwd, 'commit', '-qm', 'Add a feature');
        // Edited files: the finish-clean rule holds the first done and asks for it again.
        if (/call done again/.test(await ctx.tool('done', { note: 'Added a feature.' }))) await ctx.tool('done', { note: 'Added a feature.' });
      },
    },
    { repo, settings: { approvals: 'allow' } },
  );
  const goal = d.startGoal({ request: 'Add a feature', lead: 'architect' });
  await withTimeout(d.goals.get(goal)!.leadDone, 15_000, 'lead done');
  await settle();

  const preview = d.undoGoal(goal);
  assert.deepEqual(preview.commits.map(c => c.summary), ['Add a feature'], 'it says what it would undo');
  assert.equal(preview.undone, undefined, 'and changes nothing without confirm');
  assert.ok(existsSync(join(repo, 'feature.txt')));

  writeFileSync(join(repo, 'mine.txt'), 'not committed\n');
  assert.throws(() => d.undoGoal(goal, true), /aren’t saved in a commit/, 'the human’s uncommitted work is never touched');
  rmSync(join(repo, 'mine.txt'));

  // The project's own commit hook refusing: nothing changes.
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 });
  assert.throws(() => d.undoGoal(goal, true), /commit check refused the undo, so nothing was changed: lint failed/);
  assert.ok(existsSync(join(repo, 'feature.txt')));
  assert.equal(sh(repo, 'status', '--porcelain'), '', 'left exactly as it was');
  rmSync(hook);

  const r = d.undoGoal(goal, true);
  assert.ok(r.undone);
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), '# Test repo\n', 'line endings aside (core.autocrlf)');
  assert.ok(!existsSync(join(repo, 'feature.txt')), 'files the goal added are gone');
  assert.match(sh(repo, 'log', '--format=%s', '-3'), /^Undo goal \S+: Add a feature\nAdd a feature\nInitial commit$/);
  assert.equal(sh(repo, 'status', '--porcelain'), '');
  assert.equal(d.undoGoal(goal).commits.length, 2, 'the undo is a commit too, so it can be undone in turn');
  await d.close();
});
