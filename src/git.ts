import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
  /** The checkout's own git directory, where MERGE_HEAD and the like appear. */
  gitDir: string;
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
  /** Dependency folders copied in from the checkout (copyDependencies). */
  deps?: string[];
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
    gitDir: git(repo, 'rev-parse', '--absolute-git-dir'),
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

/** The commits a merge brought in: on its second parent's line, not already on its first. */
export function mergedCommits(g: GoalGit, merge: string): string[] {
  return (tryGit(g.repo, 'rev-list', '-n', '100', `${merge}^1..${merge}^2`) ?? '').split('\n').filter(Boolean);
}

/** The files a commit changed, against its first parent (renames detected). */
export function changedFiles(g: GoalGit, sha: string): import('./rules.ts').CommitFile[] {
  const out = tryGit(g.repo, 'diff-tree', '--no-commit-id', '--root', '-r', '-M', '--name-status', sha) ?? '';
  const kinds: Record<string, import('./rules.ts').ChangeKind> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' };
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [status, a, b] = line.split('\t');
      const kind = kinds[status[0]] ?? 'modified';
      return b ? { kind, path: b, ...(kind === 'renamed' ? { from: a } : {}) } : { kind, path: a };
    });
}

/** Uncommitted changes in a worktree, one `git status --short` line each. */
export function statusShort(path: string): string[] {
  return (tryGit(path, 'status', '--short') ?? '').split('\n').filter(Boolean);
}

/**
 * Ignored dependency folders a fresh worktree doesn't have. Virtual environments aren't here: a
 * copy still runs the checkout's Python, so installing into it would change the human's.
 */
export const COPIED_DEPENDENCIES = ['node_modules', 'vendor'];

/**
 * Copies the checkout's ignored dependency folders into a worktree as hard links (`cp -al`):
 * quick, no extra space, and an agent that reinstalls or deletes them only touches its own
 * copy. Needs the worktree on the same filesystem; otherwise nothing is copied and the agent
 * installs. Returns what was copied.
 */
export function copyDependencies(g: GoalGit, worktree: string, names = COPIED_DEPENDENCIES): string[] {
  return names.filter(n => {
    const src = join(g.repo, n);
    const dst = join(worktree, n);
    if (!existsSync(src) || existsSync(dst)) return false;
    if (tryGit(g.repo, 'check-ignore', '-q', n) === undefined) return false;
    try {
      execFileSync('cp', ['-al', src, dst], { stdio: 'ignore' });
      return true;
    } catch {
      // Another filesystem, or a cp without -l: leave it to the agent.
      rmSync(dst, { recursive: true, force: true });
      return false;
    }
  });
}

export interface Conflict {
  /** What stopped on the conflict. */
  op: 'merge' | 'cherry-pick' | 'revert' | 'rebase';
  /** The commit being merged or applied, when git records it. */
  sha?: string;
  /** Files with unresolved conflicts. */
  files: string[];
}

/**
 * A merge, cherry-pick, revert or rebase in progress in a checkout or worktree, if any. `files`
 * is empty once every conflict is resolved but the operation hasn't been committed yet.
 */
