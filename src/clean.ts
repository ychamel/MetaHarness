import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import * as git from './git.ts';

/**
 * Removing a goal's worktrees and the branches merged into the goal's branch (design §9). The
 * daemon does it when the lead finishes, and `mh clean` for what was kept; agents never do it
 * (src/guard.ts). Work that would be lost stays unless forced: a worktree with uncommitted
 * changes, and a branch with commits the goal's branch doesn't have. Anything git can't answer
 * about counts as work to keep. The shared folder and the event log stay.
 */

export interface CleanTarget {
  id: string;
  request: string;
  /** The repository the goal worked in. */
  dir: string;
  /** The branch the goal worked on; worktree branches count as merged once it contains them. */
  branch?: string;
}

export interface CleanResult {
  goal: string;
  request: string;
  /** Worktree folders removed. */
  removed: string[];
  /** Branches deleted. */
  deleted: string[];
  /** What was left, and why. */
  kept: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function cleanGoal(home: string, t: CleanTarget, force: boolean): CleanResult {
  const out: CleanResult = { goal: t.id, request: t.request, removed: [], deleted: [], kept: [] };
  const gs = existsSync(t.dir) ? git.setupGoal(t.dir, t.id) : { reason: `${t.dir} is gone` };
  const gg = 'reason' in gs ? undefined : gs;
  const into = t.branch && t.branch !== 'HEAD' && gg && git.resolveCommit(gg, t.branch) ? t.branch : undefined;
  const keptBranches = new Set<string>();

  const dir = join(home, 'goals', t.id, 'worktrees');
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const path = join(dir, name);
    const dirty = existsSync(join(path, '.git')) ? uncommitted(path) : [];
    if ((dirty === undefined || dirty.length) && !force) {
      out.kept.push(`${path}: ${dirty ? plural(dirty.length, 'uncommitted change') : "git couldn't say whether it has uncommitted changes"}`);
      keptBranches.add(git.agentBranch(t.id, name));
      continue;
    }
    git.removeWorktree(gg?.repo, path);
    out.removed.push(path);
  }
  if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir);

  if (gg) {
    for (const branch of git.goalBranches(gg, t.id).keys()) {
      if (keptBranches.has(branch)) {
        out.kept.push(`${branch}: its worktree was kept`);
        continue;
      }
      const ahead = into ? notIn(gg.repo, into, branch) : undefined;
      if (ahead !== 0 && !force) {
        out.kept.push(
          ahead === undefined
            ? `${branch}: can't tell whether it's merged (${into ? 'git failed' : `the goal's branch ${t.branch ?? '?'} isn't there`})`
            : `${branch}: ${plural(ahead, 'commit')} not merged into ${into}`,
        );
        continue;
      }
      try {
        git.deleteBranch(gg.repo, branch);
        out.deleted.push(branch);
      } catch (e) {
        out.kept.push(`${branch}: ${(e as Error).message.trim().split('\n')[0]}`);
      }
    }
  }
  return out;
}

/** One line for the human about a cleanup, or '' if it did nothing. */
export function describeClean(r: CleanResult, forceHint: string): string {
  const did = [r.removed.length && `removed ${plural(r.removed.length, 'worktree')}`, r.deleted.length && `deleted ${plural(r.deleted.length, 'merged branch', 'merged branches')}`].filter(Boolean);
  const parts = did.length ? [`MetaHarness ${did.join(' and ')}.`] : [];
  if (r.kept.length) parts.push(`Kept: ${r.kept.join('; ')}. ${forceHint}`);
  return parts.join(' ');
}

/** `git status --short` lines, or undefined if git couldn't tell. */
function uncommitted(path: string): string[] | undefined {
  try {
    return git.git(path, 'status', '--short').split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
}

/** How many commits `branch` has that `into` doesn't, or undefined if git couldn't tell. */
function notIn(repo: string, into: string, branch: string): number | undefined {
  try {
    const n = Number(git.git(repo, 'rev-list', '--count', `${into}..${branch}`));
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}
