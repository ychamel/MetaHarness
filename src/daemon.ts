import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventStore } from './store.ts';
import { loadConfig, type Config } from './config.ts';
import { resolveName } from './fuzzy.ts';
import { Hub } from './hub.ts';
import type { AgentState, MhEvent, NewEvent, Role } from './types.ts';
import type { HarnessAdapter, Session, SessionEvents } from './adapters/types.ts';

export interface InboxEntry {
  id: string;
  kind: 'message' | 'done';
  from: string;
  text: string;
  urgent: boolean;
  ts: string;
}

interface Waiter {
  resolve: (entries: InboxEntry[]) => void;
  timer?: NodeJS.Timeout;
}

export interface AgentRec {
  goal: string;
  name: string;
  role: Role;
  harness: string;
  model: string;
  parent: string;
  brief: string;
  quick: boolean;
  isLead: boolean;
  cwd: string;
  state: AgentState;
  status: string;
  cost: number;
  contextPct?: number;
  lastText: string;
  adapter: HarnessAdapter;
  session?: Session;
  inbox: InboxEntry[];
  waiters: Waiter[];
  /** Callers blocked in a quick spawn, waiting for this agent's answer. */
  doneWaiters: ((note: string) => void)[];
  doneNote?: string;
}

export interface GoalRec {
  id: string;
  request: string;
  lead: string;
  createdAt: string;
  sharedDir: string;
  status: 'running' | 'ended';
  agents: Map<string, AgentRec>;
  counters: Map<string, number>;
  /** Resolves when the lead calls done. */
  leadDone: Promise<string>;
  resolveLeadDone: (note: string) => void;
}

export interface HumanInboxItem {
  id: string;
  goal: string;
  agent: string;
  kind: 'question' | 'done' | 'stopped' | 'crash';
  text: string;
  ts: string;
}

export interface DaemonOptions {
  /** Where goals and the event log live (default ~/.metaharness). */
  home: string;
  /** The repository the agents work on. */
  repo: string;
  dbPath?: string;
  /** Config directories, later ones override earlier ones. Default: home, then repo/.metaharness. */
  configDirs?: string[];
  adapters?: Record<string, HarnessAdapter>;
  /** Run every role on this harness instead of its own (e.g. "fake" for scripted agents). */
  harnessOverride?: string;
  /** How long a quick spawn blocks its caller before handing back control. */
  quickTimeoutMs?: number;
}

type SpawnResult =
  | { ok: true; name: string; rec: AgentRec; guessedRole?: string }
  | { ok: false; error: string };

const FINISHED: AgentState[] = ['ended', 'crashed'];

export class Daemon {
  readonly home: string;
  readonly repo: string;
  readonly store: EventStore;
  readonly hub: Hub;
  readonly goals = new Map<string, GoalRec>();
  readonly humanInbox: HumanInboxItem[] = [];
  readonly quickTimeoutMs: number;
  config: Config;
  private adapters: Record<string, HarnessAdapter>;
  private harnessOverride?: string;

  constructor(o: DaemonOptions) {
    this.home = o.home;
    this.repo = o.repo;
    mkdirSync(o.home, { recursive: true });
    this.store = new EventStore(o.dbPath ?? join(o.home, 'mh.db'));
    this.config = loadConfig(o.configDirs ?? [o.home, join(o.repo, '.metaharness')]);
    this.adapters = o.adapters ?? {};
    this.harnessOverride = o.harnessOverride;
    this.quickTimeoutMs = o.quickTimeoutMs ?? 120_000;
    this.hub = new Hub(this);
  }

  emit(e: NewEvent): MhEvent {
    return this.store.append(e);
  }

  agent(goal: string, name: string): AgentRec | undefined {
    return this.goals.get(goal)?.agents.get(name);
  }

  latestGoal(): GoalRec | undefined {
    return [...this.goals.values()].filter(g => g.status === 'running').at(-1) ?? [...this.goals.values()].at(-1);
  }

  /* ---------------- goals and agents ---------------- */

