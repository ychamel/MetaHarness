import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Keeps agents from losing anyone's work through git (design §9). Agents use git as they like,
 * except that they can only add history: no deleting branches or tags, no moving a branch other
 * than their own backwards, and no pushing. MetaHarness removes worktrees and merged branches
 * itself when a goal ends.
 *
 * Enforced by git, so it holds for every harness and every way of running git: agents' processes
 * get core.hooksPath pointing at hooks written here (through GIT_CONFIG_PARAMETERS, which only
 * they have), and the human's own git is untouched. The repository's own hooks still run: each
 * hook here hands on to it.
 */

/** Hooks that only hand on to the repository's own. */
const PASS_THROUGH = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'post-rewrite', 'post-index-change',
  'pre-auto-gc', 'sendemail-validate',
];

/** The repository's own hook folder: its core.hooksPath (as the human has it), else the shared .git/hooks. */
const USER_HOOK = (name: string) => `h="\${MH_USER_HOOKS:-$(git rev-parse --git-common-dir)/hooks}/${name}"`;

const REFERENCE_TRANSACTION = `#!/bin/sh
# MetaHarness: agents can only add history. Refuses deleting a branch or tag, and moving a
# branch other than the agent's own (MH_OWN_BRANCH) to a commit that doesn't contain its tip.
input=$(cat)
if [ "$1" = prepared ]; then
  Z=0000000000000000000000000000000000000000
  printf '%s\\n' "$input" | while read -r old new ref; do
    case "$ref" in refs/heads/*|refs/tags/*) ;; *) continue ;; esac
    # The old value is only given when the command states one, so look up the current tip.
    cur=$(git rev-parse -q --verify "$ref") || continue
    if [ "$new" = "$Z" ]; then
      echo "MetaHarness: agents don't delete \${ref#refs/*/}. MetaHarness removes merged branches and worktrees itself when the goal ends; ask the human if something else should go." >&2
      exit 1
    fi
    case "$ref" in refs/tags/*) continue ;; esac
    [ -n "$MH_OWN_BRANCH" ] && [ "$ref" = "refs/heads/$MH_OWN_BRANCH" ] && continue
    if ! git merge-base --is-ancestor "$cur" "$new" 2>/dev/null; then
      echo "MetaHarness: that would drop commits from \${ref#refs/heads/}, which isn't your branch. Agents only add history to shared branches: make a new commit (git revert) instead." >&2
      exit 1
    fi
  done || exit 1
fi
${USER_HOOK('reference-transaction')}
[ -x "$h" ] || exit 0
printf '%s\\n' "$input" | "$h" "$@"
`;

const PRE_PUSH = `#!/bin/sh
echo "MetaHarness: agents commit but don't push. Say what's ready in your done note; the human pushes." >&2
exit 1
`;

const passThrough = (name: string) => `#!/bin/sh
${USER_HOOK(name)}
[ -x "$h" ] && exec "$h" "$@"
exit 0
`;

/** Writes the hooks under the daemon's home and returns their folder. */
export function installGuard(home: string): string {
  const dir = join(home, 'git-guard');
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = { 'reference-transaction': REFERENCE_TRANSACTION, 'pre-push': PRE_PUSH };
  for (const name of PASS_THROUGH) files[name] = passThrough(name);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/**
 * Environment for an agent's harness, so every git command it runs uses the guard. `ownBranch`
 * is its worktree branch, which it may rewrite. `repo` is read for the human's core.hooksPath.
 */
export function guardEnv(hooksDir: string, ownBranch: string | undefined, repo: string | undefined): Record<string, string> {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const param = `${quote('core.hooksPath')}=${quote(hooksDir)}`;
  const before = process.env.GIT_CONFIG_PARAMETERS;
  const env: Record<string, string> = {
    GIT_CONFIG_PARAMETERS: before ? `${before} ${param}` : param,
    MH_OWN_BRANCH: ownBranch ?? '',
  };
  if (repo) {
    try {
      // Relative paths are relative to where hooks run (the top of each worktree), as for the human.
      env.MH_USER_HOOKS = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // Not set: the hooks hand on to .git/hooks.
    }
  }
  return env;
}

/** The reference-transaction hook needs git 2.28. Undefined when it's fine, else why not. */
export function guardProblem(): string | undefined {
  try {
    const v = execFileSync('git', ['--version'], { encoding: 'utf8' }).match(/(\d+)\.(\d+)/);
    if (v && (Number(v[1]) > 2 || (Number(v[1]) === 2 && Number(v[2]) >= 28))) return undefined;
    return `git ${v?.[0] ?? '?'} is older than 2.28, so agents could delete or rewind branches; pushing is still blocked`;
  } catch {
    return "git isn't installed";
  }
}

/**
 * Shell commands MetaHarness refuses for agents before they run, with the reason: what the hooks
 * would refuse anyway, said up front, plus removing worktrees, which no hook sees.
 */
export function refusedGitCommand(command: string): string | undefined {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/);
    // git as the command: after any VAR=value assignments and wrappers like env, sudo or command.
    let at = 0;
    while (at < words.length && (/^\w+=/.test(words[at]) || ['env', 'sudo', 'command', 'exec', 'nohup', 'time'].includes(words[at]))) at++;
    if (words[at] !== 'git' && !words[at]?.endsWith('/git')) continue;
    // Skip git's own options (-C <dir>, -c <k=v>, --git-dir=…) to find the subcommand.
    let i = at + 1;
    while (i < words.length && words[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(words[i]) ? 2 : 1;
    const sub = words[i];
    const rest = words.slice(i + 1);
    if (sub === 'push') return "Agents commit but don't push: the human pushes. Say what's ready in your done note.";
    if (sub === 'branch' && rest.some(w => /^(-d|-D|--delete)$/.test(w) || /^-[a-zA-Z]*[dD][a-zA-Z]*$/.test(w))) {
      return "Agents don't delete branches: MetaHarness removes merged branches itself when the goal ends. Ask the human if one should go sooner.";
    }
    if (sub === 'tag' && rest.some(w => /^(-d|--delete)$/.test(w))) return "Agents don't delete tags. Ask the human.";
    if (sub === 'update-ref' && rest.includes('-d')) return "Agents don't delete refs. Ask the human.";
    if (sub === 'worktree' && ['remove', 'prune'].includes(rest[0] ?? '')) {
      return "Agents don't remove worktrees: MetaHarness removes them itself when the goal ends.";
    }
  }
  return undefined;
}

/** For Claude Code's own deny list, so a role's allow list can't open these up. */
export const CLAUDE_DISALLOWED = [
  'Bash(git push:*)', 'Bash(git branch -d:*)', 'Bash(git branch -D:*)', 'Bash(git branch --delete:*)',
  'Bash(git worktree remove:*)', 'Bash(git worktree prune:*)', 'Bash(git update-ref -d:*)', 'Bash(git tag -d:*)',
];
