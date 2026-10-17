import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventStore } from './store.ts';
import { loadConfig, type Config } from './config.ts';
import { resolveName } from './fuzzy.ts';
import { Hub } from './hub.ts';
import * as git from './git.ts';
import type { AgentState, MhEvent, NewEvent, Role } from './types.ts';
import type { ApprovalDecision, HarnessAdapter, Session, SessionEvents } from './adapters/types.ts';

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
  /** The agent's own worktree. Quick helpers and goals without git have none. */
  worktree?: git.Worktree;
  state: AgentState;
  status: string;
  /** Total spend so far; undefined when the harness doesn't report cost and no price is configured. */
  cost?: number;
  contextPct?: number;
  lastText: string;
  adapter: HarnessAdapter;
  session?: Session;
  inbox: InboxEntry[];
  waiters: Waiter[];
  /** Callers blocked in a quick spawn, waiting for this agent's answer. */
  doneWaiters: ((note: string) => void)[];
  doneNote?: string;
  /** Permission requests waiting in the human's Inbox. */
  pendingApprovals: number;
}

export interface GoalRec {
  id: string;
  request: string;
  lead: string;
  createdAt: string;
  sharedDir: string;
  /** Git state for worktrees; unset when the repository can't have them (see gitNote). */
  git?: git.GoalGit;
  gitNote?: string;
  /** Last seen tip of each goal branch, and the branch each reported commit was made on, for git events. */
  refs: Map<string, string>;
  seenOn: Map<string, string>;
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
  kind: 'question' | 'approval' | 'done' | 'stopped' | 'crash';
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
  /** How often to look for new commits on the goal branches. 0 turns polling off (tests call refreshGit). */
  gitPollMs?: number;
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
  /** Base URL of the running server, e.g. http://127.0.0.1:7777. Real harnesses reach /mcp/<token> under it. */
  mcpBase?: string;
  private adapters: Record<string, HarnessAdapter>;
  private tokens = new Map<string, { goal: string; agent: string }>();
  private approvals = new Map<string, (d: ApprovalDecision) => void>();
  private harnessOverride?: string;
  private gitPollMs: number;
  private gitTimer?: NodeJS.Timeout;