  startGoal(o: { request: string; lead?: string; playbook?: string }): string {
    const id = randomUUID().slice(0, 8);
    const sharedDir = join(this.home, 'goals', id, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    let resolveLeadDone!: (note: string) => void;
    const leadDone = new Promise<string>(r => (resolveLeadDone = r));
    const g: GoalRec = {
      id, request: o.request, lead: '', createdAt: new Date().toISOString(), sharedDir,
      status: 'running', agents: new Map(), counters: new Map(), leadDone, resolveLeadDone,
    };
    this.goals.set(id, g);
    const leadRole = o.lead ?? 'architect';
    this.emit({ goal: id, type: 'goal.started', data: { request: o.request, lead: leadRole, playbook: o.playbook ?? null, sharedDir } });
    const r = this.spawnAgent(id, { role: leadRole, brief: o.request, parent: 'human', isLead: true, playbook: o.playbook });
    if (!r.ok) {
      g.status = 'ended';
      this.emit({ goal: id, type: 'goal.ended', data: { reason: r.error } });
      throw new Error(r.error);
    }
    g.lead = r.name;
    return id;
  }

  spawnAgent(
    goalId: string,
    o: { role: string; brief: string; parent: string; name?: string; quick?: boolean; isLead?: boolean; playbook?: string },
  ): SpawnResult {
    const g = this.goals.get(goalId);
    if (!g) return { ok: false, error: `There's no goal ${goalId}.` };
    const roleNames = [...this.config.roles.keys()];
    if (!roleNames.length) return { ok: false, error: 'No roles are defined yet. Add one as .metaharness/roles/<name>.md.' };
    const res = resolveName(o.role, roleNames);
    if (!res.match) {
      const hint = res.suggestions.length ? ` Did you mean ${res.suggestions[0]}?` : '';
      return { ok: false, error: `There's no role called "${o.role}".${hint} Roles you can spawn: ${roleNames.join(', ')}.` };
    }
    const role = this.config.roles.get(res.match)!;
    const harness = this.harnessOverride ?? role.harness;
    const adapter = this.adapters[harness];
    if (!adapter) {
      return { ok: false, error: `The ${harness} adapter isn't available yet, so ${role.name} can't be started. Start the daemon with --fake to use scripted agents.` };
    }

    const n = (g.counters.get(role.name) ?? 0) + 1;
    g.counters.set(role.name, n);
    let name = o.name?.trim() || (o.isLead ? role.name : `${role.name}-${n}`);
    while (g.agents.has(name)) name = `${name}-${n}`;
    const parentRec = g.agents.get(o.parent);
    // Quick helpers work in their caller's directory so they see uncommitted changes.
    // Worktrees per coding agent arrive in milestone 1.
    const cwd = o.quick && parentRec ? parentRec.cwd : this.repo;

    const rec: AgentRec = {
      goal: goalId, name, role, harness, model: role.model, parent: o.parent, brief: o.brief,
      quick: !!o.quick, isLead: !!o.isLead, cwd, state: 'starting', status: '', cost: 0, lastText: '',
      adapter, inbox: [], waiters: [], doneWaiters: [],
    };
    g.agents.set(name, rec);
    this.emit({
      goal: goalId, agent: name, parent: o.parent, type: 'agent.spawned',
      data: { role: role.name, harness, model: role.model, brief: o.brief, quick: !!o.quick, cwd },
    });

    adapter
      .start(
        {
          goal: goalId, agent: name, role, model: role.model,
          systemPrompt: this.buildPrompt(g, rec, o.playbook), brief: o.brief,
          cwd, sharedDir: g.sharedDir, mcpUrl: '',
          callTool: (tool, args) => this.hub.call(goalId, name, tool, args),
        },
        this.sessionEvents(rec),
      )
      .then(session => {
        rec.session = session;
        this.emit({ goal: goalId, agent: name, type: 'agent.session', data: { nativeSession: session.nativeId } });
        this.pump(rec);
      })
      .catch((err: Error) => {
        this.setState(rec, 'crashed');
        this.emit({ goal: goalId, agent: name, type: 'agent.crashed', data: { reason: `Couldn't start: ${err.message}` } });
        this.finish(rec, `${name} couldn't start: ${err.message}`, 'crashed');
      });

    return { ok: true, name, rec, guessedRole: res.guessed ? res.match : undefined };
  }

  private buildPrompt(g: GoalRec, rec: AgentRec, playbook?: string): string {
    const parts = [rec.role.helper ? this.config.helperMethodology : this.config.methodology];
    parts.push(`## Your role: ${rec.role.name}\n\n${rec.role.instructions}`);
    if (rec.isLead && playbook) {
      const p = resolveName(playbook, [...this.config.playbooks.keys()]);
      if (p.match) parts.push(`## Playbook: ${p.match}\n\n${this.config.playbooks.get(p.match)}`);
    }
    parts.push(
      [
        '## Where you are',
        '',
        `- Your name: ${rec.name}`,
        `- Goal: ${g.request}`,
        `- Spawned by: ${rec.parent === 'human' ? 'the human' : rec.parent}`,
        `- Shared folder: ${g.sharedDir}`,
        `- Working directory: ${rec.cwd}`,
      ].join('\n'),
    );
    return parts.join('\n\n');
  }

  private sessionEvents(rec: AgentRec): SessionEvents {
    const base = { goal: rec.goal, agent: rec.name };
    return {
      turnStarted: () => {
        if (!FINISHED.includes(rec.state) && rec.state !== 'paused') this.setState(rec, 'working');
      },
      turnEnded: () => {
        if (FINISHED.includes(rec.state)) return;
        if (rec.doneNote !== undefined) this.setState(rec, 'done');
        else this.endedTurnWithoutDone(rec);
        this.pump(rec);
      },
      text: text => {
        rec.lastText = text;
        this.emit({ ...base, type: 'agent.text', data: { text } });
      },
      toolCall: (tool, summary) => this.emit({ ...base, type: 'agent.tool_call', data: { tool, summary } }),
      toolResult: (summary, ok) => this.emit({ ...base, type: 'agent.tool_result', data: { summary, ok } }),
      usage: u => {
        if (u.costUsd !== undefined) rec.cost = u.costUsd;
        if (u.contextPct !== undefined) rec.contextPct = u.contextPct;
        this.emit({ ...base, type: 'usage', data: { ...u } });
      },
      exited: (reason, detail) => {
        if (FINISHED.includes(rec.state)) return;
        const state = reason === 'crashed' ? 'crashed' : 'ended';
        this.setState(rec, state);
        this.emit({ ...base, type: `agent.${state}`, data: { reason: detail ?? reason } });
        if (rec.doneNote === undefined) {
          const note = rec.lastText ? `${rec.name} ${state} before calling done. Its last message: ${rec.lastText}` : `${rec.name} ${state} before calling done.`;
          this.finish(rec, note, state);
        }
      },
    };
  }

  /**
   * A turn ended without `done`. If the agent still has helpers or teammates working for it,
   * it's presumably waiting on them, so stay quiet. Otherwise tell its spawner, with its last message.
   */
  private endedTurnWithoutDone(rec: AgentRec): void {
    this.setState(rec, 'idle');
    if (rec.inbox.length) return;
    const g = this.goals.get(rec.goal)!;
    const activeChildren = [...g.agents.values()].some(a => a.parent === rec.name && a.doneNote === undefined && !FINISHED.includes(a.state));
    if (activeChildren) return;
    const note = rec.lastText || '(no message)';
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.idle', data: { note } });
    this.finish(rec, `${rec.name} stopped without calling done. Its last message: ${note}`, 'idle');
  }

  setState(rec: AgentRec, state: AgentState): void {
    if (rec.state === state) return;
    rec.state = state;
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.state', data: { state } });
  }

  /* ---------------- tools (called through the hub) ---------------- */

  done(rec: AgentRec, note: string): void {
    rec.doneNote = note;
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.done', data: { note } });
    // The state turns to "done" when the turn ends; until then the agent is still wrapping up.
    if (!rec.session?.busy()) this.setState(rec, 'done');
    this.finish(rec, note, 'done');
  }

  /** Hands an agent's result to whoever is waiting for it: a quick-spawn caller, its spawner, or the human. */
  private finish(rec: AgentRec, note: string, how: 'done' | 'idle' | 'ended' | 'crashed'): void {
    const quick = rec.doneWaiters.splice(0);
    for (const w of quick) w(note);
    if (quick.length) return;
    const g = this.goals.get(rec.goal)!;
    if (rec.parent === 'human') {
      const kind = how === 'done' || how === 'idle' ? 'done' : how === 'crashed' ? 'crash' : 'stopped';
      this.toHuman(g, rec.name, kind, note);
      if (rec.isLead && how === 'done') g.resolveLeadDone(note);
      return;
    }
    const parent = g.agents.get(rec.parent);
    if (!parent) return;
    this.enqueue(parent, { id: randomUUID(), kind: 'done', from: rec.name, text: note, urgent: false, ts: new Date().toISOString() });
  }

  status(rec: AgentRec, text: string): void {
    rec.status = text;
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.status', data: { text } });
  }

  /** Delivers a message. Returns a plain-language summary for the sender. */
  deliver(goalId: string, from: string, to: string, text: string, urgent = false): string {
    const g = this.goals.get(goalId);
    if (!g) return `There's no goal ${goalId}.`;
    const target = to.trim().toLowerCase();
    if (target === 'human' || target === 'you' || target === 'user') {
      this.emit({ goal: goalId, agent: from, type: 'message.sent', data: { to: 'human', text, urgent } });
      this.toHuman(g, from, 'question', text);
      return 'Sent to the human. Their answer will arrive as a message.';
    }
    const r = this.resolveRecipients(g, from, to);
    if ('error' in r) return r.error;
    const lines: string[] = [];
    for (let name of r.names) {
      let rec = g.agents.get(name)!;
      if (FINISHED.includes(rec.state)) {
        const fallback = rec.parent;
        lines.push(`${name} has ${rec.state}, so the message went to ${fallback === 'human' ? 'the human' : fallback} instead.`);
        if (fallback === 'human') {
          this.emit({ goal: goalId, agent: from, type: 'message.sent', data: { to: 'human', text, urgent } });
          this.toHuman(g, from, 'question', `(meant for ${name}) ${text}`);
          continue;
        }
        name = fallback;
        rec = g.agents.get(name)!;
      }
      const entry: InboxEntry = { id: randomUUID(), kind: 'message', from, text, urgent, ts: new Date().toISOString() };
      this.emit({ goal: goalId, agent: from, type: 'message.sent', data: { id: entry.id, to: name, text, urgent } });
      this.enqueue(rec, entry);
    }
    const sentTo = r.names.join(', ');
    return [r.note, lines.join(' '), `Sent to ${sentTo}.`].filter(Boolean).join(' ');
  }

  private resolveRecipients(g: GoalRec, from: string, to: string): { names: string[]; note?: string } | { error: string } {
    const live = [...g.agents.values()].filter(a => a.name !== from);
    const t = to.trim().toLowerCase();
    if (t === 'all' || t === 'everyone') {
      const names = live.filter(a => !FINISHED.includes(a.state) && !a.quick).map(a => a.name);
      return names.length ? { names } : { error: 'Nobody else is on the team yet.' };
    }
    if (t === 'lead') return g.lead && g.lead !== from ? { names: [g.lead] } : { error: "You're the lead." };
    const agentNames = live.map(a => a.name);
    const exact = agentNames.find(n => n.toLowerCase() === t);
    if (exact) return { names: [exact] };
    const byRole = live.filter(a => a.role.name.toLowerCase() === t).map(a => a.name);
    if (byRole.length) return { names: byRole };
    // "impl" prefixes both the agent implementer-1 and its role; fine as long as it means one agent.
    const prefixed = live.filter(a => a.name.toLowerCase().startsWith(t) || a.role.name.toLowerCase().startsWith(t));
    if (t && prefixed.length === 1) return { names: [prefixed[0].name], note: `(Took "${to}" to mean ${prefixed[0].name}.)` };
    const roleNames = [...new Set(live.map(a => a.role.name))];
    const res = resolveName(to, [...agentNames, ...roleNames]);
    if (res.match) {
      const names = agentNames.includes(res.match) ? [res.match] : live.filter(a => a.role.name === res.match).map(a => a.name);
      return { names, note: `(Took "${to}" to mean ${res.match}.)` };
    }
    return { error: `There's nobody called "${to}". Teammates: ${agentNames.join(', ') || 'none yet'}. You can also send to lead, all or human.` };
  }

  private toHuman(g: GoalRec, agent: string, kind: HumanInboxItem['kind'], text: string): void {
    const item: HumanInboxItem = { id: randomUUID().slice(0, 8), goal: g.id, agent, kind, text, ts: new Date().toISOString() };
    this.humanInbox.push(item);
    this.emit({ goal: g.id, agent, type: 'inbox.item', data: { id: item.id, kind, text } });
  }

  private enqueue(rec: AgentRec, entry: InboxEntry): void {
    rec.inbox.push(entry);
    this.pump(rec);
  }

  /**
   * Gets waiting messages to an agent by the best route its harness allows:
   * a pending wait() → straight into the running turn → a new turn. Otherwise they wait
   * in the inbox and show up as an unread notice on the agent's next tool call.
   */
  pump(rec: AgentRec): void {
    if (!rec.inbox.length) return;
    const w = rec.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      const entries = rec.inbox.splice(0);
      this.markDelivered(rec, entries, 'wait');
      w.resolve(entries);
      return;
    }
    const s = rec.session;
    if (!s || rec.state === 'paused' || FINISHED.includes(rec.state)) return;
    if (s.busy()) {
      if (!rec.adapter.manifest.injectMidTurn) return;
      const entries = rec.inbox.splice(0);
      this.markDelivered(rec, entries, 'inject');
      void s.send(formatForAgent(entries), 'inject');
      return;
    }
    const entries = rec.inbox.splice(0);
    this.markDelivered(rec, entries, rec.state === 'done' ? 'resume' : 'new_turn');
    void s.send(formatForAgent(entries), 'new_turn');
  }

