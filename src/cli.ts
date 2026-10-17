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

  mh daemon [--fake]                 Start the daemon (--fake: scripted agents, no model calls)
  mh run "<request>" [--lead <role>] [--playbook <name>]
                                     Start a goal; the lead role defaults to architect
  mh status [<goal>]                 Show agents and what they're doing
  mh tail [<goal>]                   Follow everything that happens, live
  mh send <to> <message> [--urgent] [--goal <id>]
                                     Message an agent, a role, lead or all
  mh stop <agent> [--goal <id>]      Stop an agent
  mh approve <item> [<note>]         Approve a permission request from your Inbox
  mh deny <item> [<reason>]          Deny it; the agent gets the reason
  mh dismiss <item>                  Clear an Inbox item

Environment: MH_HOME (default ~/.metaharness), MH_PORT (default 7777)`;

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
      if (next !== undefined && !next.startsWith('--') && !['fake', 'urgent'].includes(key)) {
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
    const byParent = new Map<string, any[]>();
    for (const a of g.agents) byParent.set(a.parent, [...(byParent.get(a.parent) ?? []), a]);
    const walk = (parent: string, depth: number) => {
      for (const a of byParent.get(parent) ?? []) {
        const name = ('  '.repeat(depth) + a.name).padEnd(22);
        const what = `${a.role}${a.quick ? ' (helper)' : ''}`.padEnd(20);
        const where = `${a.harness} · ${a.model}`.padEnd(28);
        const unread = (a.unread ? ` [${a.unread} unread]` : '') + (a.awaitingApproval ? ' [needs your approval]' : '');
        const cost = a.cost == null ? '     —' : `$${a.cost.toFixed(3)}`;
        console.log(`  ${name}${what}${where}${a.state.padEnd(9)}${cost}  ${a.status}${unread}`);
        walk(a.name, depth + 1);
      }
    };
    walk('human', 0);
  }
  if (s.inbox.length) {
    console.log(`\nFor you (${s.inbox.length}):`);
    for (const i of s.inbox) console.log(`  ${i.id}  [${i.kind}] ${i.agent}: ${String(i.text).replace(/\n/g, '\n            ')}`);
    if (s.inbox.some((i: { kind: string }) => i.kind === 'approval')) console.log('  Answer with: mh approve <id>  or  mh deny <id> [reason]');
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
      const { startServer } = await import('./server.ts');
      const fake = opt.fake === true;
      const pricesFile = [join(process.cwd(), '.metaharness', 'prices.json'), join(HOME, 'prices.json')].find(existsSync);
      const prices = pricesFile ? JSON.parse(readFileSync(pricesFile, 'utf8')) : {};
      const d = new Daemon({
        home: HOME,
        repo: process.cwd(),
        adapters: {
          fake: new FakeAdapter(demoScripts),
          'claude-code': new ClaudeAdapter(),
          codex: new CodexAdapter({ prices }),
        },
        harnessOverride: fake ? 'fake' : undefined,
      });
      await startServer(d, PORT, token(true)).catch((e: Error) => die(`Couldn't listen on ${BASE}: ${e.message}`));
      console.log(`MetaHarness daemon on ${BASE}${fake ? ', running scripted agents' : ''}. Data in ${HOME}.`);
      console.log(`Roles: ${[...d.config.roles.keys()].join(', ') || 'none (add .metaharness/roles/<name>.md)'}`);
      if (!fake) console.log('Harnesses: claude-code, codex. (antigravity arrives in milestone 1.)');
      const shutdown = () => void d.close().then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }
    case 'run': {
      const request = pos.join(' ').trim();
      if (!request) die('Say what the goal is: mh run "<request>"');
      const r = await command({ cmd: 'goal.start', request, lead: s('lead'), playbook: s('playbook') });
      console.log(`Started goal ${r.goal}. Follow it with: mh tail ${r.goal}`);
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
