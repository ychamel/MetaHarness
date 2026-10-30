import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { eventLine } from './format.ts';
import type { MhEvent } from './types.ts';

const HOME = process.env.MH_HOME ?? join(homedir(), '.metaharness');
const PORT = Number(process.env.MH_PORT ?? 7777);
const BASE = `http://127.0.0.1:${PORT}`;

const HELP = `mh: run a team of AI agents from different providers on one goal

  mh ui                              Open the web app (the daemon serves it), signed in with the token,
                                     on this folder's project if it is one
  mh project [<folder>]              Open a folder (default: this one) as a project and show it in the app.
                                     A folder with its own .metaharness setup asks you to trust it first
  mh projects                        The projects: folders you opened, and those past goals worked in
  mh doctor                          Which harnesses are here, signed in, with which models; can each role run?
  mh test <harness> [--model <m>]    Check what works with a harness here: a short run on a cheap model
  mh daemon [--fake] [--no-resume]   Start the daemon, one for every project (--fake: scripted agents, no
                                     model calls). It picks up goals left running, unless --no-resume
  mh run "<request>" [--lead <role>] [--workflow <name>] [--trust]
                                     Start a goal in this folder's project (the git repository it's in,
                                     opened as a project if it isn't one yet); the lead role defaults to
                                     architect. Without --workflow, the lead picks one of
                                     .metaharness/workflows/
  mh status [<goal>]                 Show agents and what they're doing
  mh tail [<goal>]                   Follow everything that happens, live
  mh send <to> <message> [--urgent] [--goal <id>]
                                     Message an agent, a role, lead or all
  mh stop <agent> [--goal <id>]      Stop an agent
  mh pause|resume [<agent>] [--goal <id>]
                                     Pause an agent (or, without one, the whole goal) once its current
                                     step finishes; messages wait until it's resumed
  mh end [<goal>]                    Stop every agent on a goal and clean up its worktrees
  mh spawn <role> <brief> [--parent <agent>] [--name <n>] [--worktree] [--goal <id>]
                                     Start an agent yourself; its result comes to you (or to --parent)
  mh respawn <agent> [<note>] [--fresh] [--on <harness/model>] [--goal <id>]
                                     Start a crashed agent again under its name: its session resumes,
                                     or with --fresh (or --on another of its role's routes) starts over
                                     from a handoff. The crashed one is kept as <agent>-crashed
  mh open <agent> [--goal <id>]      The command that opens an agent's session in its own harness
  mh clean [<goal>] [--force]        Worktrees and merged branches go when a goal's lead finishes; this
                                     retries for finished goals. What was kept (uncommitted or
                                     unmerged work) goes only with a goal and --force
  mh approve <item> [<note>]         Approve a permission request or a decision from your Inbox
  mh deny <item> [<reason>]          Deny it; the agent gets the reason (for a decision: what to change)
  mh dismiss <item>                  Clear an Inbox item

Environment: MH_HOME (default ~/.metaharness), MH_PORT (default 7777)`;

/** Personal config, then this folder's, as a goal here reads them. */
function configDirs(): string[] {
  return [HOME, join(process.cwd(), '.metaharness')];
}

/** The folder a project here starts from: the top of the git repository this folder is in, else the folder. */
async function projectFolder(path = process.cwd()): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || path;
  } catch {
    return path;
  }
}

/**
 * Opens a folder as a project in the daemon. A folder with its own setup is shown first and
 * opened once you say yes (or with --trust); returns the project's id.
 */