  private markDelivered(rec: AgentRec, entries: InboxEntry[], via: string): void {
    for (const e of entries) {
      if (e.kind !== 'message') continue;
      this.emit({ goal: rec.goal, agent: rec.name, type: 'message.delivered', data: { id: e.id, from: e.from, via } });
    }
  }

  /** Blocks until a message or a finished teammate arrives, or the timeout passes. */
  async wait(rec: AgentRec, timeoutSec: number): Promise<InboxEntry[]> {
    if (rec.inbox.length) {
      const entries = rec.inbox.splice(0);
      this.markDelivered(rec, entries, 'wait');
      return entries;
    }
    if (timeoutSec <= 0) return [];
    const before = rec.state;
    this.setState(rec, 'waiting');
    const entries = await new Promise<InboxEntry[]>(resolve => {
      const w: Waiter = { resolve };
      w.timer = setTimeout(() => {
        rec.waiters = rec.waiters.filter(x => x !== w);
        resolve([]);
      }, timeoutSec * 1000);
      rec.waiters.push(w);
    });
    if (rec.state === 'waiting') this.setState(rec, before === 'waiting' ? 'working' : before);
    return entries;
  }

  /** Spawns a quick helper and waits for its answer, up to quickTimeoutMs. */
  async quickSpawn(caller: AgentRec, role: string, brief: string, name?: string): Promise<{ text: string }> {
    const r = this.spawnAgent(caller.goal, { role, brief, parent: caller.name, quick: true, name });
    if (!r.ok) return { text: r.error };
    const guessed = r.guessedRole ? `(Took "${role}" to mean ${r.guessedRole}.) ` : '';
    const note = await new Promise<string | null>(resolve => {
      const onDone = (n: string) => {
        clearTimeout(timer);
        resolve(n);
      };
      const timer = setTimeout(() => {
        r.rec.doneWaiters = r.rec.doneWaiters.filter(x => x !== onDone);
        resolve(null);
      }, this.quickTimeoutMs);
      r.rec.doneWaiters.push(onDone);
    });
    if (note === null) {
      const s = Math.round(this.quickTimeoutMs / 1000);
      return { text: `${guessed}${r.name} is still working after ${s}s. Its answer will arrive as a message, so carry on.` };
    }
    return { text: `${guessed}${r.name} answered:\n${note}` };
  }

