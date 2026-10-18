import { resolveName } from './fuzzy.ts';
import type { AgentRec, Daemon, InboxEntry } from './daemon.ts';

export const TOOL_NAMES = ['team', 'spawn', 'send', 'wait', 'status', 'done', 'workflow'] as const;

/** Descriptions the MCP layer will publish. Written for the agents that read them. */
export const TOOL_DOCS: Record<(typeof TOOL_NAMES)[number], { description: string; params: Record<string, string> }> = {
  team: { description: "See who's on the team, what each agent is doing, and which roles you can spawn.", params: {} },
  spawn: {
    description: 'Start a teammate in a role. With quick: true, wait for its answer and get it back directly.',
    params: {
      role: 'Role name, e.g. implementer or scout',
      brief: 'What they should do, what is done already, where to look, what you want back',
      quick: 'true for a quick helper',
      name: 'Optional name',
      worktree: "true to give them their own git worktree and branch, for code written in parallel with others. Default: they work in the shared folder, like everyone else",
      from: "Optional: a teammate (or branch) whose latest commit their own worktree starts from, e.g. the implementer whose code a reviewer checks. Implies worktree",
    },
  },
  send: {
    description: 'Send a short message to a teammate (by name or role), to lead, to all, or to human.',
    params: {
      to: 'Recipient',
      text: 'The message',
      urgent: 'true to interrupt them',
      decision: 'With to: human, true to ask for an approval (e.g. of a design). Say what to approve and where it is; the answer arrives as a message',
    },
  },
  wait: {
    description: 'Pause until a message arrives or a teammate you spawned finishes. timeout 0 just checks.',
    params: { timeout: 'Seconds to wait (default 60)' },
  },
  status: { description: 'Post a one-line progress update for the human and your teammates.', params: { text: 'What you are doing now' } },
  done: { description: "Say you're finished. The note goes to whoever spawned you.", params: { note: 'What you did and where it is' } },
  workflow: {
    description: 'Read a workflow: a guide for running a kind of task, e.g. the next one a workflow says to continue with. Without a name, lists them.',
    params: { name: 'Workflow name (optional)' },
  },
};

type Args = Record<string, unknown>;

/** Accepts whatever shape an agent sends: an object, a JSON string, or plain text. */
function normalizeArgs(raw: unknown): Args {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Args;
    } catch {
      /* plain text */
    }
    return { text: raw };
  }
  return typeof raw === 'object' ? (raw as Args) : { text: String(raw) };
}

