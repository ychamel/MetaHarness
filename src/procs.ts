import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

/**
 * Harness CLIs and what they start (shells, dev servers, MCP servers) as one tree each. Each CLI
 * runs in a process group of its own, so ending it ends everything it started, even what
 * outlived it; and whatever is still running when the daemon exits goes with it.
 */
const live = new Set<ChildProcess>();
const WINDOWS = process.platform === 'win32';

/** spawn(), with the child leading a process group of its own (on Windows, a tree taskkill reaches). */
export function spawnTree(bin: string, args: string[], opts: SpawnOptions & { keepOrphans?: boolean }): ChildProcessWithoutNullStreams {
  const { keepOrphans, ...rest } = opts;
  const proc = spawn(bin, args, { ...rest, detached: !WINDOWS });
  live.add(proc);
  proc.once('exit', () => {
    live.delete(proc);
    // Once a CLI is gone, whatever it left behind in its group goes too. A command an agent runs
    // (keepOrphans) may mean to leave a server running: that goes when the agent's session ends.
    if (keepOrphans) return;
    signalGroup(proc, 'SIGTERM');
    setTimeout(() => signalGroup(proc, 'SIGKILL'), 2000).unref();
  });
  proc.once('error', () => live.delete(proc));
  // The streams the caller asked for as pipes are there; the others are null.
  return proc as ChildProcessWithoutNullStreams;
}

/**
 * Ends a process and everything under it: closes its stdin (the polite way for these CLIs),
 * then after `graceMs` sends SIGTERM to its group and to descendants that left the group, and
 * SIGKILL two seconds later to whatever is left.
 */
export function endTree(proc: ChildProcess, graceMs = 3000): void {
  proc.stdin?.end();
  // Read while the process lives: once it exits, its children belong to init and can't be traced.
  const tree = descendants(proc.pid);
  const term = setTimeout(() => {
    signalAll(proc, tree, 'SIGTERM');
    setTimeout(() => signalAll(proc, tree, 'SIGKILL'), 2000).unref();
  }, proc.exitCode === null && proc.signalCode === null ? graceMs : 0);
  term.unref();
  // Exited politely: its group and strays still get the signals, without the wait.
  proc.once('exit', () => {
    clearTimeout(term);
    signalAll(proc, tree, 'SIGTERM');
    setTimeout(() => signalAll(proc, tree, 'SIGKILL'), 2000).unref();
  });
}

/** Resolves once every tracked process has exited, or after `ms`. */
export async function settle(ms: number): Promise<void> {
  const waits = [...live].map(p => new Promise<void>(res => (p.exitCode !== null || p.signalCode !== null ? res() : p.once('exit', () => res()))));
  await Promise.race([Promise.all(waits), new Promise(res => setTimeout(res, ms).unref())]);
}

/** How many tracked processes are running (for tests). */
export function liveCount(): number {
  return live.size;
}

/** Kills every tracked tree now. Runs as the daemon exits, so it's synchronous. */
export function killAll(): void {
  for (const p of live) signalAll(p, descendants(p.pid), 'SIGKILL');
  live.clear();
}
process.once('exit', killAll);

function signalAll(proc: ChildProcess, tree: number[], sig: NodeJS.Signals): void {
  if (WINDOWS) {
    if (proc.pid && sig === 'SIGKILL') try { execFileSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore' }); } catch { /* gone */ }
    return;
  }
  signalGroup(proc, sig);
  for (const pid of tree) {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone.
    }
  }
}

function signalGroup(proc: ChildProcess, sig: NodeJS.Signals): void {
  if (WINDOWS || !proc.pid) return;
  try {
    process.kill(-proc.pid, sig);
  } catch {
    // The group is empty.
  }
}

/** Every process under `pid`, from one `ps` listing; [] when ps isn't there. */
export function descendants(pid?: number): number[] {
  if (!pid || WINDOWS) return [];
  let out: string;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
  } catch {
    return [];
  }
  const kids = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (c && p) kids.set(p, [...(kids.get(p) ?? []), c]);
  }
  const found: number[] = [];
  const stack = [...(kids.get(pid) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    found.push(c);
    stack.push(...(kids.get(c) ?? []));
  }
  return found;
}