  stopAgent(goalId: string, name: string, by = 'human'): string {
    const rec = this.agent(goalId, name);
    if (!rec) return `There's no agent called ${name}.`;
    if (FINISHED.includes(rec.state)) return `${name} has already ${rec.state}.`;
    void rec.session?.stop();
    this.setState(rec, 'ended');
    this.emit({ goal: goalId, agent: name, type: 'agent.ended', data: { reason: `stopped by ${by}` } });
    if (rec.doneNote === undefined) this.finish(rec, `${name} was stopped by ${by}.`, 'ended');
    return `Stopped ${name}.`;
  }

  /* ---------------- client API ---------------- */

  snapshot(goalId?: string) {
    const goals = [...this.goals.values()].filter(g => !goalId || g.id === goalId);
    return {
      goals: goals.map(g => ({
        id: g.id,
        request: g.request,
        status: g.status,
        lead: g.lead,
        createdAt: g.createdAt,
        sharedDir: g.sharedDir,
        agents: [...g.agents.values()].map(a => ({
          name: a.name,
          role: a.role.name,
          harness: a.harness,
          model: a.model,
          parent: a.parent,
          state: a.state,
          status: a.status,
          quick: a.quick,
          cost: a.cost,
          contextPct: a.contextPct ?? null,
          unread: a.inbox.length,
          nativeSession: a.session?.nativeId ?? null,
        })),
      })),
      inbox: this.humanInbox.filter(i => !goalId || i.goal === goalId),
    };
  }

