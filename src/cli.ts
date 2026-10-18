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

  mh doctor                          Which harnesses are here, signed in, with which models; can each role run?
  mh test <harness> [--model <m>]    Check what works with a harness here: a short run on a cheap model
  mh daemon [--fake] [--no-resume]   Start the daemon (--fake: scripted agents, no model calls). It picks
                                     up goals left running here, unless --no-resume
  mh run "<request>" [--lead <role>] [--workflow <name>]
                                     Start a goal; the lead role defaults to architect. Without
                                     --workflow, the lead picks one of .metaharness/workflows/
  mh status [<goal>]                 Show agents and what they're doing
  mh tail [<goal>]                   Follow everything that happens, live
  mh send <to> <message> [--urgent] [--goal <id>]
                                     Message an agent, a role, lead or all
  mh stop <agent> [--goal <id>]      Stop an agent
  mh approve <item> [<note>]         Approve a permission request or a decision from your Inbox
  mh deny <item> [<reason>]          Deny it; the agent gets the reason (for a decision: what to change)
  mh dismiss <item>                  Clear an Inbox item

Environment: MH_HOME (default ~/.metaharness), MH_PORT (default 7777)`;

/** Personal config, then the repository's, as the daemon reads them. */
function configDirs(): string[] {
  return [HOME, join(process.cwd(), '.metaharness')];
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
      if (next !== undefined && !next.startsWith('--') && !['fake', 'urgent', 'no-resume'].includes(key)) {
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
      const { FakeAdapter, demoScripts } = await import('./adapters/fake.ts');
      const { ClaudeAdapter } = await import('./adapters/claude.ts');
      const { CodexAdapter } = await import('./adapters/codex.ts');
      const { AgyAdapter } = await import('./adapters/agy.ts');
      const { loadProfiles, findBin } = await import('./harnesses.ts');
      const { startServer } = await import('./server.ts');
      const fake = opt.fake === true;
      const pricesFile = [join(process.cwd(), '.metaharness', 'prices.json'), join(HOME, 'prices.json')].find(existsSync);
      const prices = pricesFile ? JSON.parse(readFileSync(pricesFile, 'utf8')) : {};
      // One adapter per profile MetaHarness can drive and that is installed here.
      const adapters: Record<string, import('./adapters/types.ts').HarnessAdapter> = { fake: new FakeAdapter(demoScripts) };
      for (const p of loadProfiles(configDirs()).values()) {
        const bin = p.transport && findBin(p.bin);
        if (!bin) continue;
        if (p.transport === 'claude-stream') adapters[p.id] = new ClaudeAdapter({ id: p.id, bin, env: p.env });
        else if (p.transport === 'codex-app-server') adapters[p.id] = new CodexAdapter({ bin, prices });
        else if (p.transport === 'agy-stream') adapters[p.id] = new AgyAdapter({ id: p.id, bin });
      }
      const d = new Daemon({ home: HOME, repo: process.cwd(), adapters, harnessOverride: fake ? 'fake' : undefined });
      await startServer(d, PORT, token(true)).catch((e: Error) => die(`Couldn't listen on ${BASE}: ${e.message}`));
      console.log(`MetaHarness daemon on ${BASE}${fake ? ', running scripted agents' : ''}. Data in ${HOME}.`);
      console.log(`Roles: ${[...d.config.roles.keys()].join(', ') || 'none (add .metaharness/roles/<name>.md)'}`);
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
      const r = await command({ cmd: 'goal.start', request, lead: s('lead'), workflow: s('workflow') ?? s('playbook') });
      console.log(`Started goal ${r.goal}. Follow it with: mh tail ${r.goal}`);
      if (r.notice) console.log(`Note: ${r.notice}`);
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