function pick(a: Args, ...keys: string[]): unknown {
  const lower = new Map(Object.entries(a).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) {
    const v = lower.get(k);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
const str = (v: unknown) => (v === undefined ? undefined : String(v).trim() || undefined);
const truthy = (v: unknown) => v === true || /^(true|yes|1|y)$/i.test(String(v ?? ''));

function formatWait(entries: InboxEntry[]): string {
  const msgs = entries.filter(e => e.kind === 'message');
  const done = entries.filter(e => e.kind === 'done');
  const notices = entries.filter(e => e.kind === 'notice');
  const out: string[] = [];
  if (notices.length) out.push('From MetaHarness:\n' + notices.map(n => `- ${n.text}`).join('\n'));
  if (msgs.length) out.push('Messages:\n' + msgs.map(m => `- from ${m.from}${m.urgent ? ' (urgent)' : ''}: ${m.text}`).join('\n'));
  if (done.length) out.push('Finished:\n' + done.map(d => `- ${d.from}: ${d.text}`).join('\n'));
  return out.join('\n\n');
}

/** The six agent tools. Every answer is plain language, and nothing an agent sends is rejected outright. */
export class Hub {
  private d: Daemon;

  constructor(d: Daemon) {
    this.d = d;
  }

  async call(goal: string, agent: string, toolName: string, raw: unknown): Promise<string> {
    const rec = this.d.agent(goal, agent);
    if (!rec) return `MetaHarness doesn't know an agent called ${agent} in goal ${goal}.`;
    const bare = String(toolName).replace(/^mcp__[^_]+__/, '');
    const r = resolveName(bare, [...TOOL_NAMES]);
    if (!r.match) return `There's no tool called "${toolName}". The tools are: ${TOOL_NAMES.join(', ')}.`;
    const a = normalizeArgs(raw);
    let out: string;
    try {
      out = await this.run(rec, r.match as (typeof TOOL_NAMES)[number], a);
    } catch (e) {
      out = `That didn't work: ${(e as Error).message}`;
    }
    if (r.guessed) out = `(Used ${r.match} for "${toolName}".)\n${out}`;
    if (r.match !== 'wait') out += this.unreadNotice(rec);
    const files = this.d.takeFileNotes(rec);
    if (files) out += `\n\n${files}`;
    return out;
  }

  private unreadNotice(rec: AgentRec): string {
    const n = rec.inbox.length;
    if (!n) return '';
    const from = [...new Set(rec.inbox.map(e => e.from))].join(', ');
    return `\n\n(You have ${n} unread message${n > 1 ? 's' : ''} from ${from}. Call wait with timeout 0 to read ${n > 1 ? 'them' : 'it'}.)`;
  }

  private async run(rec: AgentRec, tool: (typeof TOOL_NAMES)[number], a: Args): Promise<string> {
    const d = this.d;
    switch (tool) {
      case 'team':
        return this.team(rec);

      case 'spawn': {
        const role = str(pick(a, 'role', 'agent', 'type', 'kind', 'as'));
        if (!role) return `spawn needs a role. Roles you can spawn: ${d.teamRoles().map(r => r.name).join(', ')}.`;
        const brief = str(pick(a, 'brief', 'task', 'prompt', 'text', 'message', 'instructions', 'description'))
          ?? '(No brief was given. Ask whoever spawned you what they need.)';
        const name = str(pick(a, 'name', 'id'));
        if (truthy(pick(a, 'quick', 'helper', 'blocking'))) return (await d.quickSpawn(rec, role, brief, name)).text;
        const from = str(pick(a, 'from', 'base', 'branch', 'start_from', 'starting_from'));
        const wt = pick(a, 'worktree', 'own_worktree', 'isolated', 'isolation');
        const worktree = wt === undefined ? undefined : truthy(wt) || /^worktree$/i.test(String(wt));
        const r = d.spawnAgent(rec.goal, { role, brief, parent: rec.name, name, from, worktree });
        if (!r.ok) return r.error;
        const guessed = r.guessedRole ? `(Took "${role}" to mean ${r.guessedRole}.) ` : '';
        const where = r.rec.worktree ? ` in its own worktree on branch ${r.rec.worktree.branch}, from ${r.rec.worktree.base.slice(0, 7)}` : ' in the shared folder';
        const backup = r.note ? ` ${r.note}` : '';
        return `${guessed}Started ${r.name} (${r.rec.harness} · ${r.rec.model})${where}.${backup} Its result will reach you when it calls done; use wait to block until then.`;
      }

      case 'send': {
        const to = str(pick(a, 'to', 'recipient', 'agent', 'target', 'who'));
        const text = str(pick(a, 'text', 'message', 'content', 'body', 'msg'));
        if (!to) return 'send needs "to": a teammate name, a role, lead, all, or human.';
        if (!text) return 'send needs some text.';
        return d.deliver(rec.goal, rec.name, to, text, truthy(pick(a, 'urgent', 'interrupt')), truthy(pick(a, 'decision', 'approval', 'approve')));
      }

      case 'wait': {
        const t = Number(pick(a, 'timeout', 'seconds', 'timeout_s', 'secs'));
        const timeout = Number.isFinite(t) ? Math.min(Math.max(t, 0), 600) : 60;
        const entries = await d.wait(rec, timeout);
        if (entries.length) return formatWait(entries);
        return timeout === 0 ? 'Nothing new.' : `Nothing new after ${timeout}s.`;
      }

      case 'status': {
        const text = str(pick(a, 'text', 'status', 'message', 'update'));
        if (!text) return 'status needs a short line of text.';
        d.status(rec, text);
        return 'Status posted.';
      }

      case 'workflow': {
        const want = str(pick(a, 'name', 'workflow', 'text'));
        const names = [...d.config.workflows.keys()];
        const list = () => [...d.config.workflows.values()].map(w => `- ${w.name}: ${w.goodAt || '—'}`).join('\n');
        if (!names.length) return 'There are no workflows yet (.metaharness/workflows/<name>.md).';
        if (!want) return `Workflows:\n${list()}\n\nRead one with workflow(name).`;
        const r = resolveName(want, names);
        if (!r.match) return `There's no workflow called "${want}". Workflows:\n${list()}`;
        const w = d.config.workflows.get(r.match)!;
        return `${r.guessed ? `(Took "${want}" to mean ${w.name}.)\n` : ''}# Workflow: ${w.name}\n\n${w.body}`;
      }

      case 'done': {
        const note = str(pick(a, 'note', 'summary', 'text', 'result', 'message', 'answer')) ?? (rec.lastText || '(no note)');
        const again = rec.doneNote !== undefined;
        const warning = d.done(rec, note);
        const ok = again ? 'Updated your note. Whoever spawned you has the new one.' : rec.parent === 'human' ? 'Done. The human has your note.' : `Done. ${rec.parent} has your note.`;
        return warning ? `${ok}\n\n${warning}` : ok;
      }
    }
  }

  private team(rec: AgentRec): string {
    const g = this.d.goals.get(rec.goal)!;
    const lines = [`Goal: ${g.request}`, `Shared folder: ${g.sharedDir}`, '', 'Team:'];
    for (const a of g.agents.values()) {
      const by = a.parent === 'human' ? 'the human' : a.parent;
      const what = a.status ? `: ${a.status}` : '';
      const you = a.name === rec.name ? '  ← you' : '';
      lines.push(`- ${a.name} (${a.role.name} · ${a.harness} · ${a.model}), spawned by ${by}, ${a.state}${what}${you}`);
    }
    lines.push('', 'Roles you can spawn:');
    for (const r of this.d.teamRoles()) lines.push(`- ${r.name}${r.helper ? ' (quick helper)' : ''}: ${r.goodAt || '—'}`);
    return lines.join('\n');
  }
}
