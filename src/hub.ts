import { workflowRoleNames } from './config.ts';
import { resolveName } from './fuzzy.ts';
import { skillList, skillPart, skillSummary } from './skills.ts';
import { parseCanvasOps } from './rooms.ts';
import type { AgentRec, Daemon, InboxEntry } from './daemon.ts';

/** `canvas` and `prototype` are published only to agents in a brainstorm room, and `dismiss` only outside one. */
export const TOOL_NAMES = ['team', 'spawn', 'respawn', 'dismiss', 'send', 'wait', 'status', 'done', 'workflow', 'skill', 'procs', 'canvas', 'prototype'] as const;

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
      tools: 'Optional: tools from the library to put in their kit, by name, e.g. ["sfx-layer", "spectrogram"]. Their prompt spells these out; they can still read any other tool',
    },
  },
  respawn: {
    description: "Start a crashed teammate again under its name, or one whose turn hung (MetaHarness tells you when one has gone silent). By default its session resumes where it stopped. The old one stays on the team as <name>-crashed (or -stalled), with its history.",
    params: {
      name: 'The crashed or hung teammate',
      fresh: 'true to start it over in a new session, from a handoff of where it got to (e.g. when resuming crashes or hangs again)',
      on: "Optional: another harness/model from its role to run it on, e.g. after its harness crashed twice. Implies fresh",
      note: 'Optional: what to tell it, e.g. messages it missed or what changed',
    },
  },
  dismiss: {
    description: "End a finished teammate you won't need again, along with the finished teammates it spawned. Nobody can wake it after that, which saves paying for its whole context if a message reaches it by accident. Its files, commits and notes stay; anything it left running stops. It can't come back: for more of that work, spawn someone new and point them at it.",
    params: {
      name: "The teammate, or several separated by commas, or all for every finished teammate you spawned. Only a teammate's spawner or the lead can dismiss it",
    },
  },
  send: {
    description: "Send a short message to a teammate (by name or role), to lead, to all, or to human. To all or a role, it reaches those still going: it doesn't wake teammates who have finished, who see it if woken later. To wake a finished one, use its name.",
    params: {
      to: 'Recipient',
      text: 'The message',
      urgent: 'true to interrupt them',
      decision: 'With to: human, true to ask for an approval (e.g. of a design). Say what to approve and where it is; the answer arrives as a message. To offer choices, list them under a line saying Options: (a numbered list, the one you would pick marked (recommended)): the human gets a button for each',
      allow: "For a lead, answering a teammate's request that MetaHarness passed to you: yes to let it run, no to refuse it (text says why)",
    },
  },
  wait: {
    description: "Pause until a message arrives or a teammate you spawned finishes. timeout 0 just checks. Say who you're waiting on and for what: if they're already waiting on you, you'll be told instead of waiting forever.",
    params: {
      timeout: 'Seconds to wait (default 60)',
      on: 'Who you expect something from: a teammate, a role, lead or human',
      for: "What you expect, in a few words. Without on, it's something of your own, like a build or a timer",
    },
  },
  status: { description: 'Post a one-line progress update for the human and your teammates.', params: { text: 'What you are doing now' } },
  procs: {
    description:
      "See what the team's commands are still running: each process's PID, whose command started it, how long it has run and what it is. Use it when something is stuck waiting, e.g. on a lock or a port, to find what holds it. With end, stop processes: your own, or, as the lead or their spawner, a teammate's. A command of yours that is cut short (interrupted, timed out) has what it left running ended for you.",
    params: { end: 'Optional: PIDs to stop, separated by commas, or mine for every process your commands left running' },
  },
  done: { description: "Say you're finished. The note goes to whoever spawned you. Held while teammates you spawned still work: their results first.", params: { note: 'What you did and where it is' } },
  workflow: {
    description: 'Read a workflow: a guide for running a kind of task, e.g. the next one a workflow says to continue with. Without a name, lists them.',
    params: { name: 'Workflow name (optional)' },
  },
  skill: {
    description: 'Read a skill or a tool: a guide for a kind of work, with files, or a program teammates made, with how to use it. With a name, a summary: what it is for, its sections and its files. With part, one section (by heading) or file (by path). Without a name, lists the skills for your role and the tools in the library.',
    params: { name: 'Skill name (optional)', part: 'A section heading or a file path from the summary (optional)' },
  },
  canvas: {
    description: "Change the brainstorm room's board: cards (question, idea, finding, risk, decision, source, image, demo, text, concept), the links between them, and the frames that group them. Without ops, shows the whole board.",
    params: {
      ops: 'A list of changes: {"op": "add", "kind": "image", "title": "a few words", "text": "detail", "file": "room/media/x.png", "url": "https://…", "refs": ["src/x.ts:40"], "from": [{"id": "c2", "take": "its palette"}], "frame": "Look", "links": [{"to": "c2", "label": "answers"}], "ref": "a"}, {"op": "edit", "id": "c3", "title": "…", "file": "…", "pillars": [{"name": "Look", "text": "…", "cards": ["c3"]}]}, {"op": "settle" | "drop" | "reopen" | "remove", "id": "c3"}, {"op": "note", "id": "c3", "text": "…"}, {"op": "link", "from": "c4", "to": "c2", "label": "rules out"}, {"op": "unlink", "from": "c4", "to": "c2"}, {"op": "frame", "title": "Combat", "cards": ["c3", "c5"]}',
    },
  },
  prototype: {
    description: "The room's lead starts, forks or merges prototypes: playable games of their own, kept outside the project, each with its own builder and versions.",
    params: {
      action: 'start, fork or merge',
      ideas: 'For start: [{"title": "a few words", "ask": "what to try", "card": "the card it comes from (optional)"}], one prototype each',
      from: 'For start: game (a frozen copy of the game as it stands) or small (a little project of its own)',
      source: 'For start from game: a checkout or git worktree of the project (optional; default the human\'s checkout)',
      id: 'For fork: the prototype',
      version: 'For fork: which version (optional; default its latest)',
      ids: 'For merge: the prototypes, by id (or {"id": "…", "version": 3})',
      title: 'For fork and merge: what to call the new one',
      ask: 'For fork and merge: what to try',
    },
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

/** The agent tools. Every answer is plain language, and nothing an agent sends is rejected outright. */
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
    if (!['wait', 'status', 'team'].includes(r.match)) this.d.touch(rec);
    let out: string;
    try {
      out = await this.run(rec, r.match as (typeof TOOL_NAMES)[number], a);
    } catch (e) {
      out = `That didn't work: ${(e as Error).message}`;
    }
    if (r.guessed) out = `(Used ${r.match} for "${toolName}".)\n${out}`;
    if (r.match !== 'wait') out += this.unreadNotice(rec);
    const notes = this.d.takeNotes(rec);
    if (notes) out += `\n\n${notes}`;
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
        if (!role) return `spawn needs a role. Roles you can spawn: ${d.rolesFor(rec, d.cfg(rec)).roles.map(r => r.name).join(', ')}.`;
        const brief = str(pick(a, 'brief', 'task', 'prompt', 'text', 'message', 'instructions', 'description'))
          ?? '(No brief was given. Ask whoever spawned you what they need.)';
        const name = str(pick(a, 'name', 'id'));
        if (truthy(pick(a, 'quick', 'helper', 'blocking'))) return (await d.quickSpawn(rec, role, brief, name)).text;
        // In a room, the lead sends makers; nobody else starts anyone.
        const lens = d.roomSpawn(rec, role, brief);
        if (lens !== undefined) return lens;
        const from = str(pick(a, 'from', 'base', 'branch', 'start_from', 'starting_from'));
        const wt = pick(a, 'worktree', 'own_worktree', 'isolated', 'isolation');
        const worktree = wt === undefined ? undefined : truthy(wt) || /^worktree$/i.test(String(wt));
        const toolsArg = pick(a, 'tools', 'kit', 'tool');
        const tools = (Array.isArray(toolsArg) ? toolsArg.map(String) : String(toolsArg ?? '').split(',')).map(t => t.trim()).filter(Boolean);
        const r = d.spawnAgent(rec.goal, { role, brief, parent: rec.name, name, from, worktree, tools });
        if (!r.ok) return r.error;
        const guessed = r.guessedRole ? `(Took "${role}" to mean ${r.guessedRole}.) ` : '';
        const where = r.rec.worktree ? ` in its own worktree on branch ${r.rec.worktree.branch}, from ${r.rec.worktree.base.slice(0, 7)}` : ' in the shared folder';
        const backup = r.note ? ` ${r.note}` : '';
        const kit = r.rec.tools.length ? ` Its kit: ${r.rec.tools.join(', ')}.` : '';
        return `${guessed}Started ${r.name} (${r.rec.harness} · ${r.rec.model})${where}.${kit}${backup} Its result will reach you when it calls done; use wait to block until then.`;
      }

      case 'respawn': {
        const name = str(pick(a, 'name', 'agent', 'who', 'teammate', 'to'));
        if (!name) return 'respawn needs the name of a crashed or hung teammate.';
        const fresh = truthy(pick(a, 'fresh', 'new', 'restart'));
        const r = d.respawnAgent(rec.goal, name, { by: rec.name, fresh, on: str(pick(a, 'on', 'harness', 'model', 'route')), note: str(pick(a, 'note', 'text', 'message', 'brief')) });
        return r.ok ? r.text : r.error;
      }

      case 'dismiss': {
        if (d.goals.get(rec.goal)?.room) return "In a room, makers stay for the next question, so there's nothing to dismiss.";
        const who = pick(a, 'name', 'names', 'agent', 'agents', 'who', 'teammate', 'teammates', 'text');
        const wanted = (Array.isArray(who) ? who.map(String) : String(who ?? '').split(/[,\s]+/)).map(w => w.trim()).filter(Boolean);
        if (!wanted.length) return 'dismiss needs a name: a finished teammate, several separated by commas, or all.';
        return d.dismissAgents(rec.goal, rec.name, wanted);
      }

      case 'procs': {
        const raw = pick(a, 'end', 'kill', 'stop', 'pids', 'pid');
        if (raw === undefined || raw === '' || raw === false) return d.teamProcs(rec.goal, rec.name);
        if (/^\s*(mine|all|yes|true)\s*$/i.test(String(raw)) || raw === true) return d.teamProcs(rec.goal, rec.name, 'mine');
        const pids = (Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/)).map(Number).filter(n => Number.isInteger(n) && n > 0);
        if (!pids.length) return 'procs end needs PIDs (from procs without end), or mine.';
        return d.teamProcs(rec.goal, rec.name, pids);
      }

      case 'send': {
        const to = str(pick(a, 'to', 'recipient', 'agent', 'target', 'who'));
        const text = str(pick(a, 'text', 'message', 'content', 'body', 'msg'));
        if (!to) return 'send needs "to": a teammate name, a role, lead, all, or human.';
        const human = /^(human|you|user)$/i.test(to);
        const allow = pick(a, 'allow', ...(human ? [] : ['approve', 'approval']));
        if (allow !== undefined && !human) return d.answerApproval(rec, to, truthy(allow) || /^(allow|approve|ok)/i.test(String(allow)), text);
        if (!text) return 'send needs some text.';
        return d.deliver(rec.goal, rec.name, to, text, truthy(pick(a, 'urgent', 'interrupt')), truthy(pick(a, 'decision', 'approval', 'approve')));
      }

      case 'wait': {
        const t = Number(pick(a, 'timeout', 'seconds', 'timeout_s', 'secs'));
        const timeout = Number.isFinite(t) ? Math.min(Math.max(t, 0), 600) : 60;
        const on = str(pick(a, 'on', 'waiting_on', 'teammate', 'agent', 'who', 'from'));
        const what = str(pick(a, 'for', 'what', 'reason', 'about', 'need'));
        const refused = d.waitRefused(rec, timeout, on, what);
        if (refused) return refused;
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
        const flows = d.cfg(rec).workflows;
        const names = [...flows.keys()];
        const list = () => [...flows.values()].map(w => `- ${w.name}: ${w.goodAt || '—'}`).join('\n');
        if (!names.length) return 'There are no workflows yet (.metaharness/workflows/<name>.md).';
        if (!want) return `Workflows:\n${list()}\n\nRead one with workflow(name).`;
        const r = resolveName(want, names);
        if (!r.match) return `There's no workflow called "${want}". Workflows:\n${list()}`;
        const w = flows.get(r.match)!;
        d.workflowRead(rec, w.name);
        const roles = w.roles.length ? `\n\nRoles it uses: ${workflowRoleNames(w.roles, this.d.cfg(rec).roles.values()).join(', ') || 'none (the folder it names is empty)'}.` : '';
        return `${r.guessed ? `(Took "${want}" to mean ${w.name}.)\n` : ''}# Workflow: ${w.name}\n\n${w.body}${roles}`;
      }

      case 'skill': {
        const want = str(pick(a, 'name', 'skill', 'text'));
        const part = str(pick(a, 'part', 'section', 'file', 'path', 'heading'));
        let mine = d.skillsFor(rec);
        if (!want) return skillList(mine, d.kitFor(rec));
        let r = resolveName(want, mine.map(s => s.name));
        // A tool the toolsmith wrote since the library was read.
        if (!r.match || r.guessed) {
          d.refreshTools(rec);
          mine = d.skillsFor(rec);
          r = resolveName(want, mine.map(s => s.name));
        }
        if (!r.match) {
          const other = d.cfg(rec).skills.get(want);
          const why = !other ? `There's no skill called "${want}".`
            : other.tool && !d.cfg(rec).settings.agentTools ? `Tools are turned off in the settings, so ${want} can't be used. Do the work without it.`
            : other.off ? `The ${other.tool ? 'tool' : 'skill'} ${want} is turned off.`
            : `Your role (${rec.role.name} on ${rec.harness}) doesn't carry the skill ${want}.`;
          return `${why} ${skillList(mine, d.kitFor(rec))}`;
        }
        const sk = mine.find(s => s.name === r.match)!;
        if (sk.tool) d.toolRead(rec, sk.name);
        d.emit({ goal: rec.goal, agent: rec.name, type: 'skill.read', data: { skill: sk.name, ...(part ? { part } : {}), ...(sk.tool ? { tool: true } : {}) } });
        const text = part ? skillPart(sk, part) : skillSummary(sk);
        return `${r.guessed ? `(Took "${want}" to mean ${sk.name}.)\n` : ''}${text}`;
      }

      case 'canvas':
        return d.canvasTool(rec, parseCanvasOps(a));

      case 'prototype':
        return d.prototypeTool(rec, a);

      case 'done': {
        const note = str(pick(a, 'note', 'summary', 'text', 'result', 'message', 'answer')) ?? (rec.lastText || '(no note)');
        // A room's lead never finishes: its done is a reply to the human.
        const reply = d.roomLeadDone(rec, note);
        if (reply !== undefined) return reply;
        const again = rec.doneNote !== undefined;
        // Its result isn't whole while teammates it spawned still work: it decides what to do about them.
        const working = d.workingChildren(rec);
        if (working.length) return d.doneHeld(rec, working);
        // Done rules hold the first done back once, with what to check first.
        const held = again ? undefined : d.doneRules(rec);
        if (held) return held;
        const warning = d.done(rec, note);
        // A room's maker answers whoever asked its turn: the lead, or the human.
        const to = rec.askedBy === 'human' ? 'human' : rec.parent;
        const ok = again ? 'Updated your note. Whoever spawned you has the new one.' : to === 'human' ? 'Done. The human has your note.' : `Done. ${to} has your note.`;
        return warning ? `${ok}\n\n${warning}` : ok;
      }
    }
  }

  private team(rec: AgentRec): string {
    const room = this.d.roomTeam(rec);
    if (room) return room;
    const g = this.d.goals.get(rec.goal)!;
    const lines = [`Goal: ${g.request}`, `Shared folder: ${g.sharedDir}`, '', 'Team:'];
    for (const a of g.agents.values()) {
      const by = a.parent === 'human' ? 'the human' : a.parent;
      const what = a.status ? `: ${a.status}` : '';
      const you = a.name === rec.name ? '  ← you' : '';
      lines.push(`- ${a.name} (${a.role.name} · ${a.harness} · ${a.model}), spawned by ${by}, ${a.state}${what}${you}`);
    }
    const { roles, workflows } = this.d.rolesFor(rec, this.d.cfg(rec));
    lines.push('', workflows.length ? `Roles you can spawn (the ones ${workflows.join(' and ')} ${workflows.length > 1 ? 'use' : 'uses'}, and quick helpers):` : 'Roles you can spawn:');
    for (const r of roles) lines.push(`- ${r.name}${r.helper ? ' (quick helper)' : ''}${r.onDemand ? ' (starts when messaged)' : ''}: ${r.goodAt || '—'}`);
    // On-demand roles start when messaged, whatever the workflow names.
    const onDemand = this.d.teamRoles(this.d.cfg(rec)).filter(r => r.onDemand && !roles.includes(r));
    if (onDemand.length) {
      lines.push('', 'Roles that start when you message them (send to: the role):');
      for (const r of onDemand) lines.push(`- ${r.name}: ${r.goodAt || '—'}`);
    }
    return lines.join('\n');
  }
}