async function openProject(path: string | undefined, trust: boolean): Promise<{ id: string; dir: string }> {
  const { resolve } = await import('node:path');
  const dir = path ? resolve(path) : await projectFolder();
  let r = await command({ cmd: 'project.open', dir, trust });
  if (r.needsTrust) {
    const s = r.setup;
    console.log(`${r.dir} has its own MetaHarness setup, which agents there would use:`);
    for (const [what, list] of [['roles', s.roles], ['workflows', s.workflows], ['rules', s.rules], ['harness profiles', s.harnesses]] as const) if (list.length) console.log(`  ${what}: ${list.join(', ')}`);
    for (const m of s.mcp) console.log(`  MCP server ${m.name}: runs ${m.command}`);
    if (!process.stdin.isTTY) die('Trust it with --trust if you know where it comes from.');
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const yes = /^y(es)?$/i.test((await rl.question('Trust this folder and open it? [y/N] ')).trim());
    rl.close();
    if (!yes) die('Not opened.');
    r = await command({ cmd: 'project.open', dir, trust: true });
  }
  if (r.nested?.inside) console.log(`Note: this folder is inside the project ${r.nested.inside}; that project's agents can read it.`);
  if (r.nested?.contains?.length) console.log(`Note: the projects ${r.nested.contains.join(', ')} are inside this folder; this project's agents can read them.`);
  return { id: r.project.id, dir: r.project.dir };
}