export function operationInProgress(cwd: string, gitDir: string): Conflict | undefined {
  const head = (f: string) => (existsSync(join(gitDir, f)) ? readFileSync(join(gitDir, f), 'utf8').trim() : undefined);
  let op: Conflict['op'] | undefined;
  let sha: string | undefined;
  if ((sha = head('MERGE_HEAD'))) op = 'merge';
  else if ((sha = head('CHERRY_PICK_HEAD'))) op = 'cherry-pick';
  else if ((sha = head('REVERT_HEAD'))) op = 'revert';
  else if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
    op = 'rebase';
    sha = head('REBASE_HEAD');
  }
  if (!op) return undefined;
  const files = (tryGit(cwd, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
  // A merge can hold several heads (an octopus); the first is enough to name it.
  return { op, sha: sha?.split('\n')[0], files };
}

/** Whether `sha` is in the history of what's checked out at `cwd`. */
export function containsCommit(cwd: string, sha: string): boolean {
  return tryGit(cwd, 'merge-base', '--is-ancestor', sha, 'HEAD') !== undefined;
}

/** Removes a worktree and its folder, whatever is in it: check for uncommitted work first. */
export function removeWorktree(repo: string | undefined, path: string): void {
  const live = !!repo && existsSync(repo);
  if (live && tryGit(repo, 'worktree', 'remove', '--force', '--force', path) !== undefined) return;
  // Not registered any more, or the repository is gone: remove the folder and forget it.
  rmSync(path, { recursive: true, force: true });
  if (live) tryGit(repo, 'worktree', 'prune');
}

export function deleteBranch(repo: string, branch: string): void {
  git(repo, 'branch', '-D', branch);
}

/* ---------------- what changed: sizes and diffs, for the app (design §14) ---------------- */

export interface CommitStats {
  files: number;
  added: number;
  removed: number;
  /** The paths it changed, at most PATHS_MAX of them. */
  paths: string[];
}

const PATHS_MAX = 200;

/** Lines added and removed by a commit, against its first parent (so a merge counts what it brought in). */
export function commitStats(g: GoalGit, sha: string): CommitStats {
  const out = tryGit(g.repo, 'diff-tree', '--no-commit-id', '-r', '-M', '--numstat', '--root', '--diff-merges=first-parent', sha) ?? '';
  const s: CommitStats = { files: 0, added: 0, removed: 0, paths: [] };
  for (const line of out.split('\n')) {
    const [a, r, ...rest] = line.split('\t');
    if (!rest.length) continue;
    s.files++;
    s.added += Number(a) || 0;
    s.removed += Number(r) || 0;
    if (s.paths.length < PATHS_MAX) s.paths.push(renamedTo(rest.join('\t')));
  }
  return s;
}

/** numstat names a rename "old => new" or "dir/{old => new}/file". */
function renamedTo(p: string): string {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (brace) return (brace[1] + brace[3] + brace[4]).replace(/\/\//g, '/');
  const arrow = p.indexOf(' => ');
  return arrow >= 0 ? p.slice(arrow + 4) : p;
}

export interface DiffFile {
  path: string;
  /** The old path of a rename or copy. */
  from?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  binary: boolean;
  /** The file's hunks, from its first @@ line; empty for binary files, cut at FILE_MAX. */
  patch: string;
  cut?: boolean;
}

const FILE_MAX = 80 * 1024;
const DIFF_MAX = 2 * 1024 * 1024;

/** Splits `git diff` output into files. */
export function parsePatch(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n');
    const head = /^a\/(.*) b\/(.*)$/.exec(lines[0]) ?? [];
    const f: DiffFile = { path: head[2] ?? lines[0], status: 'modified', added: 0, removed: 0, binary: false, patch: '' };
    let i = 1;
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i];
      if (l.startsWith('new file')) f.status = 'added';
      else if (l.startsWith('deleted file')) f.status = 'deleted';
      else if (l.startsWith('rename from ') || l.startsWith('copy from ')) f.from = l.replace(/^(rename|copy) from /, '');
      else if (l.startsWith('rename to ') || l.startsWith('copy to ')) {
        f.path = l.replace(/^(rename|copy) to /, '');
        f.status = l.startsWith('rename') ? 'renamed' : 'added';
      } else if (l.startsWith('+++ b/')) f.path = l.slice(6);
      else if (l.startsWith('--- a/') && f.status === 'deleted') f.path = l.slice(6);
      else if (l.startsWith('Binary files') || l.startsWith('GIT binary patch')) f.binary = true;
    }
    const hunks = lines.slice(i);
    while (hunks.length && hunks.at(-1) === '') hunks.pop();
    for (const l of hunks) {
      if (l.startsWith('+')) f.added++;
      else if (l.startsWith('-')) f.removed++;
    }
    f.patch = hunks.join('\n');
    if (f.patch.length > FILE_MAX) {
      f.patch = f.patch.slice(0, f.patch.lastIndexOf('\n', FILE_MAX));
      f.cut = true;
    }
    files.push(f);
  }
  return files;
}

function runDiff(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: DIFF_MAX * 4 }).slice(0, DIFF_MAX);
  } catch (e) {
    // `diff --no-index` exits 1 when the files differ, which is the point.
    const out = (e as { stdout?: string }).stdout;
    if (typeof out === 'string') return out.slice(0, DIFF_MAX);
    throw e;
  }
}

/** What a commit changed, against its first parent. */
export function commitDiff(g: GoalGit, sha: string): DiffFile[] {
  return parsePatch(runDiff(g.repo, ['diff-tree', '-p', '-M', '--no-commit-id', '--root', '--diff-merges=first-parent', sha]));
}

/** Everything between two commits (or trees), e.g. what a goal changed since it started; `paths` narrows it. */
export function rangeDiff(g: GoalGit, from: string, to: string, paths: string[] = []): DiffFile[] {
  return parsePatch(runDiff(g.repo, ['diff', '-M', from, to, ...(paths.length ? ['--', ...paths] : [])]));
}

/** Uncommitted changes in a checkout or worktree, new files included. */
export function workingDiff(cwd: string): DiffFile[] {
  const files = parsePatch(runDiff(cwd, ['diff', '-M', 'HEAD']));
  const untracked = (tryGit(cwd, 'ls-files', '--others', '--exclude-standard') ?? '').split('\n').filter(Boolean);
  for (const p of untracked.slice(0, 200)) files.push(...parsePatch(runDiff(cwd, ['diff', '--no-index', '--', '/dev/null', p])).map(f => ({ ...f, path: p, status: 'added' as const })));
  return files;
}

export interface TreeFile {
  path: string;
  /** Bytes. */
  size: number;
  blob: string;
}

