import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

/**
 * Git plumbing (design §9). The team works in the human's checkout, on whatever branch is checked
 * out. Agents that ask for a worktree get one on mh/<goal>/<agent>, and the lead merges those
 * branches back into the checked-out branch.
 */

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd: string, ...args: string[]): string | undefined {
  try {
    return git(cwd, ...args);
  } catch {
    return undefined;
  }
}

export interface GoalGit {
  /** Top level of the repository the agents work on. */
  repo: string;
  /** The shared .git directory every worktree commits into. */
  commonDir: string;
  /** The branch checked out when the goal started ("HEAD" if detached). The team works on it, and worktree branches merge into it. */
  branch: string;
  /** The commit the goal started from. */
  base: string;
  /** The checkout had uncommitted changes, which the agents will see (worktrees don't include them). */
  dirty: boolean;
}

export interface Worktree {
  path: string;
  branch: string;
  /** The worktree's own git directory (.git/worktrees/<name>), where its index and HEAD live. */
  gitDir: string;
  /** The commit it started from. */
  base: string;
}

export const agentBranch = (goal: string, agent: string) => `mh/${goal}/${agent}`;

/** Prepares a goal's git state, or explains why the goal can't have worktrees. */
export function setupGoal(dir: string, goal: string): GoalGit | { reason: string } {
  const repo = tryGit(dir, 'rev-parse', '--show-toplevel');
  if (!repo) return { reason: `${dir} isn't a git repository` };
  const base = tryGit(repo, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  if (!base) return { reason: 'the repository has no commits yet' };
  const common = git(repo, 'rev-parse', '--git-common-dir');
  return {
    repo,
    commonDir: isAbsolute(common) ? common : join(repo, common),
    branch: tryGit(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD') ?? 'HEAD',
    base,
    dirty: git(repo, 'status', '--porcelain', '--untracked-files=no') !== '',
  };
}

/** Creates a worktree at `path` on a new branch starting at `from`. */
export function addWorktree(g: GoalGit, path: string, branch: string, from: string): Worktree {
  const base = git(g.repo, 'rev-parse', '--verify', `${from}^{commit}`);
  git(g.repo, 'worktree', 'add', '--quiet', '-b', branch, path, base);
  const gitDir = git(path, 'rev-parse', '--absolute-git-dir');
  return { path, branch, gitDir, base };
}

/** The commit a ref or teammate's branch points at, if it exists. */
export function resolveCommit(g: GoalGit, ref: string): string | undefined {
  return tryGit(g.repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
}

export function subject(g: GoalGit, rev: string): string {
  return tryGit(g.repo, 'log', '-1', '--format=%s', rev) ?? '';
}

export function countCommits(g: GoalGit, from: string, to: string): number {
  return Number(tryGit(g.repo, 'rev-list', '--count', `${from}..${to}`) ?? 0);
}

/** Every branch under mh/<goal>/, with the commit it points at. */
export function goalBranches(g: GoalGit, goal: string): Map<string, string> {
  const out = tryGit(g.repo, 'for-each-ref', '--format=%(refname:short) %(objectname)', `refs/heads/mh/${goal}/`) ?? '';
  return new Map(out.split('\n').filter(Boolean).map(l => l.split(' ') as [string, string]));
}

/** The goal branch (other than `exclude`) that a commit is on, if any. */
export function branchOf(g: GoalGit, goal: string, sha: string, exclude: string): string | undefined {
  const named = tryGit(g.repo, 'name-rev', '--name-only', `--refs=refs/heads/mh/${goal}/*`, `--exclude=refs/heads/${exclude}`, sha);
  return named && named !== 'undefined' ? named.replace(/[~^].*$/, '') : undefined;
}

export interface NewCommit {
  sha: string;
  summary: string;
  /** For a merge commit, its second parent. */
  mergedSha?: string;
}

/** Commits made on a branch between two tips, oldest first, following the branch's own line. */
export function commitsBetween(g: GoalGit, from: string, to: string): NewCommit[] {
  const out = tryGit(g.repo, 'log', '--first-parent', '--reverse', '-n', '50', '--format=%H %P%x09%s', `${from}..${to}`) ?? '';
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [ids, summary = ''] = line.split('\t');
      const [sha, , second] = ids.split(' ');
      return { sha, summary, mergedSha: second };
    });
}

/** Uncommitted changes in a worktree, one `git status --short` line each. */
export function statusShort(path: string): string[] {
  return (tryGit(path, 'status', '--short') ?? '').split('\n').filter(Boolean);
}
