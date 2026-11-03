import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Harness CLIs and what they start (shells, dev servers, MCP servers) as one tree each. Each CLI
 * runs in a process group of its own, so ending it ends everything it started, even what
 * outlived it; and whatever is still running when the daemon exits goes with it. What left the
 * group and the tree (setsid, a double fork) is found by the MH_GOAL its environment still has
 * (tagged).
 */
const live = new Set<ChildProcess>();
const WINDOWS = process.platform === 'win32';

/**
 * How to start `bin` with `args`. Windows won't start a .cmd or .bat (npm's shims, codex.cmd)
 * without cmd.exe, so those go through it, each argument quoted and its metacharacters escaped
 * twice: once for cmd.exe, once more for the shim passing %* on (as cross-spawn does).
 */
export function launch(bin: string, args: string[], windows = WINDOWS): { bin: string; args: string[]; verbatim?: boolean } {
  if (!windows || !/\.(cmd|bat)$/i.test(bin)) return { bin, args };
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  const quote = (a: string) => `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(meta, '^$1').replace(meta, '^$1');
  const line = [bin.replace(meta, '^$1'), ...args.map(quote)].join(' ');
  return { bin: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/** spawn(), with the child leading a process group of its own (on Windows, a tree taskkill reaches). */
export function spawnTree(bin: string, args: string[], opts: SpawnOptions & { keepOrphans?: boolean }): ChildProcessWithoutNullStreams {
  const { keepOrphans, ...rest } = opts;
  const l = rest.shell ? { bin, args } : launch(bin, args);
  const proc = spawn(l.bin, l.args, { ...rest, detached: !WINDOWS, ...(l.verbatim && { windowsVerbatimArguments: true }) });
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

/** Each process's parent, from one `ps` listing; empty when ps isn't there. */
function parents(): Map<number, number> {
  const out = new Map<number, number>();
  if (WINDOWS) return out;
  let text: string;
  try {
    text = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (c && p) out.set(c, p);
  }
  return out;
}

/** Every process under `pid`, from one `ps` listing; [] when ps isn't there. */
export function descendants(pid?: number): number[] {
  if (!pid || WINDOWS) return [];
  const kids = new Map<number, number[]>();
  for (const [c, p] of parents()) kids.set(p, [...(kids.get(p) ?? []), c]);
  const found: number[] = [];
  const stack = [...(kids.get(pid) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    found.push(c);
    stack.push(...(kids.get(c) ?? []));
  }
  return found;
}

/** A process an agent started, found by the MH_GOAL and MH_AGENT its harness passed down. */
export interface Tagged {
  pid: number;
  goal: string;
  agent: string;
  command: string;
}

/**
 * Every process whose environment has MH_GOAL for one of `goals`, wherever it is now: the
 * environment outlives setsid and double forks, which leave the group and the tree. Never this
 * process or what runs it. Linux reads /proc and macOS asks ps; elsewhere there's no telling, so [].
 */
export function tagged(goals: Set<string>): Tagged[] {
  if (!goals.size || WINDOWS) return [];
  const up = parents();
  const mine = new Set<number>();
  for (let p: number | undefined = process.pid; p && !mine.has(p); p = up.get(p)) mine.add(p);
  return (process.platform === 'linux' ? fromProc() : fromPs()).filter(p => !mine.has(p.pid) && goals.has(p.goal));
}

/**
 * Ends tagged processes: SIGTERM now, SIGKILL two seconds later to those still tagged then (so
 * a PID the system gave to something else meanwhile is spared).
 */
export function endTagged(found: Tagged[]): void {
  const signal = (pids: number[], sig: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {
        // Already gone.
      }
    }
  };
  signal(found.map(p => p.pid), 'SIGTERM');
  setTimeout(() => {
    const was = new Set(found.map(p => `${p.pid} ${p.goal} ${p.agent}`));
    signal(tagged(new Set(found.map(p => p.goal))).filter(p => was.has(`${p.pid} ${p.goal} ${p.agent}`)).map(p => p.pid), 'SIGKILL');
  }, 2000).unref();
}

function fromProc(): Tagged[] {
  const out: Tagged[] = [];
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter(n => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const pid of pids) {
    let env: string;
    try {
      // Another user's processes can't be read, and aren't ours to end.
      env = readFileSync(`/proc/${pid}/environ`, 'latin1');
    } catch {
      continue;
    }
    if (!env.includes('MH_GOAL=')) continue;
    const vars = new Map(env.split('\0').map(v => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]));
    let command = '';
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch {
      // Gone since.
    }
    out.push({ pid: Number(pid), goal: vars.get('MH_GOAL') ?? '', agent: vars.get('MH_AGENT') ?? '', command: command.slice(0, 200) });
  }
  return out;
}

/** macOS: ps -E puts a process's environment after its command line (for this user's processes). */
function fromPs(): Tagged[] {
  let text: string;
  try {
    text = execFileSync('ps', ['-A', '-E', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 << 20 });
  } catch {
    return [];
  }
  const out: Tagged[] = [];
  for (const line of text.split('\n')) {
    const goal = / MH_GOAL=(\S+)/.exec(line)?.[1];
    if (!goal) continue;
    const [, pid, rest] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
    if (!pid) continue;
    // The command ends where the environment starts, at the first NAME=value word.
    const command = rest.split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/)[0];
    out.push({ pid: Number(pid), goal, agent: / MH_AGENT=(\S+)/.exec(line)?.[1] ?? '', command: command.slice(0, 200) });
  }
  return out;
}