/** Every file in a commit's tree. */
export function treeFiles(g: GoalGit, rev: string): TreeFile[] {
  const out = tryGit(g.repo, '-c', 'core.quotepath=off', 'ls-tree', '-r', '--long', rev) ?? '';
  const files: TreeFile[] = [];
  for (const line of out.split('\n')) {
    // <mode> blob <sha> <size>\t<path>
    const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.*)$/.exec(line);
    if (m) files.push({ path: m[3], size: Number(m[2]), blob: m[1] });
  }
  return files;
}

/** The text of blobs, by sha (git cat-file --batch). Binary or missing ones are left out. */
export function readBlobs(g: GoalGit, blobs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!blobs.length) return out;
  const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: g.repo, input: blobs.join('\n') + '\n', maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
  let at = 0;
  for (const sha of blobs) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString();
    const size = Number(header.split(' ')[2]);
    at = nl + 1;
    if (header.endsWith('missing') || !Number.isFinite(size)) continue;
    const body = buf.subarray(at, at + size);
    at += size + 1;
    if (!body.includes(0)) out.set(sha, body.toString('utf8'));
  }
  return out;
}

/** A file's text at a revision, if it's there. */
export function showFile(g: GoalGit, rev: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], { cwd: g.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/* ---------------- a scope of work, for the Design view (design §14) ---------------- */

/** Git's empty tree: what a first commit is compared with. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function mergeBase(g: GoalGit, a: string, b: string): string | undefined {
  return tryGit(g.repo, 'merge-base', a, b);
}

/** A commit, or a tree (a merged picture of unmerged branches is one), by name. */
export function resolveTreeish(g: GoalGit, ref: string): string | undefined {
  return resolveCommit(g, ref) ?? tryGit(g.repo, 'rev-parse', '--verify', '--quiet', `${ref}^{tree}`);
}

/**
 * The tree the goal branch would have with these branches merged into it, without touching any
 * branch or checkout (`git merge-tree`). Conflicted files keep their markers and are listed. The
 * objects it writes are unreferenced, and git's housekeeping removes them in time.
 */
export function mergedTree(g: GoalGit, tip: string, branches: string[]): { tree: string; conflicts: string[] } {
  // Fixed dates make the in-between commits, and so the result, the same each time.
  const env = { ...process.env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const id = ['-c', 'user.name=MetaHarness', '-c', 'user.email=metaharness@localhost'];
  let head = tip;
  let tree = git(g.repo, 'rev-parse', `${tip}^{tree}`);
  const conflicts = new Set<string>();
  for (const b of branches) {
    let out: string;
    try {
      out = execFileSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', head, b], { cwd: g.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (e) {
      // Exit 1: merged, with conflicts. Anything else is an error, and the branch is left out.
      const err = e as { status?: number; stdout?: string };
      if (err.status !== 1 || !err.stdout) continue;
      out = err.stdout;
    }
    const [first, ...rest] = out.trim().split('\n');
    tree = first.trim();
    for (const f of rest) if (f.trim()) conflicts.add(f.trim());
    head = execFileSync('git', [...id, 'commit-tree', tree, '-p', head, '-p', b, '-m', 'merged picture'], { cwd: g.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  }
  return { tree, conflicts: [...conflicts] };
}

export interface LogCommit {
  sha: string;
  parents: string[];
  at: string;
  summary: string;
  /** Lines added and removed per file; empty for a merge, whose work is in the commits it brings. */
  files: { path: string; added: number; removed: number }[];
}

/** Commits reachable from `heads` and not from `from`, newest first, with their files. */
export function scopeLog(g: GoalGit, heads: string[], from: string, max = 400): LogCommit[] {
  const out = tryGit(g.repo, '-c', 'core.quotepath=off', 'log', '-n', String(max), '-M', '--numstat', '--format=%x01%H %P%x09%aI%x09%s', ...heads, ...(from === EMPTY_TREE ? [] : [`^${from}`])) ?? '';
  const commits: LogCommit[] = [];
  for (const chunk of out.split('\x01').slice(1)) {
    const [head, ...lines] = chunk.split('\n');
    const [ids, at = '', ...subject] = head.split('\t');
    const [sha, ...parents] = ids.split(' ').filter(Boolean);
    const files = lines
      .map(l => l.split('\t'))
      .filter(p => p.length >= 3)
      .map(([a, r, ...rest]) => ({ path: renamedTo(rest.join('\t')), added: Number(a) || 0, removed: Number(r) || 0 }));
    commits.push({ sha, parents, at, summary: subject.join('\t'), files });
  }
  return commits;
}

/** Lines added and removed per file between two trees. */
export function numstat(g: GoalGit, from: string, to: string): Map<string, { added: number; removed: number }> {
  const out = tryGit(g.repo, '-c', 'core.quotepath=off', 'diff', '-M', '--numstat', from, to) ?? '';
  const m = new Map<string, { added: number; removed: number }>();
  for (const line of out.split('\n')) {
    const [a, r, ...rest] = line.split('\t');
    if (rest.length) m.set(renamedTo(rest.join('\t')), { added: Number(a) || 0, removed: Number(r) || 0 });
  }
  return m;
}