/** Opens the web app, signed in, at a place in it. */
async function openApp(hash = ''): Promise<void> {
  // The token rides in the address once; the app keeps it for the tab and drops it from the URL.
  const url = `${BASE}/?token=${token()}${hash}`;
  console.log(`MetaHarness: ${url}`);
  const { spawn } = await import('node:child_process');
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parse(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !['fake', 'urgent', 'no-resume', 'force', 'worktree', 'trust'].includes(key)) {
        opt[key] = next;
        i++;
      } else opt[key] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function token(create = false): string {
  const p = join(HOME, 'token');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  if (!create) die(`There's no token at ${p}. Start the daemon first: mh daemon`);
  mkdirSync(HOME, { recursive: true });
  const t = randomBytes(24).toString('hex');
  writeFileSync(p, t, { mode: 0o600 });
  return t;
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  let r: Response;
  try {
    r = await fetch(BASE + path, { ...init, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' } });
  } catch {
    die(`Can't reach the daemon at ${BASE}. Start it with: mh daemon`);
  }
  const body = await r.json();
  if (!r.ok) die(body.error ?? r.statusText);
  return body;
}

const command = (body: Record<string, unknown>) => api('/commands', { method: 'POST', body: JSON.stringify(body) });

async function printStatus(goalId?: string): Promise<void> {
  const s = await api('/state' + (goalId ? `?goal=${encodeURIComponent(goalId)}` : ''));
  if (!s.goals.length) return void console.log('No goals yet. Start one with: mh run "<request>"');
  for (const g of s.goals) {
    console.log(`\nGoal ${g.id} · ${g.status} · ${g.request}`);
    console.log(`  shared folder: ${g.sharedDir}`);
    if (g.branch) console.log(`  goal branch:   ${g.branch}`);
    if (g.notice) console.log(`  note: ${g.notice}`);
    // Model names vary a lot in length (gemini-3.8-flash-low), so size the column to fit.
    const whereWidth = Math.max(28, ...g.agents.map((a: { harness: string; model: string }) => `${a.harness} · ${a.model}`.length + 2));
    const byParent = new Map<string, any[]>();
    for (const a of g.agents) byParent.set(a.parent, [...(byParent.get(a.parent) ?? []), a]);
    const walk = (parent: string, depth: number) => {
      for (const a of byParent.get(parent) ?? []) {
        const name = ('  '.repeat(depth) + a.name).padEnd(22);
        const what = `${a.role}${a.quick ? ' (helper)' : ''}`.padEnd(20);
        const where = `${a.harness} · ${a.model}`.padEnd(whereWidth);
        const unread = (a.unread ? ` [${a.unread} unread]` : '') + (a.awaitingApproval ? ' [needs your approval]' : '');
        const cost = a.cost == null ? '     —' : `$${a.cost.toFixed(3)}`;
        const until = a.limitedUntil ? ` [rate limited until ${new Date(a.limitedUntil).toTimeString().slice(0, 5)}]` : '';
        // A finished agent's last status line is out of date; its note says what it did.
        const line = a.state === 'done' || a.state === 'ended' ? '' : a.status;
        console.log(`  ${name}${what}${where}${a.state.padEnd(9)}${cost}  ${line}${unread}${until}`);
        walk(a.name, depth + 1);
      }
    };
    walk('human', 0);
  }
  const accounts = (s.accounts ?? []).filter((a: { status: string; usedPct: number | null }) => a.status !== 'ok' || (a.usedPct ?? 0) > 0);
  if (accounts.length) {
    console.log('\nAccounts:');
    for (const a of accounts) {
      const used = a.usedPct != null ? `${a.usedPct}% used` : '';
      const resets = a.resetsAt ? `resets ${new Date(a.resetsAt).toTimeString().slice(0, 5)}` : '';
      console.log(`  ${a.id.padEnd(14)}${a.status.padEnd(9)}${[used, a.window, resets].filter(Boolean).join(' · ')}`);
    }
  }
  if (s.inbox.length) {
    console.log(`\nFor you (${s.inbox.length}):`);
    for (const i of s.inbox) console.log(`  ${i.id}  [${i.kind}] ${i.agent}: ${String(i.text).replace(/\n/g, '\n            ')}`);
    if (s.inbox.some((i: { kind: string }) => i.kind === 'approval' || i.kind === 'decision')) console.log('  Answer with: mh approve <id> [note]  or  mh deny <id> [reason or what to change]');
  }
}

async function tail(goalId?: string): Promise<void> {
  const qs = goalId ? `?goal=${encodeURIComponent(goalId)}` : '';
  let r: Response;
  try {
    r = await fetch(`${BASE}/events${qs}`, { headers: { authorization: `Bearer ${token()}` } });
  } catch {
    die(`Can't reach the daemon at ${BASE}. Start it with: mh daemon`);
  }
  if (!r.ok || !r.body) die(`The daemon refused: ${r.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').find(l => l.startsWith('data: '));
      if (!data) continue;
      const line = eventLine(JSON.parse(data.slice(6)) as MhEvent);
      if (line) console.log(line);
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  const s = (k: string) => (typeof opt[k] === 'string' ? (opt[k] as string) : undefined);
  switch (cmd) {
    case 'daemon': {
      const { Daemon } = await import('./daemon.ts');
      const { FakeAdapter, demoScripts, demoTurns } = await import('./adapters/fake.ts');
      const { ClaudeAdapter } = await import('./adapters/claude.ts');
      const { CodexAdapter } = await import('./adapters/codex.ts');
      const { AgyAdapter } = await import('./adapters/agy.ts');
      const { AcpAdapter } = await import('./adapters/acp.ts');
      const { loadProfiles, findBin } = await import('./harnesses.ts');
      const { startServer } = await import('./server.ts');
      const fake = opt.fake === true;
      // One adapter per profile MetaHarness can drive and that is installed here (built-in and personal
      // profiles: the daemon serves every project).
      const adapters: Record<string, import('./adapters/types.ts').HarnessAdapter> = { fake: new FakeAdapter(demoScripts, {}, demoTurns) };
      for (const p of loadProfiles([HOME]).values()) {
        const bin = p.transport && findBin(p.bin);
        if (!bin) continue;
        if (p.transport === 'claude-stream') adapters[p.id] = new ClaudeAdapter({ id: p.id, bin, env: p.env });
        else if (p.transport === 'codex-app-server') adapters[p.id] = new CodexAdapter({ bin });
        else if (p.transport === 'agy-stream') adapters[p.id] = new AgyAdapter({ id: p.id, bin, isolate: join(HOME, 'homes', p.id) });
        else if (p.transport === 'acp') adapters[p.id] = new AcpAdapter({ id: p.id, bin, args: p.args ?? [], env: p.env, openCommand: p.openCommand });
      }
      // Agents don't need to know where MetaHarness keeps its data (design §22).
      delete process.env.MH_HOME;
      delete process.env.MH_PORT;
      const d = new Daemon({ home: HOME, adapters, harnessOverride: fake ? 'fake' : undefined });
      await startServer(d, PORT, token(true)).catch((e: Error) => die(`Couldn't listen on ${BASE}: ${e.message}`));
      if (!fake) d.startLimitChecks();
      console.log(`MetaHarness daemon on ${BASE}${fake ? ', running scripted agents' : ''}. Data in ${HOME}.`);
      const projects = d.listProjects().filter(p => p.opened);
      console.log(projects.length ? `Projects: ${projects.map(p => p.dir).join(', ')}` : 'No projects yet: mh project <folder>, or Open folder in the app.');
      const { guardProblem } = await import('./guard.ts');
      const guard = guardProblem();
      if (guard) console.log(`Warning: ${guard}. Git 2.28 or newer keeps agents from deleting branches.`);
      if (!fake) console.log(`Harnesses: ${Object.keys(adapters).filter(h => h !== 'fake').join(', ') || 'none found'}. mh doctor shows what each role can use.`);
      for (const r of opt['no-resume'] === true ? [] : d.recover()) {
        const what = `goal ${r.goal} (${r.request.replace(/\s+/g, ' ').slice(0, 60)})`;
        if (r.skipped) console.log(`Left ${what} as it was: ${r.skipped}.`);
        else console.log(`Picked up ${what}: ${r.resumed.length ? `${r.resumed.join(', ')} continue` : 'nobody was mid-task'}${r.later.length ? `; ${r.later.join(', ')} resume when messaged` : ''}.`);
      }
      const shutdown = () => void d.close().then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }
    case 'doctor': {
      const { loadProfiles, inspect } = await import('./harnesses.ts');
      const { loadConfig } = await import('./config.ts');
      const { doctorLines } = await import('./doctor.ts');
      console.log('Checking harnesses (this runs each CLI\'s own version, login and model commands)…\n');
      const reports = await Promise.all([...loadProfiles(configDirs()).values()].map(inspect));
      const cfg = loadConfig(configDirs());
      for (const line of doctorLines(reports, [...cfg.roles.values()], cfg.mcp)) console.log(line);
      return;
    }
    case 'test': {
      const harness = pos[0];
      if (!harness) die('Usage: mh test <harness> [--model <model>]. mh doctor lists the harnesses.');
      const { loadProfiles } = await import('./harnesses.ts');
      const model = s('model') ?? loadProfiles(configDirs()).get(harness)?.probeModel ?? '';
      console.log(`Testing ${harness}${model ? ` on ${model}` : ''}. This takes a minute or two and a few small turns…`);
      const r = await command({ cmd: 'harness.test', harness, model });
      for (const c of r.checks) console.log(`  ${c.ok === true ? '✓' : c.ok === false ? '✗' : '?'} ${c.name.padEnd(28)} ${c.detail}`);
      console.log(`\n${r.seconds}s${r.cost != null ? `, $${r.cost.toFixed(4)}` : ''}.`);
      return;
    }
    case 'run': {
      const request = pos.join(' ').trim();
      if (!request) die('Say what the goal is: mh run "<request>"');
      const project = await openProject(undefined, opt.trust === true);
      const r = await command({ cmd: 'goal.start', request, project: project.id, lead: s('lead'), workflow: s('workflow') ?? s('playbook') });
      console.log(`Started goal ${r.goal} in ${project.dir}. Follow it with: mh tail ${r.goal}`);
      if (r.notice) console.log(`Note: ${r.notice}`);
      return;
    }
    case 'ui': {
      // On this folder's project, when it's one already; else wherever the app was.
      const here = await projectFolder();
      const { projects } = await command({ cmd: 'project.list' });
      const p = (projects as { id: string; dir: string; opened: boolean }[]).find(x => x.opened && x.dir === here);
      return openApp(p ? `#page=home&project=${p.id}` : '');
    }
    case 'project': {
      const p = await openProject(pos[0], opt.trust === true);
      console.log(`Opened ${p.dir}.`);
      return openApp(`#page=home&project=${p.id}`);
    }
    case 'projects': {
      const { projects } = await command({ cmd: 'project.list' });
      if (!projects.length) return void console.log('No projects yet. Open one with: mh project <folder>');
      for (const p of projects) {
        const what = [p.goals && `${p.goals} goal${p.goals > 1 ? 's' : ''}`, p.rooms && `${p.rooms} room${p.rooms > 1 ? 's' : ''}`, p.running && `${p.running} running`, p.needs && `${p.needs} waiting on you`].filter(Boolean).join(', ');
        console.log(`${p.id}  ${p.dir}${p.opened ? '' : '  (past goals only)'}${p.exists ? '' : '  (gone)'}${what ? `  · ${what}` : ''}`);
      }
      return;
    }
    case 'status':
      return printStatus(pos[0]);
    case 'tail':
      return tail(pos[0]);
    case 'send': {
      const [to, ...words] = pos;
      if (!to || !words.length) die('Usage: mh send <to> <message>');
      const r = await command({ cmd: 'agent.message', to, text: words.join(' '), urgent: opt.urgent === true, goal: s('goal') });
      console.log(r.result);
      return;
    }
    case 'stop': {
      if (!pos[0]) die('Usage: mh stop <agent>');
      const r = await command({ cmd: 'agent.stop', agent: pos[0], goal: s('goal') });
      console.log(r.result);
      return;
    }
    case 'clean': {
      const r = await command({ cmd: 'goal.clean', goal: pos[0], force: opt.force === true });
      for (const line of r.refused) console.log(line);
      if (!r.results.length && !r.refused.length) console.log(pos[0] ? `Nothing to clean for goal ${pos[0]}.` : 'Nothing to clean.');
      const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
      for (const g of r.results) {
        const did = [g.removed.length && `removed ${n(g.removed.length, 'worktree', 'worktrees')}`, g.deleted.length && `deleted ${n(g.deleted.length, 'branch', 'branches')}`].filter(Boolean);
        console.log(`Goal ${g.goal} (${g.request.replace(/\s+/g, ' ').slice(0, 50)}): ${did.join(', ') || 'nothing removed'}.`);
        for (const k of g.kept) console.log(`  kept ${k}`);
      }
      if (r.results.some((g: { kept: string[] }) => g.kept.length) && opt.force !== true) console.log('Add --force to remove what was kept too.');
      return;
    }
    case 'pause':
    case 'resume': {
      const r = pos[0]
        ? await command({ cmd: `agent.${cmd}`, agent: pos[0], goal: s('goal') })
        : await command({ cmd: `goal.${cmd}`, goal: s('goal') });
      console.log(r.result);
      return;
    }
    case 'end': {
      const r = await command({ cmd: 'goal.end', goal: pos[0] ?? s('goal') });
      console.log(r.result);
      return;
    }
    case 'spawn': {
      const [role, ...words] = pos;
      if (!role || !words.length) die('Usage: mh spawn <role> <brief> [--parent <agent>] [--name <n>] [--worktree]');
      const r = await command({ cmd: 'agent.spawn', role, brief: words.join(' '), parent: s('parent'), name: s('name'), worktree: opt.worktree === true ? true : undefined, goal: s('goal') });
      console.log(r.result);
      return;
    }
    case 'respawn': {
      if (!pos[0]) die('Usage: mh respawn <agent> [--fresh] [--on <harness/model>] [<note>]');
      const r = await command({ cmd: 'agent.respawn', agent: pos[0], fresh: opt.fresh === true, on: s('on'), note: pos.slice(1).join(' ') || undefined, goal: s('goal') });
      console.log(r.result);
      return;
    }
    case 'open': {
      if (!pos[0]) die('Usage: mh open <agent>');
      const r = await command({ cmd: 'agent.open_native', agent: pos[0], goal: s('goal') });
      if (r.command) console.log(r.command);
      console.error(r.note);
      return;
    }
    case 'approve':
    case 'deny':
    case 'dismiss': {
      if (!pos[0]) die(`Usage: mh ${cmd} <item>. mh status lists Inbox items.`);
      const r = await command({ cmd: 'inbox.resolve', item: pos[0], decision: cmd, reply: pos.slice(1).join(' ') || undefined });
      console.log(r.result);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return void console.log(HELP);
    default:
      die(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

await main();