  async command(b: Record<string, unknown>): Promise<Record<string, unknown>> {
    const s = (k: string) => (typeof b[k] === 'string' && b[k] ? (b[k] as string) : undefined);
    const goalOrLatest = () => {
      const id = s('goal') ?? this.latestGoal()?.id;
      if (!id || !this.goals.has(id)) throw new Error(id ? `There's no goal ${id}.` : 'There are no goals yet. Start one with: mh run "<request>"');
      return id;
    };
    switch (b.cmd) {
      case 'goal.start': {
        const request = s('request');
        if (!request) throw new Error('goal.start needs a request.');
        return { goal: this.startGoal({ request, lead: s('lead'), playbook: s('playbook') }) };
      }
      case 'agent.message': {
        const to = s('to'), text = s('text');
        if (!to || !text) throw new Error('agent.message needs "to" and "text".');
        const goal = goalOrLatest();
        return { goal, result: this.deliver(goal, 'human', to, text, b.urgent === true) };
      }
      case 'agent.stop': {
        const agent = s('agent');
        if (!agent) throw new Error('agent.stop needs "agent".');
        const goal = goalOrLatest();
        return { goal, result: this.stopAgent(goal, agent) };
      }
      default:
        throw new Error(`Unknown command "${String(b.cmd)}". Commands: goal.start, agent.message, agent.stop.`);
    }
  }

  async close(): Promise<void> {
    for (const g of this.goals.values()) {
      for (const a of g.agents.values()) {
        for (const w of a.waiters) clearTimeout(w.timer);
        if (a.session && !FINISHED.includes(a.state)) await a.session.stop().catch(() => {});
      }
    }
    this.store.close();
  }
}

export function formatForAgent(entries: InboxEntry[]): string {
  return entries
    .map(e =>
      e.kind === 'done'
        ? `[MetaHarness] ${e.from} finished: ${e.text}`
        : `[MetaHarness] Message from ${e.from}${e.urgent ? ' (urgent)' : ''}: ${e.text}`,
    )
    .join('\n');
}