  constructor(o: DaemonOptions) {
    this.home = o.home;
    this.repo = o.repo;
    mkdirSync(o.home, { recursive: true });
    this.store = new EventStore(o.dbPath ?? join(o.home, 'mh.db'));
    this.config = loadConfig(o.configDirs ?? [o.home, join(o.repo, '.metaharness')]);
    this.adapters = o.adapters ?? {};
    this.harnessOverride = o.harnessOverride;
    this.quickTimeoutMs = o.quickTimeoutMs ?? 120_000;
    this.gitPollMs = o.gitPollMs ?? 3000;
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
      refs: new Map(), seenOn: new Map(),
      status: 'running', agents: new Map(), counters: new Map(), leadDone, resolveLeadDone,
    };
    const gs = git.setupGoal(this.repo, id);
    if ('reason' in gs) g.gitNote = gs.reason;
    else g.git = gs;
    this.goals.set(id, g);
    const leadRole = o.lead ?? 'architect';
    this.emit({
      goal: id, type: 'goal.started',
      data: {
        request: o.request, lead: leadRole, playbook: o.playbook ?? null, sharedDir,
        branch: g.git?.branch ?? null, base: g.git?.base ?? null, notice: this.goalNotice(g) ?? null,
      },
    });
    const r = this.spawnAgent(id, { role: leadRole, brief: o.request, parent: 'human', isLead: true, playbook: o.playbook });
    if (!r.ok) {
      g.status = 'ended';
      this.emit({ goal: id, type: 'goal.ended', data: { reason: r.error } });
      throw new Error(r.error);
    }
    g.lead = r.name;
    if (g.git && this.gitPollMs > 0) this.gitTimer ??= setInterval(() => this.refreshGit(), this.gitPollMs).unref();
    return id;
  }

  /** What the human should know about where the agents' work happens, if anything. */
  goalNotice(g: GoalRec): string | undefined {
    if (!g.git) return `No worktrees for this goal: ${g.gitNote}. The agents share ${this.repo}.`;
    if (g.git.dirty) {
      const sha = g.git.base.slice(0, 7);
      return `Your uncommitted changes aren't in the agents' worktrees. They start from ${sha} (${git.subject(g.git, sha)}).`;
    }
  }

  spawnAgent(
    goalId: string,
    o: { role: string; brief: string; parent: string; name?: string; quick?: boolean; isLead?: boolean; playbook?: string; from?: string },
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
    // Names end up in branch names, so keep them to safe characters. "main" is the goal branch.
    let name = o.name?.trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || (o.isLead ? role.name : `${role.name}-${n}`);
    while (g.agents.has(name) || name === 'main') name = `${name}-${n}`;
    const parentRec = g.agents.get(o.parent);

    // Quick helpers work in their caller's directory so they see uncommitted changes. Everyone
    // else gets a worktree: the lead on the goal branch, the rest on mh/<goal>/<name>.
    let cwd = this.repo;
    let worktree: git.Worktree | undefined;
    let startedFrom = '';
    if (o.quick && parentRec) cwd = parentRec.cwd;
    else if (g.git) {
      const start = o.isLead ? { ref: g.git.base, label: 'the commit you were on' } : this.startPoint(g, parentRec, o.from);
      if ('error' in start) return { ok: false, error: start.error };
      try {
        const path = join(this.home, 'goals', goalId, 'worktrees', name);
        worktree = git.addWorktree(g.git, path, o.isLead ? g.git.branch : git.agentBranch(goalId, name), start.ref);
      } catch (e) {
        return { ok: false, error: `Couldn't create a git worktree for ${name}: ${(e as Error).message.trim()}` };
      }
      cwd = worktree.path;
      startedFrom = start.label;
      g.refs.set(worktree.branch, worktree.base);
    }

    const rec: AgentRec = {
      goal: goalId, name, role, harness, model: role.model, parent: o.parent, brief: o.brief,
      quick: !!o.quick, isLead: !!o.isLead, cwd, worktree, state: 'starting', status: '', lastText: '',
      adapter, inbox: [], waiters: [], doneWaiters: [], pendingApprovals: 0,
    };
    g.agents.set(name, rec);
    this.emit({
      goal: goalId, agent: name, parent: o.parent, type: 'agent.spawned',
      data: {
        role: role.name, harness, model: role.model, brief: o.brief, quick: !!o.quick, cwd,
        worktree: worktree?.path ?? null, branch: worktree?.branch ?? null, base: worktree?.base ?? null,
      },
    });

    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, { goal: goalId, agent: name });
    adapter
      .start(
        {
          goal: goalId, agent: name, role, model: role.model,
          systemPrompt: this.buildPrompt(g, rec, o.playbook, startedFrom), brief: this.firstMessage(rec),
          cwd, sharedDir: g.sharedDir, mcpUrl: this.mcpBase ? `${this.mcpBase}/mcp/${token}` : '',
          gitDirs: worktree && g.git ? [g.git.commonDir, worktree.gitDir] : [],
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

  /**
   * Where a new agent's branch starts: the latest commit of a teammate (or any branch) named in
   * `from`, else its spawner's, else the goal branch.
   */
  private startPoint(g: GoalRec, parent: AgentRec | undefined, from?: string): { ref: string; label: string } | { error: string } {
    const gg = g.git!;
    if (from) {
      const res = resolveName(from, [...g.agents.keys()]);
      const mate = res.match ? g.agents.get(res.match) : undefined;
      // An exact teammate name, then a real branch or commit, then a teammate's name with a typo.
      const fromMate = mate?.worktree && { ref: mate.worktree.branch, label: `${mate.name}'s branch ${mate.worktree.branch}` };
      if (fromMate && !res.guessed) return fromMate;
      if (git.resolveCommit(gg, from)) return { ref: from, label: from };
      if (fromMate) return fromMate;
      const mates = [...g.agents.values()].filter(a => a.worktree).map(a => a.name);
      return { error: `"from" should be a teammate or a branch, and there's no "${from}". Teammates with branches: ${mates.join(', ') || 'none'}.` };
    }
    if (parent?.worktree) return { ref: parent.worktree.branch, label: `${parent.name}'s branch ${parent.worktree.branch}` };
    return { ref: gg.branch, label: `the goal branch ${gg.branch}` };
  }

  private buildPrompt(g: GoalRec, rec: AgentRec, playbook?: string, startedFrom = ''): string {
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
        ...this.gitLines(g, rec, startedFrom),
      ].join('\n'),
    );
    return parts.join('\n\n');
  }

  private gitLines(g: GoalRec, rec: AgentRec, startedFrom: string): string[] {
    if (!g.git) {
      return [`- Git: no worktrees for this goal (${g.gitNote}). Everyone shares this directory, so agree on who edits which files, and run one implementer at a time.`];
    }
    const wt = rec.worktree;
    if (!wt) return rec.quick ? [`- This is ${rec.parent}'s worktree. Read it, but don't change it.`] : [];
    const sha = wt.base.slice(0, 7);
    const lines = [
      `- Git: this is your own worktree on branch ${wt.branch}, started from ${startedFrom} at ${sha} (${git.subject(g.git, sha)}).`,
      `- Teammates' branches are mh/${g.id}/<their name>, in the same repository, so you can diff or merge them straight away (no fetch).`,
    ];
    lines.push(
      rec.isLead
        ? `- ${wt.branch} is the goal branch. Merge the team's branches into it: it's what the human gets.`
        : `- The goal branch is ${g.git.branch}. The lead merges into it.`,
    );
    return lines;
  }

  /**
   * The brief plus a short reminder of who the agent is and how to report back. Some models
   * follow the first user message far more closely than their system instructions (seen with
   * gpt-6-luna), so the essentials appear in both.
   */
  private firstMessage(rec: AgentRec): string {
    const spawner = rec.parent === 'human' ? 'the human' : rec.parent;
    const lines = [
      rec.brief,
      '',
      '---',
      `[MetaHarness] You are ${rec.name}, the ${rec.role.name} on a team of agents. Your role:`,
      rec.role.instructions,
      '',
      rec.quick
        ? 'When you have the answer, call the MetaHarness `done` tool with it as the note.'
        : `Use the MetaHarness tools: \`send\` to ask ${spawner} if anything is unclear, \`status\` for progress, and \`done\` with a short note when you finish.`,
    ];
    if (rec.worktree) {
      lines.push(
        rec.isLead
          ? `You work in your own git worktree on ${rec.worktree.branch}, the goal branch. Merge teammates' branches into it before you call \`done\`.`
          : `You work in your own git worktree on branch ${rec.worktree.branch}. Commit your work there before you call \`done\`.`,
      );
    }
    return lines.join('\n');
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
      approval: (tool, detail) => this.requestApproval(rec, tool, detail),
    };
  }

  /** Which agent an MCP token belongs to. */
  agentForToken(token: string): { goal: string; agent: string } | undefined {
    return this.tokens.get(token);
  }

  /** Puts a permission request in the human's Inbox and resolves when they decide. */
  requestApproval(rec: AgentRec, tool: string, detail: string): Promise<ApprovalDecision> {
    const g = this.goals.get(rec.goal)!;
    const item = this.toHuman(g, rec.name, 'approval', `${tool}: ${detail}`);
    rec.pendingApprovals++;
    return new Promise(resolve => {
      this.approvals.set(item.id, d => {
        rec.pendingApprovals--;
        resolve(d);
      });
    });
  }

  /** Answers or dismisses an Inbox item. Approvals unblock the agent that asked. */
  resolveInbox(itemId: string, decision: 'approve' | 'deny' | 'dismiss', reply?: string): string {
    const i = this.humanInbox.findIndex(x => x.id === itemId || x.id.startsWith(itemId));
    if (i < 0) return `There's no Inbox item ${itemId}.`;
    const item = this.humanInbox[i];
    this.humanInbox.splice(i, 1);
    this.emit({ goal: item.goal, agent: item.agent, type: 'inbox.resolved', data: { id: item.id, decision, reply: reply ?? null } });
    const pending = this.approvals.get(item.id);
    if (pending) {
      this.approvals.delete(item.id);
      pending({ allow: decision === 'approve', message: reply ?? (decision === 'approve' ? undefined : 'The human denied this.') });
      return decision === 'approve' ? `Approved for ${item.agent}.` : `Denied for ${item.agent}.`;
    }
    if (reply) this.deliver(item.goal, 'human', item.agent, reply);
    return reply ? `Answered ${item.agent}.` : 'Dismissed.';
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
      if (rec.isLead) note += this.branchSummary(g);
      this.toHuman(g, rec.name, kind, note);
      if (rec.isLead && how === 'done') g.resolveLeadDone(note);
      return;
    }
    const parent = g.agents.get(rec.parent);
    if (!parent) return;
    this.enqueue(parent, { id: randomUUID(), kind: 'done', from: rec.name, text: note, urgent: false, ts: new Date().toISOString() });
  }

  /** For the human: where the team's work is, and which branches haven't been merged into it. */
  private branchSummary(g: GoalRec): string {
    if (!g.git) return '';
    const gg = g.git;
    const ahead = git.countCommits(gg, gg.base, gg.branch);
    const lead = g.agents.get(g.lead)?.worktree?.path;
    const lines = [
      ahead
        ? `The team's work is on branch ${gg.branch}, ${ahead} commit${ahead > 1 ? 's' : ''} ahead of where the goal started${lead ? ` (worktree: ${lead})` : ''}.`
        : `There are no commits on ${gg.branch} yet${lead ? `. Uncommitted work may be in ${lead}` : ''}.`,
    ];
    const unmerged = [...git.goalBranches(gg, g.id).keys()]
      .filter(b => b !== gg.branch)
      .map(b => ({ b, n: git.countCommits(gg, gg.branch, b) }))
      .filter(x => x.n > 0);
    if (unmerged.length) lines.push(`Not merged into it: ${unmerged.map(x => `${x.b} (${x.n} commit${x.n > 1 ? 's' : ''})`).join(', ')}.`);
    return '\n\n' + lines.join(' ');
  }

  /**
   * Turns new commits on the goal branches into git.commit and git.merge events. Best effort:
   * it compares branch tips with the last look, on a timer.
   */
  refreshGit(goalId?: string): void {
    for (const g of this.goals.values()) {
      if (!g.git || (goalId && g.id !== goalId)) continue;
      try {
        this.refreshGoalGit(g, g.git);
      } catch {
        // The repository may be mid-operation; try again next time.
      }
    }
  }

  private refreshGoalGit(g: GoalRec, gg: git.GoalGit): void {
    const tips = git.goalBranches(gg, g.id);
    // The goal branch last, so commits merged into it have already been seen on their own branch.
    const order = [...tips.keys()].sort((a, b) => Number(a === gg.branch) - Number(b === gg.branch));
    for (const branch of order) {
      const sha = tips.get(branch)!;
      const old = g.refs.get(branch);
      g.refs.set(branch, sha);
      if (!old || old === sha) continue;
      const owner = [...g.agents.values()].find(a => a.worktree?.branch === branch)?.name;
      // Name a merge after the branch its commit was made on. Several branches can point at the
      // same commit (a reviewer's starts at the implementer's tip), so asking git is a last resort.
      const merged = (from: string, sha: string, fastForward?: boolean) =>
        this.emit({
          goal: g.id, agent: owner, type: 'git.merge',
          data: {
            from: g.seenOn.get(from) ?? git.branchOf(gg, g.id, from, branch) ?? from.slice(0, 7),
            into: branch, sha, ...(fastForward ? { fastForward } : {}),
          },
        });
      // Commits already reported on another branch arrived here by a fast-forward merge.
      let fastForwarded = '';
      for (const c of git.commitsBetween(gg, old, sha)) {
        if (g.seenOn.has(c.sha)) {
          fastForwarded = c.sha;
          continue;
        }
        if (fastForwarded) merged(fastForwarded, fastForwarded, true);
        fastForwarded = '';
        g.seenOn.set(c.sha, branch);
        this.emit({ goal: g.id, agent: owner, type: 'git.commit', data: { branch, sha: c.sha, summary: c.summary } });
        if (c.mergedSha) merged(c.mergedSha, c.sha);
      }
      if (fastForwarded) merged(fastForwarded, fastForwarded, true);
    }
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

  private toHuman(g: GoalRec, agent: string, kind: HumanInboxItem['kind'], text: string): HumanInboxItem {
    const item: HumanInboxItem = { id: randomUUID().slice(0, 8), goal: g.id, agent, kind, text, ts: new Date().toISOString() };
    this.humanInbox.push(item);
    this.emit({ goal: g.id, agent, type: 'inbox.item', data: { id: item.id, kind, text } });
    return item;
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
        branch: g.git?.branch ?? null,
        notice: this.goalNotice(g) ?? null,
        agents: [...g.agents.values()].map(a => ({
          name: a.name,
          role: a.role.name,
          harness: a.harness,
          model: a.model,
          parent: a.parent,
          state: a.state,
          status: a.status,
          quick: a.quick,
          branch: a.worktree?.branch ?? null,
          cwd: a.cwd,
          cost: a.cost ?? null,
          contextPct: a.contextPct ?? null,
          unread: a.inbox.length,
          awaitingApproval: a.pendingApprovals,
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
        const goal = this.startGoal({ request, lead: s('lead'), playbook: s('playbook') });
        return { goal, notice: this.goalNotice(this.goals.get(goal)!) ?? null };
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
      case 'inbox.resolve': {
        const item = s('item');
        const decision = s('decision') ?? 'dismiss';
        if (!item) throw new Error('inbox.resolve needs "item".');
        if (!['approve', 'deny', 'dismiss'].includes(decision)) throw new Error('decision must be approve, deny or dismiss.');
        return { result: this.resolveInbox(item, decision as 'approve' | 'deny' | 'dismiss', s('reply')) };
      }
      default:
        throw new Error(`Unknown command "${String(b.cmd)}". Commands: goal.start, agent.message, agent.stop, inbox.resolve.`);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.gitTimer);
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
