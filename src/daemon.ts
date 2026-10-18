import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventStore } from './store.ts';
import { loadConfig, type Config } from './config.ts';
import { resolveName } from './fuzzy.ts';
import { Hub } from './hub.ts';
import * as git from './git.ts';
import type { AgentState, MhEvent, NewEvent, Role } from './types.ts';
import type { ApprovalDecision, HarnessAdapter, HookRequest, RateLimitInfo, Session, SessionEvents, ToolRequest } from './adapters/types.ts';
import { MCP_SERVER_NAME } from './mcp.ts';
import { readOnlyCommand } from './readonly.ts';
import { goalOver, INTERRUPTED, replayGoal, type AgentReplay, type GoalReplay } from './recover.ts';
import { SharedFolder } from './shared.ts';
import { cleanGoal, describeClean, type CleanResult } from './clean.ts';
import { guardEnv, installGuard, refusedGitCommand } from './guard.ts';

export interface InboxEntry {
  id: string;
  /** notice: from MetaHarness itself, e.g. a rate-limit warning. */
  kind: 'message' | 'done' | 'notice';
  from: string;
  text: string;
  urgent: boolean;
  ts: string;
}

/** A change in the shared folder an agent hasn't heard about yet. */
interface FileNote {
  path: string;
  by?: string;
  at: number;
  deleted: boolean;
  /** Set when the change was a clash: someone other than the owner wrote the file. */
  clash?: { owner: string; by: string; previous?: string };
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
  /** Spend by the agent's earlier sessions, before it moved to another harness. */
  costBefore?: number;
  contextPct?: number;
  lastText: string;
  adapter: HarnessAdapter;
  session?: Session;
  /** A native session to resume the next time the agent needs one (after the daemon restarted). */
  resumeId?: string;
  /** Bumped whenever the agent gets a new session; events from older sessions are ignored. */
  gen: number;
  /** The agent's MCP credential. It survives a move to another harness. */
  token: string;
  systemPrompt: string;
  /** A first message waiting for the account's limit to reset before the session starts. */
  pendingBrief?: string;
  /** While rate limited: when the agent continues by itself. */
  limitedUntil?: number;
  limitTimer?: NodeJS.Timeout;
  /** An urgent message is waiting for the interrupted turn to end. */
  interrupting?: boolean;
  inbox: InboxEntry[];
  waiters: Waiter[];
  /** Callers blocked in a quick spawn, waiting for this agent's answer. */
  doneWaiters: ((note: string) => void)[];
  doneNote?: string;
  /** Permission requests waiting in the human's Inbox. */
  pendingApprovals: number;
  /** Shared-folder changes by others since the agent last heard, by path. They don't wake it. */
  fileNotes: Map<string, FileNote>;
}

export interface GoalRec {
  id: string;
  request: string;
  /** Where the agents work: the daemon's repository, or another directory (harness tests use a scratch one). */
  dir: string;
  lead: string;
  createdAt: string;
  sharedDir: string;
  /** Git state for worktrees; unset when the repository can't have them (see gitNote). */
  git?: git.GoalGit;
  gitNote?: string;
  /** Last seen tip of each goal branch, and the branch each reported commit was made on, for git events. */
  refs: Map<string, string>;
  seenOn: Map<string, string>;
  /** The last agent in the human's checkout to run a git command that commits, so its commits are named after it. */
  gitActor?: { agent: string; at: number };
  /** Merges (and the like) stopped on conflicts, by the folder they're in. */
  conflicts: Map<string, OpenConflict>;
  /** The shared folder's files and their history. */
  shared: SharedFolder;
  /** Recent tool calls that named a shared file, to tell who wrote it. */
  sharedTouches: { agent: string; at: number; summary: string }[];
  /** The workflow the lead was given, if any. */
  workflow?: string;
  status: 'running' | 'ended';
  agents: Map<string, AgentRec>;
  counters: Map<string, number>;
  /** The lead finished while teammates still worked: clean up once they're done too. */
  cleanWhenIdle?: boolean;
  /** Resolves when the lead calls done. */
  leadDone: Promise<string>;
  resolveLeadDone: (note: string) => void;
}

export interface HumanInboxItem {
  id: string;
  goal: string;
  agent: string;
  /** decision: an agent asks the human to approve something (send with decision: true). */
  kind: 'question' | 'decision' | 'approval' | 'done' | 'stopped' | 'crash';
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
  /** How often to look at the goal branches and the shared folder. 0 turns polling off (tests call refreshGit and refreshShared). */
  pollMs?: number;
  limits?: Partial<LimitPolicy>;
  /** Remove worktrees and merged branches when a goal's lead finishes (default true). */
  autoClean?: boolean;
}

/** What to do as an account nears or hits its rate limit (design §16). */
export interface LimitPolicy {
  /** Ask agents to write where they are once usage reaches this percent. */
  warnPct: number;
  /** Wait for a reset this close; move to a backup if it's further away. */
  waitMaxMs: number;
  /** When the reset time is unknown, try again after this long. */
  retryMs: number;
  /** Continue this long after the reset time, to allow for clock differences. */
  marginMs: number;
}

/** One harness login. Its rate limit is shared by every agent that uses it. */
export interface AccountRec {
  id: string;
  status: RateLimitInfo['status'];
  usedPct?: number;
  resetsAt?: number;
  window?: string;
  /** Agents (goal/name) already asked to write their notes in this window. */
  warned: Set<string>;
}

interface Route {
  harness: string;
  model: string;
}

type SpawnResult =
  | { ok: true; name: string; rec: AgentRec; guessedRole?: string; note?: string }
  | { ok: false; error: string };

interface OpenConflict {
  op: git.Conflict['op'];
  sha?: string;
  branch: string;
  agent?: string;
}

const FINISHED: AgentState[] = ['ended', 'crashed'];

/** How long after a tool call that names a shared file a change to it is put down to that agent. */
const SHARED_TOUCH_MS = 120_000;

/** A shell command that runs git to make commits: commit, merge and the like. */
const GIT_COMMITS = /\bgit\b[^|;&\n]*?\s(?:commit|merge|cherry-pick|revert|pull|rebase|am)\b/;
/** How long after such a command a new commit in the checkout is put down to that agent. */
const GIT_ACTOR_MS = 120_000;

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
  private pollMs: number;
  private pollTimer?: NodeJS.Timeout;
  readonly accounts = new Map<string, AccountRec>();
  readonly limits: LimitPolicy;
  /** Git hooks that keep agents from deleting branches, rewinding shared ones, or pushing. */
  readonly guardDir: string;
  private autoClean: boolean;

  constructor(o: DaemonOptions) {
    this.home = o.home;
    this.repo = o.repo;
    mkdirSync(o.home, { recursive: true });
    this.store = new EventStore(o.dbPath ?? join(o.home, 'mh.db'));
    this.config = loadConfig(o.configDirs ?? [o.home, join(o.repo, '.metaharness')]);
    this.adapters = o.adapters ?? {};
    this.harnessOverride = o.harnessOverride;
    this.quickTimeoutMs = o.quickTimeoutMs ?? 120_000;
    this.pollMs = o.pollMs ?? 3000;
    this.limits = { warnPct: 90, waitMaxMs: 15 * 60_000, retryMs: 15 * 60_000, marginMs: 5000, ...o.limits };
    this.hub = new Hub(this);
    this.guardDir = installGuard(o.home);
    this.autoClean = o.autoClean ?? true;
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

  /**
   * `workflow` is the guide the lead follows (none: it picks one). `leadDef` runs the lead from a
   * role that isn't in the config, and `dir` works somewhere other than the repository (both for
   * harness tests).
   */
  startGoal(o: { request: string; lead?: string; workflow?: string; playbook?: string; leadDef?: Role; dir?: string }): string {
    const workflow = o.workflow ?? o.playbook;
    if (workflow && !resolveName(workflow, [...this.config.workflows.keys()]).match) {
      const names = [...this.config.workflows.keys()];
      throw new Error(`There's no workflow called "${workflow}". Workflows: ${names.join(', ') || 'none (add .metaharness/workflows/<name>.md)'}.`);
    }
    const id = randomUUID().slice(0, 8);
    const sharedDir = join(this.home, 'goals', id, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    let resolveLeadDone!: (note: string) => void;
    const leadDone = new Promise<string>(r => (resolveLeadDone = r));
    const g: GoalRec = {
      id, request: o.request, dir: o.dir ?? this.repo, lead: '', createdAt: new Date().toISOString(), sharedDir,
      refs: new Map(), seenOn: new Map(), workflow, conflicts: new Map(), shared: new SharedFolder(sharedDir), sharedTouches: [],
      status: 'running', agents: new Map(), counters: new Map(), leadDone, resolveLeadDone,
    };
    const gs = git.setupGoal(g.dir, id);
    if ('reason' in gs) g.gitNote = gs.reason;
    else {
      g.git = gs;
      g.refs.set(gs.branch, gs.base);
    }
    this.goals.set(id, g);
    const leadRole = o.leadDef?.name ?? o.lead ?? 'architect';
    this.emit({
      goal: id, type: 'goal.started',
      data: {
        request: o.request, lead: leadRole, workflow: workflow ?? null, sharedDir, dir: g.dir,
        branch: g.git?.branch ?? null, base: g.git?.base ?? null, notice: this.goalNotice(g) ?? null,
      },
    });
    const r = this.spawnAgent(id, { role: leadRole, roleDef: o.leadDef, brief: o.request, parent: 'human', isLead: true, workflow });
    if (!r.ok) {
      g.status = 'ended';
      this.emit({ goal: id, type: 'goal.ended', data: { reason: r.error } });
      throw new Error(r.error);
    }
    g.lead = r.name;
    this.startPolling();
    return id;
  }

  /** What the human should know about where the agents' work happens. */
  goalNotice(g: GoalRec): string | undefined {
    if (!g.git) return `The team works in ${g.dir}. No worktrees for this goal: ${g.gitNote}.`;
    const where = `The team works in your checkout, ${g.dir}, on ${g.git.branch === 'HEAD' ? 'a detached HEAD' : g.git.branch}.`;
    return g.git.dirty ? `${where} You have uncommitted changes: the agents will see them and may change them.` : where;
  }

  spawnAgent(
    goalId: string,
    o: {
      role: string; roleDef?: Role; brief: string; parent: string; name?: string; quick?: boolean; isLead?: boolean; workflow?: string;
      /** Its own git worktree instead of the shared folder. Default: the role's setting, or yes when `from` is given. */
      worktree?: boolean; from?: string;
    },
  ): SpawnResult {
    const g = this.goals.get(goalId);
    if (!g) return { ok: false, error: `There's no goal ${goalId}.` };
    const roleNames = [...this.config.roles.keys()];
    const res = o.roleDef ? { match: o.roleDef.name, guessed: false, suggestions: [] } : resolveName(o.role, roleNames);
    if (!o.roleDef && !roleNames.length) return { ok: false, error: 'No roles are defined yet. Add one as .metaharness/roles/<name>.md.' };
    if (!res.match) {
      const hint = res.suggestions.length ? ` Did you mean ${res.suggestions[0]}?` : '';
      return { ok: false, error: `There's no role called "${o.role}".${hint} Roles you can spawn: ${roleNames.join(', ')}.` };
    }
    const role = o.roleDef ?? this.config.roles.get(res.match)!;
    const picked = this.pickRoute(role);
    if ('error' in picked) return { ok: false, error: picked.error };
    const { harness, model } = picked.route;
    const adapter = this.adapters[harness];

    const n = (g.counters.get(role.name) ?? 0) + 1;
    g.counters.set(role.name, n);
    // Names end up in branch names, so keep them to safe characters. "main" is the goal branch.
    let name = o.name?.trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || (o.isLead ? role.name : `${role.name}-${n}`);
    while (g.agents.has(name) || name === 'main') name = `${name}-${n}`;
    const parentRec = g.agents.get(o.parent);

    // Like native subagents, everyone works in the goal's folder (design §17). Quick helpers use
    // their caller's, and a worktree on mh/<goal>/<name> is there for whoever asks for one: a
    // workflow running code writers in parallel, or a reviewer starting `from` someone's branch.
    let cwd = g.dir;
    let worktree: git.Worktree | undefined;
    let startedFrom = '';
    let deps: string[] = [];
    let note = picked.note;
    const wantWorktree = !o.quick && !o.isLead && (o.worktree ?? (role.worktree || !!o.from));
    if (o.quick && parentRec) cwd = parentRec.cwd;
    else if (wantWorktree && !g.git) {
      note = [note, `${name} works in the shared folder, because there are no worktrees here: ${g.gitNote}.`].filter(Boolean).join(' ');
    } else if (wantWorktree && g.git) {
      const start = this.startPoint(g, parentRec, o.from);
      if ('error' in start) return { ok: false, error: start.error };
      try {
        const path = join(this.home, 'goals', goalId, 'worktrees', name);
        worktree = git.addWorktree(g.git, path, git.agentBranch(goalId, name), start.ref);
      } catch (e) {
        return { ok: false, error: `Couldn't create a git worktree for ${name}: ${(e as Error).message.trim()}` };
      }
      cwd = worktree.path;
      startedFrom = start.label;
      g.refs.set(worktree.branch, worktree.base);
      deps = worktree.deps = git.copyDependencies(g.git, worktree.path);
    }

    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, { goal: goalId, agent: name });
    const rec: AgentRec = {
      goal: goalId, name, role, harness, model, parent: o.parent, brief: o.brief,
      quick: !!o.quick, isLead: !!o.isLead, cwd, worktree, state: 'starting', status: '', lastText: '',
      adapter, gen: 0, token, systemPrompt: '', inbox: [], waiters: [], doneWaiters: [], pendingApprovals: 0, fileNotes: new Map(),
    };
    rec.systemPrompt = this.buildPrompt(g, rec, o.workflow, startedFrom);
    g.agents.set(name, rec);
    this.emit({
      goal: goalId, agent: name, parent: o.parent, type: 'agent.spawned',
      data: {
        role: role.name, harness, model, brief: o.brief, quick: !!o.quick, cwd,
        worktree: worktree?.path ?? null, branch: worktree?.branch ?? null, base: worktree?.base ?? null,
        ...(startedFrom ? { startedFrom } : {}), ...(deps.length ? { deps } : {}), ...(note ? { note } : {}),
      },
    });

    const brief = this.firstMessage(rec);
    if (this.accountLimited(harness, model)) {
      // Every route is at its limit: start once this one resets.
      rec.pendingBrief = brief;
      this.hitLimit(rec);
    } else this.startSession(rec, brief);

    return { ok: true, name, rec, guessedRole: res.guessed ? res.match : undefined, note };
  }

  /**
   * Starts (or resumes) a native session for an agent. Events from any earlier session of the
   * same agent are ignored from here on.
   */
  private startSession(rec: AgentRec, brief: string, resume = rec.resumeId): void {
    const g = this.goals.get(rec.goal)!;
    const gen = ++rec.gen;
    rec.pendingBrief = undefined;
    rec.resumeId = undefined;
    rec.adapter
      .start(
        {
          goal: rec.goal, agent: rec.name, role: rec.role, model: rec.model, systemPrompt: rec.systemPrompt, brief,
          cwd: rec.cwd, sharedDir: g.sharedDir, mcpUrl: this.mcpBase ? `${this.mcpBase}/mcp/${rec.token}` : '',
          hookUrl: this.mcpBase ? `${this.mcpBase}/hook/${rec.token}` : '', agentDir: this.agentDir(rec),
          mcpServers: rec.role.mcp.map(name => ({ name, def: this.config.mcp.get(name) })),
          gitDirs: rec.worktree && g.git ? [g.git.commonDir, rec.worktree.gitDir] : [],
          env: g.git ? guardEnv(this.guardDir, rec.worktree?.branch, g.git.repo) : undefined,
          callTool: (tool, args) => this.hub.call(rec.goal, rec.name, tool, args),
        },
        this.sessionEvents(rec, gen),
        resume ? { resume } : {},
      )
      .then(session => {
        if (rec.gen !== gen) return void session.stop().catch(() => {});
        rec.session = session;
        this.emit({
          goal: rec.goal, agent: rec.name, type: 'agent.session',
          data: { nativeSession: session.nativeId, harness: rec.harness, model: rec.model, ...(resume ? { resumed: true } : {}) },
        });
        this.pump(rec);
      })
      .catch((err: Error) => {
        // A session that dies while starting may already have reported its exit.
        if (rec.gen !== gen || FINISHED.includes(rec.state)) return;
        this.setState(rec, 'crashed');
        this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.crashed', data: { reason: `Couldn't start: ${err.message}` } });
        this.finish(rec, `${rec.name} couldn't start: ${err.message}`, 'crashed');
      });
  }

  /** A role's primary harness and model, then its backups, as written in the role. */
  routes(role: Role): Route[] {
    const out: Route[] = [{ harness: role.harness, model: role.model }];
    for (const f of role.fallback) {
      const slash = f.indexOf('/');
      out.push(slash > 0 ? { harness: f.slice(0, slash), model: f.slice(slash + 1) } : { harness: role.harness, model: f });
    }
    if (this.harnessOverride) for (const r of out) r.harness = this.harnessOverride;
    return out.filter((r, i) => out.findIndex(x => x.harness === r.harness && x.model === r.model) === i);
  }

  /** The first route that can run now; else the first that can run at all (it waits for its reset). */
  private pickRoute(role: Role): { route: Route; note?: string } | { error: string } {
    const all = this.routes(role);
    const runnable = all.filter(r => this.adapters[r.harness]);
    if (!runnable.length) {
      const missing = [...new Set(all.map(r => r.harness))].join(', ');
      return { error: `MetaHarness can't run ${missing} yet, so ${role.name} can't be started. Run mh doctor to see which harnesses work here, or start the daemon with --fake to use scripted agents.` };
    }
    const route = runnable.find(r => !this.accountLimited(r.harness, r.model)) ?? runnable[0];
    if (route === all[0]) return { route };
    const why = this.adapters[all[0].harness] ? `${all[0].harness} is at its limit` : `MetaHarness can't run ${all[0].harness} yet`;
    return { route, note: `${role.name} runs on its backup ${route.harness} · ${route.model}, because ${why}.` };
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
      return { error: `"from" should be a teammate with their own worktree, or a branch, and there's no "${from}". Teammates with worktrees: ${mates.join(', ') || 'none'}.` };
    }
    if (parent?.worktree) return { ref: parent.worktree.branch, label: `${parent.name}'s branch ${parent.worktree.branch}` };
    return { ref: gg.branch, label: `the goal branch ${gg.branch}` };
  }

  private buildPrompt(g: GoalRec, rec: AgentRec, workflow?: string, startedFrom = ''): string {
    const parts = [rec.role.helper ? this.config.helperMethodology : this.config.methodology];
    parts.push(`## Your role: ${rec.role.name}\n\n${rec.role.instructions}`);
    // The lead runs the goal's workflow; any role can have one of its own.
    for (const name of [rec.isLead ? workflow : undefined, rec.role.workflow]) {
      const w = name ? this.config.workflows.get(resolveName(name, [...this.config.workflows.keys()]).match ?? '') : undefined;
      if (w) parts.push(`## Workflow: ${w.name}\n\nFollow this guide, adapting it to the task. When it says to continue with another workflow, read that one with the \`workflow\` tool.\n\n${w.body}`);
    }
    if (rec.isLead && !workflow && this.config.workflows.size) {
      const list = [...this.config.workflows.values()].map(w => `- ${w.name}: ${w.goodAt || '—'}`).join('\n');
      parts.push(`## Workflows\n\nGuides for running kinds of tasks. If one fits this goal, read it with the \`workflow\` tool and follow it.\n\n${list}`);
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
    if (rec.quick) return [`- This is ${rec.parent}'s working folder. Read it, but don't change it.`];
    if (!g.git) return [`- Git: none here (${g.gitNote}). Everyone works in this folder, so agree on who edits which files.`];
    const branch = g.git.branch === 'HEAD' ? 'a detached HEAD' : `branch ${g.git.branch}`;
    const lead = rec.isLead ? 'you' : g.lead || 'the lead';
    const wt = rec.worktree;
    if (wt) {
      const sha = wt.base.slice(0, 7);
      return [
        `- Git: this is your own worktree on branch ${wt.branch}, started from ${startedFrom} at ${sha} (${git.subject(g.git, sha)}). Teammates don't see your changes until you commit.`,
        `- Commit your work there. ${lead === 'you' ? 'You merge' : `${lead} merges`} your branch into ${g.git.branch} in the human's checkout, ${g.dir}.`,
        `- Other teammates' branches are mh/${g.id}/<their name>, in the same repository, so you can diff or merge them straight away (no fetch).`,
        ...depsLines(wt.deps ?? []),
      ];
    }
    const lines = [
      `- Git: this is the human's checkout, on ${branch}, and teammates work in it too. You see each other's changes as they're made, so agree on who edits which files, and commit only your own (\`git add <your files>\`, never \`git add -A\`).`,
    ];
    if (rec.isLead) {
      lines.push(`- Teammates you spawn with \`worktree: true\` get their own worktree and commit on mh/${g.id}/<their name>. Merge their branches into ${g.git.branch} when they're done: what's here is what the human gets.`);
    }
    return lines;
  }

  /**
   * The brief plus a short reminder of who the agent is and how to report back. Some models
   * follow the first user message far more closely than their system instructions (seen with
   * gpt-6-luna), so the essentials appear in both.
   */
  private firstMessage(rec: AgentRec, brief = rec.brief): string {
    const spawner = rec.parent === 'human' ? 'the human' : rec.parent;
    const lines = [
      brief,
      '',
      '---',
      `[MetaHarness] You are ${rec.name}, the ${rec.role.name} on a team of agents. Your role:`,
      rec.role.instructions,
      '',
      rec.quick
        ? 'When you have the answer, call the MetaHarness `done` tool with it as the note.'
        : `Use the MetaHarness tools: \`send\` to ask ${spawner} if anything is unclear, \`status\` for progress, and \`done\` with a short note when you finish.`,
    ];
    if (rec.worktree) lines.push(`You work in your own git worktree on branch ${rec.worktree.branch}. Commit your work there before you call \`done\`.`);
    else if (!rec.quick && this.goals.get(rec.goal)?.git) {
      lines.push("You work in the human's checkout alongside teammates: commit only the files you changed.");
    }
    return lines.join('\n');
  }

  /** Callbacks for one session of an agent. Once the agent has a newer session, they do nothing. */
  private sessionEvents(rec: AgentRec, gen: number): SessionEvents {
    const base = { goal: rec.goal, agent: rec.name };
    const live = () => rec.gen === gen;
    return {
      turnStarted: () => {
        if (live() && !FINISHED.includes(rec.state) && rec.state !== 'paused' && rec.state !== 'limited') this.setState(rec, 'working');
      },
      turnEnded: () => {
        if (!live() || FINISHED.includes(rec.state)) return;
        // A turn refused at the rate limit isn't the agent stopping: it continues later.
        if (rec.state === 'limited') return;
        if (rec.doneNote !== undefined) this.setState(rec, 'done');
        else if (!rec.interrupting) this.endedTurnWithoutDone(rec);
        this.pump(rec);
      },
      text: text => {
        if (!live()) return;
        rec.lastText = text;
        this.emit({ ...base, type: 'agent.text', data: { text } });
      },
      toolCall: (tool, summary) => {
        if (!live()) return;
        this.noteGitActor(rec, summary);
        this.noteSharedTouch(rec, summary);
        this.emit({ ...base, type: 'agent.tool_call', data: { tool, summary } });
      },
      toolResult: (summary, ok) => live() && void this.emit({ ...base, type: 'agent.tool_result', data: { summary, ok } }),
      usage: u => {
        if (!live()) return;
        if (u.costUsd !== undefined) rec.cost = (rec.costBefore ?? 0) + u.costUsd;
        if (u.contextPct !== undefined) rec.contextPct = u.contextPct;
        this.emit({ ...base, type: 'usage', data: { ...u } });
      },
      rateLimit: info => live() && this.onRateLimit(rec, info),
      exited: (reason, detail) => {
        if (!live() || FINISHED.includes(rec.state)) return;
        const state = reason === 'crashed' ? 'crashed' : 'ended';
        this.setState(rec, state);
        this.emit({ ...base, type: `agent.${state}`, data: { reason: detail ?? reason } });
        if (rec.doneNote === undefined) {
          const note = rec.lastText ? `${rec.name} ${state} before calling done. Its last message: ${rec.lastText}` : `${rec.name} ${state} before calling done.`;
          this.finish(rec, note, state);
        }
      },
      approval: (tool, detail) => (live() ? this.requestApproval(rec, tool, detail) : Promise.resolve({ allow: false, message: 'This session was replaced.' })),
    };
  }

  /** Which agent an MCP token belongs to. */
  agentForToken(token: string): { goal: string; agent: string } | undefined {
    return this.tokens.get(token);
  }

  /** Puts a permission request in the human's Inbox and resolves when they decide. */
  requestApproval(rec: AgentRec, tool: string, detail: string): Promise<ApprovalDecision> {
    const refused = tool === 'Bash' ? refusedGitCommand(detail) : undefined;
    if (refused) {
      this.emit({ goal: rec.goal, agent: rec.name, type: 'approval.refused', data: { tool, detail: detail.slice(0, 2000), why: refused } });
      return Promise.resolve({ allow: false, message: refused });
    }
    // Commands that only read don't need the human (design §10), whichever harness asks.
    if (tool === 'Bash' && rec.role.autoApprove !== 'none' && readOnlyCommand(detail).readOnly) {
      this.emit({ goal: rec.goal, agent: rec.name, type: 'approval.auto', data: { tool, detail: detail.slice(0, 2000), why: 'read-only' } });
      return Promise.resolve({ allow: true });
    }
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
    if (item.kind === 'decision' && decision !== 'dismiss') {
      const answer = decision === 'approve' ? `Approved.${reply ? ` ${reply}` : ''}` : `Not approved.${reply ? ` What to change: ${reply}` : ''}`;
      this.deliver(item.goal, 'human', item.agent, answer);
      return `${decision === 'approve' ? 'Approved' : 'Sent back'} for ${item.agent}.`;
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
    if (['done', 'idle', 'ended', 'crashed'].includes(state)) this.cleanUpIfIdle(this.goals.get(rec.goal)!);
  }

  /* ---------------- tools (called through the hub) ---------------- */

  /** Records an agent's done. Returns a warning for the agent, or ''. */
  done(rec: AgentRec, note: string): string {
    const conflict = this.openConflict(rec);
    if (conflict) note += `\n\n(MetaHarness: when ${rec.name} called done, ${conflict}.)`;
    rec.doneNote = note;
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.done', data: { note } });
    // The state turns to "done" when the turn ends; until then the agent is still wrapping up.
    if (!rec.session?.busy()) this.setState(rec, 'done');
    this.finish(rec, note, 'done');
    return conflict ? `Note: ${conflict}. Finish it (resolve the files, then commit) or abort it, then call done again with an updated note.` : '';
  }

  /** Hands an agent's result to whoever is waiting for it: a quick-spawn caller, its spawner, or the human. */
  private finish(rec: AgentRec, note: string, how: 'done' | 'idle' | 'ended' | 'crashed'): void {
    const quick = rec.doneWaiters.splice(0);
    for (const w of quick) w(note);
    if (quick.length) return;
    const g = this.goals.get(rec.goal)!;
    if (rec.parent === 'human') {
      const kind = how === 'done' || how === 'idle' ? 'done' : how === 'crashed' ? 'crash' : 'stopped';
      if (rec.isLead) note += this.branchSummary(g) + (how === 'done' ? this.cleanUpAfterGoal(g) : '');
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
    const dirty = git.statusShort(g.dir).length;
    const where = gg.branch === 'HEAD' ? 'the detached HEAD' : gg.branch;
    const lines = [
      (ahead ? `The team's work is in ${g.dir} on ${where}: ${ahead} commit${ahead > 1 ? 's' : ''} since the goal started` : `There are no new commits on ${where}`) +
        (dirty ? `, and ${dirty} uncommitted change${dirty > 1 ? 's' : ''} in ${g.dir}.` : '.'),
    ];
    const unmerged = [...git.goalBranches(gg, g.id).keys()]
      .map(b => ({ b, n: git.countCommits(gg, gg.branch, b) }))
      .filter(x => x.n > 0);
    if (unmerged.length) lines.push(`Worktree branches not merged into it: ${unmerged.map(x => `${x.b} (${x.n} commit${x.n > 1 ? 's' : ''})`).join(', ')}.`);
    const c = git.operationInProgress(g.dir, gg.gitDir);
    if (c) lines.push(`A ${c.op} is still in progress in ${g.dir}${c.files.length ? `, with conflicts in ${c.files.slice(0, 10).join(', ')}` : ''}.`);
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
    // The branch the team shares, in the human's checkout.
    const head = git.resolveCommit(gg, gg.branch);
    if (head) tips.set(gg.branch, head);
    // The goal branch last, so commits merged into it have already been seen on their own branch.
    const order = [...tips.keys()].sort((a, b) => Number(a === gg.branch) - Number(b === gg.branch));
    for (const branch of order) {
      const sha = tips.get(branch)!;
      const old = g.refs.get(branch);
      g.refs.set(branch, sha);
      if (!old || old === sha) continue;
      const owner = [...g.agents.values()].find(a => a.worktree?.branch === branch)?.name ?? (branch === gg.branch ? this.checkoutActor(g) : undefined);
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
    this.refreshConflicts(g, gg);
  }

  /** Looks at git and the shared folders every few seconds, once there's a goal. */
  private startPolling(): void {
    if (this.pollMs <= 0 || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.refreshGit();
      this.refreshShared();
    }, this.pollMs).unref();
  }

  /**
   * Turns merges (cherry-picks, reverts, rebases) that stop on conflicts into git.conflict
   * events, in the checkout and every worktree, and reports how each one ended.
   */
  private refreshConflicts(g: GoalRec, gg: git.GoalGit): void {
    const places = [{ cwd: g.dir, gitDir: gg.gitDir, branch: gg.branch, agent: undefined as string | undefined }];
    for (const a of g.agents.values()) {
      if (a.worktree && existsSync(a.worktree.path)) places.push({ cwd: a.worktree.path, gitDir: a.worktree.gitDir, branch: a.worktree.branch, agent: a.name });
    }
    for (const p of places) {
      const now = git.operationInProgress(p.cwd, p.gitDir);
      const open = g.conflicts.get(p.cwd);
      if (now?.files.length && !open) {
        const agent = p.agent ?? this.checkoutActor(g);
        g.conflicts.set(p.cwd, { op: now.op, sha: now.sha, branch: p.branch, agent });
        const from = now.sha ? (g.seenOn.get(now.sha) ?? git.branchOf(gg, g.id, now.sha, p.branch) ?? now.sha.slice(0, 7)) : null;
        this.emit({ goal: g.id, agent, type: 'git.conflict', data: { op: now.op, branch: p.branch, from, sha: now.sha ?? null, files: now.files, dir: p.cwd } });
      } else if (open && !now) {
        g.conflicts.delete(p.cwd);
        const how = open.op === 'merge' && open.sha ? (git.containsCommit(p.cwd, open.sha) ? 'committed' : 'aborted') : 'finished';
        this.emit({ goal: g.id, agent: open.agent, type: 'git.conflict_resolved', data: { op: open.op, branch: open.branch, how, dir: p.cwd } });
      }
    }
  }

  /** For an agent calling done: a merge it left stopped on conflicts, if any. */
  private openConflict(rec: AgentRec): string {
    const g = this.goals.get(rec.goal)!;
    if (!g.git || rec.quick) return '';
    // In the shared checkout, only the agent that ran the merge is asked about it.
    if (!rec.worktree && this.checkoutActor(g) !== rec.name) return '';
    const c = git.operationInProgress(rec.cwd, rec.worktree?.gitDir ?? g.git.gitDir);
    if (!c) return '';
    const files = c.files.length ? ` with conflicts in ${c.files.slice(0, 10).join(', ')}${c.files.length > 10 ? '…' : ''}` : ', not committed yet';
    return `a ${c.op} is still in progress in ${rec.cwd}${files}`;
  }

  /**
   * Finds what changed in each goal's shared folder, keeps the new versions in .history/, logs
   * who wrote them, and leaves a note for everyone else on the team.
   */
  refreshShared(goalId?: string): void {
    for (const g of this.goals.values()) {
      if (goalId && g.id !== goalId) continue;
      try {
        for (const c of g.shared.scan()) this.sharedChanged(g, c);
      } catch {
        // Try again next time.
      }
    }
  }

  private sharedChanged(g: GoalRec, c: import('./shared.ts').SharedChange): void {
    const by = this.sharedWriter(g, c.path);
    const at = Date.now();
    let clash: FileNote['clash'];
    if (c.deleted) {
      this.emit({ goal: g.id, agent: by, type: 'shared.delete', data: { path: c.path, by: by ?? null } });
    } else {
      const history = g.shared.record(c.path, by);
      const f = g.shared.files.get(c.path)!;
      this.emit({ goal: g.id, agent: by, type: 'shared.write', data: { path: c.path, version: f.version, by: by ?? null, history: history ?? null } });
      const owner = c.before?.owner;
      if (by && owner && owner !== by) {
        clash = { owner, by, previous: c.before?.history && join(g.sharedDir, c.before.history) };
        this.emit({ goal: g.id, agent: by, type: 'shared.clash', data: { path: c.path, owner, by, previous: c.before?.history ?? null } });
      }
    }
    for (const a of g.agents.values()) {
      if (a.quick || FINISHED.includes(a.state)) continue;
      if (a.name === by && !clash) continue;
      a.fileNotes.set(c.path, { path: c.path, by, at, deleted: c.deleted, clash: clash && (a.name === clash.owner || a.name === clash.by) ? clash : undefined });
    }
  }

  /** Who wrote a shared file just now: the agent whose latest recent tool call named it. */
  private sharedWriter(g: GoalRec, path: string): string | undefined {
    const since = Date.now() - SHARED_TOUCH_MS;
    g.sharedTouches = g.sharedTouches.filter(t => t.at >= since);
    const full = join(g.sharedDir, path);
    return g.sharedTouches.findLast(t => t.summary.includes(full) || t.summary.includes(`shared/${path}`))?.agent;
  }

  private noteSharedTouch(rec: AgentRec, summary: string): void {
    const g = this.goals.get(rec.goal);
    if (!g || !(summary.includes(g.sharedDir) || /\bshared\//.test(summary))) return;
    g.sharedTouches.push({ agent: rec.name, at: Date.now(), summary });
    if (g.sharedTouches.length > 100) g.sharedTouches.splice(0, g.sharedTouches.length - 100);
  }

  /**
   * What changed in the shared folder since the agent last heard, as a paragraph to add to
   * whatever reaches it next. Empties its notes.
   */
  takeFileNotes(rec: AgentRec): string {
    if (!rec.fileNotes.size) return '';
    const notes = [...rec.fileNotes.values()];
    rec.fileNotes.clear();
    const g = this.goals.get(rec.goal)!;
    const out: string[] = [];
    for (const n of notes.filter(n => n.clash)) {
      const c = n.clash!;
      const kept = c.previous ? ` The version before is kept at ${c.previous}.` : '';
      out.push(
        rec.name === c.by
          ? `[MetaHarness] ${n.path} in the shared folder is ${c.owner}'s (it wrote it first), and your write replaced their version.${kept} To change a teammate's document, message its owner.`
          : `[MetaHarness] ${c.by} changed ${n.path} in the shared folder, which you wrote first.${kept}`,
      );
    }
    const plain = notes.filter(n => !n.clash);
    if (plain.length) {
      const items = plain.map(n => `${n.path} (${n.deleted ? 'deleted' : 'updated'}${n.by ? ` by ${n.by}` : ''}, ${ago(n.at)})`);
      out.push(`[MetaHarness] Changed in the shared folder (${g.sharedDir}) since you last heard: ${items.join('; ')}. Re-read what matters to you.`);
    }
    return out.join('\n');
  }

  /** Remembers who in the human's checkout last ran a git command that makes commits. */
  private noteGitActor(rec: AgentRec, command: string): void {
    if (rec.worktree || rec.quick || !GIT_COMMITS.test(command)) return;
    const g = this.goals.get(rec.goal);
    if (g?.git) g.gitActor = { agent: rec.name, at: Date.now() };
  }

  /** Who made a commit just seen in the human's checkout: the agent that ran git there lately, if any (else the human, unnamed). */
  private checkoutActor(g: GoalRec): string | undefined {
    return g.gitActor && Date.now() - g.gitActor.at < GIT_ACTOR_MS ? g.gitActor.agent : undefined;
  }

  status(rec: AgentRec, text: string): void {
    rec.status = text;
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.status', data: { text } });
  }

  /** Delivers a message. Returns a plain-language summary for the sender. */
  deliver(goalId: string, from: string, to: string, text: string, urgent = false, decision = false): string {
    const g = this.goals.get(goalId);
    if (!g) return `There's no goal ${goalId}.`;
    const target = to.trim().toLowerCase();
    if (target === 'human' || target === 'you' || target === 'user') {
      this.emit({ goal: goalId, agent: from, type: 'message.sent', data: { to: 'human', text, urgent, ...(decision ? { decision } : {}) } });
      this.toHuman(g, from, decision ? 'decision' : 'question', text);
      return decision
        ? 'Sent to the human for a decision. Their answer (approved, or what to change) will arrive as a message.'
        : 'Sent to the human. Their answer will arrive as a message.';
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
    if (rec.state === 'paused' || rec.state === 'limited' || FINISHED.includes(rec.state)) return;
    if (!s) {
      // Recovered after a restart without a running turn: resume its session with the messages.
      if (!rec.resumeId) return;
      if (this.accountLimited(rec.harness, rec.model)) return void this.hitLimit(rec);
      const entries = rec.inbox.splice(0);
      this.markDelivered(rec, entries, 'resume');
      rec.costBefore = rec.cost;
      return void this.startSession(rec, this.forAgent(rec, entries));
    }
    if (s.busy()) {
      // An interrupted turn is ending; its messages go in the next turn.
      if (rec.interrupting) return;
      if (rec.inbox.some(e => e.urgent) && this.interrupt(rec, s)) return;
      if (!rec.adapter.manifest.injectMidTurn) return;
      const entries = rec.inbox.splice(0);
      this.markDelivered(rec, entries, 'inject');
      void s.send(this.forAgent(rec, entries), 'inject');
      return;
    }
    // A new turn on an account at its limit would only be refused.
    if (this.accountLimited(rec.harness, rec.model)) return void this.hitLimit(rec);
    const via = rec.interrupting ? 'interrupt' : rec.state === 'done' ? 'resume' : 'new_turn';
    rec.interrupting = false;
    const entries = rec.inbox.splice(0);
    this.markDelivered(rec, entries, via);
    void s.send(this.forAgent(rec, entries), 'new_turn');
  }

  /**
   * Stops a running turn for an urgent message. With a native interrupt, the message follows
   * when the turn ends. Without one, the session is restarted from its saved ID with the
   * message (design §16: any harness that can resume can be interrupted).
   */
  private interrupt(rec: AgentRec, s: Session): boolean {
    const m = rec.adapter.manifest;
    if (m.interrupt && s.interrupt) {
      rec.interrupting = true;
      this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.interrupted', data: { how: 'native' } });
      void s.interrupt().catch(() => {});
      // If the turn doesn't end, restart it instead (or inject, as a last resort).
      setTimeout(() => {
        if (!rec.interrupting || rec.session !== s || !s.busy()) return;
        rec.interrupting = false;
        if (!(m.resume && this.restart(rec, s))) this.pump(rec);
      }, 10_000).unref();
      return true;
    }
    return m.resume && this.restart(rec, s);
  }

  /** Kills the session and resumes it from its native ID, with the waiting messages as the next turn. */
  private restart(rec: AgentRec, s: Session): boolean {
    if (!s.nativeId) return false;
    const entries = rec.inbox.splice(0);
    this.markDelivered(rec, entries, 'interrupt');
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.interrupted', data: { how: 'restart' } });
    rec.gen++;
    rec.session = undefined;
    rec.costBefore = rec.cost;
    void s.stop().catch(() => {});
    this.startSession(rec, this.forAgent(rec, entries), s.nativeId);
    return true;
  }

  /* ---------------- hooks (design §16: the middle rung of each ladder) ---------------- */

  /** A directory of the agent's own, outside its worktree, for harness config such as hooks. */
  agentDir(rec: AgentRec): string {
    const dir = join(this.home, 'goals', rec.goal, 'agents', rec.name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * A harness hook asking the daemon something. before_model: messages waiting for a busy agent
   * go into its next model call. before_tool: whether a tool may run.
   */
  async hook(token: string, req: HookRequest): Promise<{ messages?: string; allow?: boolean; reason?: string }> {
    const who = this.tokens.get(token);
    const rec = who && this.agent(who.goal, who.agent);
    if (!rec) return req.event === 'before_tool' ? { allow: false, reason: 'MetaHarness does not know this agent.' } : {};
    if (req.event === 'before_model') {
      // Shared-folder notes ride along too: the hook costs nothing, unlike a new turn.
      if ((!rec.inbox.length && !rec.fileNotes.size) || rec.interrupting || rec.state === 'paused') return {};
      const entries = rec.inbox.splice(0);
      this.markDelivered(rec, entries, 'hook');
      return { messages: this.forAgent(rec, entries) };
    }
    const t = rec.adapter.toolRequest?.(req.tool, req.args ?? {}) ?? { kind: 'other', tool: req.tool, detail: JSON.stringify(req.args ?? {}).slice(0, 8000) };
    const verdict = this.toolPolicy(rec, t);
    if (verdict !== 'ask') return verdict;
    const d = await this.requestApproval(rec, t.tool, t.detail);
    return { allow: d.allow, reason: d.allow ? undefined : (d.message ?? 'The human denied this.') };
  }

  /** What may run without asking: reads, MetaHarness's own tools, edits in the agent's own directories, and commands its role allows. */
  toolPolicy(rec: AgentRec, t: ToolRequest): { allow: boolean; reason?: string } | 'ask' {
    switch (t.kind) {
      case 'delegate':
        return { allow: false, reason: 'MetaHarness handles delegation: use its spawn tool (quick: true for a quick helper).' };
      case 'ask_user':
        return { allow: false, reason: 'Ask with the MetaHarness send tool, to: human. The answer arrives as a message.' };
      case 'read':
        return { allow: true };
      case 'mcp':
        // Ours, and the servers the role names, are what the agent is there to use.
        return t.server === MCP_SERVER_NAME || (!!t.server && rec.role.mcp.includes(t.server)) ? { allow: true } : 'ask';
      case 'edit': {
        const g = this.goals.get(rec.goal)!;
        const inside = (dir: string) => !!t.path && (t.path === dir || t.path.startsWith(dir.endsWith('/') ? dir : dir + '/'));
        if (rec.role.permissionMode === 'default' || (rec.quick && !inside(g.sharedDir))) return 'ask';
        return inside(rec.cwd) || inside(g.sharedDir) ? { allow: true } : 'ask';
      }
      case 'shell': {
        const refused = refusedGitCommand(t.detail);
        if (refused) return { allow: false, reason: refused };
        return roleAllows(rec.role, t.detail) ? { allow: true } : 'ask';
      }
      default:
        return 'ask';
    }
  }

  /* ---------------- accounts and rate limits (design §16) ---------------- */

  /** True while a harness login is refusing turns. A reset time in the past counts as reset. */
  accountLimited(harness: string, model: string): boolean {
    const a = this.accounts.get(this.accountOf(harness, model));
    return !!a && a.status === 'limited' && (a.resetsAt === undefined || a.resetsAt > Date.now());
  }

  private onRateLimit(rec: AgentRec, info: RateLimitInfo): void {
    const id = this.accountOf(rec.harness, rec.model);
    const prev = this.accounts.get(id);
    const a: AccountRec = prev ?? { id, status: 'ok', warned: new Set() };
    // Updates can be partial (a refused turn may say only "limited"), so keep what's known.
    const changed =
      a.status !== info.status ||
      (info.resetsAt !== undefined && info.resetsAt !== a.resetsAt) ||
      (info.usedPct !== undefined && Math.floor(info.usedPct / 5) !== Math.floor((a.usedPct ?? -5) / 5));
    a.status = info.status;
    if (info.usedPct !== undefined) a.usedPct = info.usedPct;
    if (info.resetsAt !== undefined) {
      // A new window starts: agents may need warning again.
      if (a.resetsAt !== undefined && info.resetsAt > a.resetsAt + 60_000) a.warned.clear();
      a.resetsAt = info.resetsAt;
    }
    if (info.window !== undefined) a.window = info.window;
    this.accounts.set(a.id, a);
    if (changed) {
      this.emit({
        goal: rec.goal, agent: rec.name, type: 'account.limit',
        data: { account: a.id, status: a.status, usedPct: a.usedPct ?? null, resetsAt: a.resetsAt ? new Date(a.resetsAt).toISOString() : null, window: a.window ?? null },
      });
    }
    const agents = this.agentsOn(a.id);
    if (a.status === 'limited') {
      for (const r of agents) if (r.session?.busy() || r === rec || r.pendingBrief) this.hitLimit(r);
      return;
    }
    if (a.status === 'warning' || (a.usedPct ?? 0) >= this.limits.warnPct) {
      for (const r of agents) {
        const key = `${r.goal}/${r.name}`;
        if (a.warned.has(key) || r.quick || r.doneNote !== undefined) continue;
        a.warned.add(key);
        this.notice(r, this.limitWarning(r, a));
      }
    }
  }

  /** Live agents on an account, across goals. */
  private agentsOn(account: string): AgentRec[] {
    return [...this.goals.values()].flatMap(g => [...g.agents.values()]).filter(r => this.accountOf(r.harness, r.model) === account && !FINISHED.includes(r.state));
  }

  /** The account a harness and model count against: the harness, or one of its quota pools. */
  accountOf(harness: string, model: string): string {
    return this.adapters[harness]?.account?.(model) ?? harness;
  }

  private limitWarning(rec: AgentRec, a: AccountRec): string {
    const used = a.usedPct !== undefined ? `${a.usedPct}% of its limit` : 'close to its limit';
    const resets = a.resetsAt ? ` (it resets at ${clock(a.resetsAt)})` : '';
    return (
      `Your ${a.id} account is at ${used}${resets}. Write where you are to shared/notes/${rec.name}.md now: what's done, ` +
      `what's next, and anything uncommitted. Commit what works, then finish your current step. If the limit is hit, ` +
      `your work may continue on another model from those notes.`
    );
  }

  /**
   * An agent can't run because its account is at its limit. Wait if the reset is close,
   * otherwise move to a backup whose account isn't limited, otherwise wait anyway.
   */
  hitLimit(rec: AgentRec): void {
    if (rec.state === 'limited' || FINISHED.includes(rec.state)) return;
    const account = this.accountOf(rec.harness, rec.model);
    const a = this.accounts.get(account);
    const now = Date.now();
    const soon = a?.resetsAt !== undefined && a.resetsAt - now <= this.limits.waitMaxMs;
    if (!soon) {
      const backup = this.routes(rec.role).find(r => this.adapters[r.harness] && !this.accountLimited(r.harness, r.model) && !(r.harness === rec.harness && r.model === rec.model));
      if (backup) return this.move(rec, backup, `the ${account} account is at its limit`);
    }
    const until = a?.resetsAt !== undefined && a.resetsAt > now ? a.resetsAt : now + this.limits.retryMs;
    rec.limitedUntil = until;
    this.setState(rec, 'limited');
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.limited', data: { account, until: new Date(until).toISOString(), known: a?.resetsAt !== undefined } });
    clearTimeout(rec.limitTimer);
    rec.limitTimer = setTimeout(() => this.limitOver(rec), Math.max(0, until - now) + this.limits.marginMs).unref();
  }

  /** The wait is over: start the session that was waiting, or ask the agent to carry on. */
  private limitOver(rec: AgentRec): void {
    if (rec.state !== 'limited') return;
    rec.limitedUntil = undefined;
    const account = this.accountOf(rec.harness, rec.model);
    const a = this.accounts.get(account);
    if (a && a.status === 'limited') a.status = 'ok';
    this.setState(rec, rec.session?.busy() ? 'working' : 'idle');
    if (rec.pendingBrief !== undefined) return this.startSession(rec, rec.pendingBrief);
    if (rec.session && !rec.session.busy()) this.notice(rec, `The limit on your ${account} account should have reset. Carry on where you left off.`);
    else this.pump(rec);
  }

  /** Moves an agent to another harness or model: a new session, started from a handoff. */
  private move(rec: AgentRec, to: Route, reason: string): void {
    const from = { harness: rec.harness, model: rec.model };
    const old = rec.session;
    const brief = rec.pendingBrief ?? this.handoff(rec, from, reason);
    rec.gen++;
    rec.session = undefined;
    rec.resumeId = undefined;
    rec.interrupting = false;
    rec.costBefore = rec.cost;
    clearTimeout(rec.limitTimer);
    rec.limitedUntil = undefined;
    // Its wait() calls belong to the old session; the new one makes its own.
    for (const w of rec.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve([]);
    }
    void old?.stop().catch(() => {});
    rec.harness = to.harness;
    rec.model = to.model;
    rec.adapter = this.adapters[to.harness];
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.moved', data: { from, to, reason } });
    this.setState(rec, 'starting');
    this.startSession(rec, brief);
    const g = this.goals.get(rec.goal)!;
    const line = `${rec.name} moved from ${from.harness} · ${from.model} to ${to.harness} · ${to.model}, because ${reason}. It continues from a handoff.`;
    for (const who of new Set([rec.parent, g.lead])) {
      const r = g.agents.get(who);
      if (r && r !== rec && !FINISHED.includes(r.state)) this.notice(r, line);
    }
  }

  /**
   * The brief for an agent's new session after a move. Built from what the daemon saw, so it
   * doesn't depend on the old session being able to write anything.
   */
  handoff(rec: AgentRec, from: Route, reason: string): string {
    const g = this.goals.get(rec.goal)!;
    const events = this.store.since(rec.goal).filter(e => e.agent === rec.name || (e.type === 'message.sent' && e.data.to === rec.name));
    const last = <T>(xs: T[], n: number) => xs.slice(Math.max(0, xs.length - n));
    const cut = (v: unknown, n = 300) => {
      const t = String(v ?? '').replace(/\s+/g, ' ').trim();
      return t.length > n ? t.slice(0, n - 1) + '…' : t;
    };
    const statuses = last([...new Set(events.filter(e => e.type === 'agent.status').map(e => cut(e.data.text, 160)))], 8);
    const messages = last(
      events
        .filter(e => e.type === 'message.sent')
        .map(e => (e.agent === rec.name ? `- you → ${e.data.to}: ${cut(e.data.text)}` : `- ${e.agent} → you: ${cut(e.data.text)}`)),
      12,
    );
    const tools = last(events.filter(e => e.type === 'agent.tool_call').map(e => `- ${e.data.tool} ${cut(e.data.summary, 120)}`), 12);
    const spawner = rec.parent === 'human' ? 'the human' : rec.parent;
    const parts = [
      `[MetaHarness] You're taking over as ${rec.name}, the ${rec.role.name}. Until now ${from.harness} · ${from.model} did this work, and it stopped because ${reason}. ` +
        `Your name and working directory are the same, and teammates reach you as before. Read what's below and the state of the work, then carry on.`,
      `## The original brief (from ${spawner})\n\n${rec.brief}`,
    ];
    const did: string[] = [];
    if (statuses.length) did.push(`Status lines, oldest first:\n${statuses.map(t => `- ${t}`).join('\n')}`);
    if (messages.length) did.push(`Messages:\n${messages.join('\n')}`);
    if (tools.length) did.push(`Its last tool calls:\n${tools.join('\n')}`);
    if (rec.lastText) did.push(`The last thing it said: ${cut(rec.lastText, 800)}`);
    if (did.length) parts.push(`## What happened so far\n\n${did.join('\n\n')}`);
    const where: string[] = [];
    const notes = join(g.sharedDir, 'notes', `${rec.name}.md`);
    if (existsSync(notes)) where.push(`- Its notes: ${notes}. Read them first.`);
    if (!rec.worktree && g.git) {
      // It shared the human's checkout, so what's uncommitted there may be anyone's.
      where.push(`- It worked in ${g.dir}, on ${g.git.branch === 'HEAD' ? 'a detached HEAD' : g.git.branch}, which teammates share. You do too.`);
      const dirty = git.statusShort(g.dir);
      if (dirty.length) where.push(`- Uncommitted changes there (yours or teammates'; git status --short):\n${dirty.slice(0, 30).map(l => `    ${l}`).join('\n')}`);
    }
    if (rec.worktree && g.git) {
      const commits = git.commitsBetween(g.git, rec.worktree.base, rec.worktree.branch);
      where.push(
        commits.length
          ? `- Commits on ${rec.worktree.branch}: ${commits.map(c => `${c.sha.slice(0, 7)} ${c.summary}`).join('; ')}`
          : `- No commits on ${rec.worktree.branch} yet.`,
      );
      const dirty = git.statusShort(rec.worktree.path);
      if (dirty.length) where.push(`- Uncommitted changes in ${rec.worktree.path} (git status --short):\n${dirty.slice(0, 30).map(l => `    ${l}`).join('\n')}`);
    }
    where.push(`- Shared folder: ${g.sharedDir}`);
    parts.push(`## Where the work is\n\n${where.join('\n')}`);
    return this.firstMessage(rec, parts.join('\n\n'));
  }

  /** Messages for an agent, with any shared-folder changes it hasn't heard about. */
  private forAgent(rec: AgentRec, entries: InboxEntry[]): string {
    return [formatForAgent(entries), this.takeFileNotes(rec)].filter(Boolean).join('\n');
  }

  /** A message from MetaHarness itself. */
  private notice(rec: AgentRec, text: string): void {
    this.enqueue(rec, { id: randomUUID(), kind: 'notice', from: 'MetaHarness', text, urgent: false, ts: new Date().toISOString() });
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
    // Whatever the stopped session still says is no longer news.
    rec.gen++;
    clearTimeout(rec.limitTimer);
    this.setState(rec, 'ended');
    this.emit({ goal: goalId, agent: name, type: 'agent.ended', data: { reason: `stopped by ${by}` } });
    if (rec.doneNote === undefined) this.finish(rec, `${name} was stopped by ${by}.`, 'ended');
    return `Stopped ${name}.`;
  }

  /* ---------------- restart recovery ---------------- */

  /**
   * Rebuilds the goals still running when the last daemon stopped, from the event log, and
   * resumes their agents' native sessions. Agents cut off mid-turn continue at once, told what
   * happened; the rest resume when a message reaches them. Goals in another directory, or with
   * agents on a harness this daemon can't run, are left alone. Call once the server is up.
   */
  recover(): { goal: string; request: string; resumed: string[]; later: string[]; skipped?: string }[] {
    const out: ReturnType<Daemon['recover']> = [];
    for (const start of this.store.ofType('goal.started')) {
      if (this.goals.has(start.goal) || start.data.dir !== this.repo) continue;
      const r = replayGoal(this.store.since(start.goal));
      if (!r || goalOver(r)) continue;
      const missing = [...new Set([...r.agents.values()].filter(a => !FINISHED.includes(a.state) && !this.adapters[a.harness]).map(a => a.harness))];
      if (missing.length) {
        out.push({ goal: r.id, request: r.request, resumed: [], later: [], skipped: `this daemon can't run ${missing.join(', ')}` });
        continue;
      }
      out.push({ goal: r.id, request: r.request, ...this.restoreGoal(r) });
    }
    this.restoreAccounts();
    if (this.goals.size) this.startPolling();
    return out;
  }

  private restoreGoal(r: GoalReplay): { resumed: string[]; later: string[] } {
    let resolveLeadDone!: (note: string) => void;
    const leadDone = new Promise<string>(res => (resolveLeadDone = res));
    const g: GoalRec = {
      id: r.id, request: r.request, dir: r.dir, lead: r.lead, createdAt: r.createdAt, sharedDir: r.sharedDir,
      refs: r.refs, seenOn: r.seenOn, workflow: r.workflow, status: 'running', agents: new Map(), counters: r.counters,
      conflicts: r.conflicts, shared: new SharedFolder(r.sharedDir), sharedTouches: [], leadDone, resolveLeadDone,
    };
    mkdirSync(g.sharedDir, { recursive: true });
    // What's there now counts as seen; changes made while the daemon was down aren't reported.
    g.shared.seed(r.shared);
    // The branch and base the goal started on, not whatever is checked out now.
    const gs = r.base ? git.setupGoal(g.dir, g.id) : { reason: 'there was no git repository when it started' };
    if ('reason' in gs) g.gitNote = gs.reason;
    else g.git = { ...gs, branch: r.branch ?? gs.branch, base: r.base ?? gs.base };
    this.goals.set(g.id, g);
    for (const a of r.agents.values()) g.agents.set(a.name, this.restoreAgent(g, a));

    for (const i of r.inbox) {
      // The session that asked is gone; if the agent still needs it, it asks again.
      if (i.kind === 'approval') {
        this.emit({ goal: g.id, agent: i.agent, type: 'inbox.resolved', data: { id: i.id, decision: 'dismiss', reply: null, why: 'the daemon restarted' } });
        continue;
      }
      this.humanInbox.push({ id: i.id, goal: g.id, agent: i.agent, kind: i.kind as HumanInboxItem['kind'], text: i.text, ts: i.ts });
    }

    const resumed: string[] = [];
    const later: string[] = [];
    for (const rec of g.agents.values()) {
      if (FINISHED.includes(rec.state)) continue;
      for (const m of r.agents.get(rec.name)!.undelivered) rec.inbox.push({ id: m.id, kind: 'message', from: m.from, text: m.text, urgent: m.urgent, ts: m.ts });
      (INTERRUPTED.includes(rec.state) || rec.state === 'limited' || rec.inbox.length ? resumed : later).push(rec.name);
    }
    this.emit({ goal: g.id, type: 'goal.recovered', data: { resumed, later } });
    for (const name of resumed) this.resumeAgent(g, g.agents.get(name)!, r.agents.get(name)!);
    return { resumed, later };
  }

  private restoreAgent(g: GoalRec, a: AgentReplay): AgentRec {
    const role: Role = this.config.roles.get(a.role) ?? {
      name: a.role, harness: a.harness, model: a.model, fallback: [], goodAt: '', instructions: '', helper: a.quick,
      allow: [], autoApprove: 'read-only', mcp: [], worktree: false, file: '(no longer in the config)',
    };
    let worktree: git.Worktree | undefined;
    if (a.worktree && existsSync(a.worktree.path)) {
      try {
        worktree = { ...a.worktree, gitDir: git.git(a.worktree.path, 'rev-parse', '--absolute-git-dir') };
      } catch {
        // Not a worktree any more; the agent works without one.
      }
    }
    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, { goal: g.id, agent: a.name });
    const rec: AgentRec = {
      goal: g.id, name: a.name, role, harness: a.harness, model: a.model, parent: a.parent, brief: a.brief,
      quick: a.quick, isLead: a.name === g.lead, cwd: a.cwd, worktree, state: a.state, status: a.status,
      cost: a.cost, costBefore: a.costBefore, contextPct: a.contextPct, lastText: a.lastText,
      adapter: this.adapters[a.harness], resumeId: a.nativeSession, gen: 0, token, systemPrompt: '', doneNote: a.doneNote,
      inbox: [], waiters: [], doneWaiters: [], pendingApprovals: 0, fileNotes: new Map(),
    };
    rec.systemPrompt = this.buildPrompt(g, rec, g.workflow, a.startedFrom ?? 'its start point');
    return rec;
  }

  /** Continues an agent that was busy (or had messages waiting) when the daemon stopped. */
  private resumeAgent(g: GoalRec, rec: AgentRec, a: AgentReplay): void {
    // Done or idle with messages waiting: they resume it, as any message would.
    if (!INTERRUPTED.includes(rec.state) && rec.state !== 'limited') return this.pump(rec);
    // Cut off: it continues its session, told why. One that never had a session starts over.
    const first = rec.resumeId ? this.restartNote(g, rec) : this.firstMessage(rec);
    rec.costBefore = rec.cost;
    if (rec.state === 'limited' && (a.limitedUntil ?? 0) > Date.now()) {
      // Its messages follow once the session is up.
      rec.pendingBrief = first;
      rec.limitedUntil = a.limitedUntil;
      rec.limitTimer = setTimeout(() => this.limitOver(rec), a.limitedUntil! - Date.now() + this.limits.marginMs).unref();
      return;
    }
    if (rec.state === 'limited') this.setState(rec, 'starting');
    const entries = rec.inbox.splice(0);
    this.markDelivered(rec, entries, 'resume');
    this.startSession(rec, [first, this.forAgent(rec, entries)].filter(Boolean).join('\n'));
  }

  /** What an agent cut off by a restart is told when its session resumes. */
  private restartNote(g: GoalRec, rec: AgentRec): string {
    const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
    const team = [...g.agents.values()]
      .filter(a => a !== rec && !a.quick)
      .map(a => `- ${a.name} (${a.role.name}): ${a.state}${a.parent === rec.name && a.doneNote !== undefined ? `. It finished: ${cut(a.doneNote, 400)}` : ''}`);
    return [
      '[MetaHarness] MetaHarness restarted while you were working, so your last turn was cut off. A command or tool call ' +
        "you were in may not have finished, and a `wait` or `spawn` you were in returned nothing. Check where your work stands " +
        '(files, git status), then carry on.',
      ...(team.length ? ['', 'Your team now:', ...team] : []),
    ].join('\n');
  }

  /** Rate limits still in force, from the log, so new spawns and resumes avoid them. */
  private restoreAccounts(): void {
    for (const e of this.store.ofType('account.limit')) {
      const id = String(e.data.account ?? '');
      const resetsAt = Date.parse(String(e.data.resetsAt ?? '')) || undefined;
      if (!id || e.data.status === 'ok' || !resetsAt || resetsAt <= Date.now()) {
        this.accounts.delete(id);
        continue;
      }
      this.accounts.set(id, {
        id, status: e.data.status as RateLimitInfo['status'], resetsAt, warned: new Set(),
        usedPct: typeof e.data.usedPct === 'number' ? e.data.usedPct : undefined, window: typeof e.data.window === 'string' ? e.data.window : undefined,
      });
    }
  }

  /* ---------------- cleaning up (design §9) ---------------- */

  /** Agents still at work: not finished, and not done (one that called done may still be ending its turn). */
  private busyAgents(g: GoalRec): string[] {
    return [...g.agents.values()].filter(a => a.doneNote === undefined && !['idle', 'ended', 'crashed'].includes(a.state)).map(a => a.name);
  }

  /**
   * When the lead finishes: removes the goal's worktrees and the branches merged into its branch.
   * Agents never delete branches or worktrees themselves (src/guard.ts). If teammates still work,
   * it waits for them. Returns a line for the lead's note to the human.
   */
  private cleanUpAfterGoal(g: GoalRec): string {
    if (!g.git || (!git.goalBranches(g.git, g.id).size && !existsSync(join(this.home, 'goals', g.id, 'worktrees')))) return '';
    if (!this.autoClean) return ` When you're done with the worktrees: mh clean ${g.id}.`;
    const busy = this.busyAgents(g);
    if (busy.length) {
      g.cleanWhenIdle = true;
      return ` MetaHarness removes the worktrees and merged branches once ${busy.join(', ')} ${busy.length > 1 ? 'finish' : 'finishes'}.`;
    }
    const line = describeClean(this.runCleanup(g, false), `mh clean ${g.id} --force removes them.`);
    return line ? ` ${line}` : '';
  }

  /** Cleans a goal loaded here. Its agents whose worktree went can't be resumed there, so they end. */
  private runCleanup(g: GoalRec, force: boolean): CleanResult {
    // Report the last commits and merges while their branches still exist.
    this.refreshGit(g.id);
    const res = cleanGoal(this.home, { id: g.id, request: g.request, dir: g.dir, branch: g.git?.branch }, force);
    if (res.removed.length || res.deleted.length || res.kept.length) {
      this.emit({ goal: g.id, type: 'goal.cleaned', data: { removed: res.removed, deleted: res.deleted, kept: res.kept, force } });
    }
    for (const a of g.agents.values()) {
      if (!a.worktree || !res.removed.includes(a.worktree.path) || FINISHED.includes(a.state)) continue;
      // Quietly: whoever spawned it has its result already, or saw it stop.
      a.gen++;
      void a.session?.stop().catch(() => {});
      this.setState(a, 'ended');
      this.emit({ goal: g.id, agent: a.name, type: 'agent.ended', data: { reason: 'its worktree was removed when the goal ended' } });
    }
    return res;
  }

  /** The last teammate finished after the lead: clean up now, and tell the human what was kept. */
  private cleanUpIfIdle(g: GoalRec): void {
    if (!g.cleanWhenIdle || this.busyAgents(g).length) return;
    g.cleanWhenIdle = false;
    const res = this.runCleanup(g, false);
    if (res.kept.length) this.toHuman(g, g.lead, 'done', describeClean(res, `mh clean ${g.id} --force removes them.`));
  }

  /**
   * `mh clean`: removes worktrees and merged branches of goals that are over, one or all. Never
   * a goal whose agents still work. A goal whose lead never finished needs its id and force, and
   * so does removing uncommitted or unmerged work.
   */
  cleanGoals(goalId?: string, force = false): { results: CleanResult[]; refused: string[] } {
    if (force && !goalId) throw new Error('--force removes work that was never merged, so it needs a goal: mh clean <goal> --force.');
    const results: CleanResult[] = [];
    const refused: string[] = [];
    let starts = this.store.ofType('goal.started');
    if (goalId) {
      const exact = starts.filter(e => e.goal === goalId);
      starts = exact.length ? exact : starts.filter(e => e.goal.startsWith(goalId));
      if (!starts.length) throw new Error(`There's no goal ${goalId}.`);
      if (starts.length > 1) throw new Error(`"${goalId}" could be goal ${starts.map(e => e.goal).join(' or ')}. Give more of the id.`);
    }
    for (const start of starts) {
      const r = replayGoal(this.store.since(start.goal));
      if (!r) continue;
      const live = this.goals.get(r.id);
      const busy = live ? this.busyAgents(live) : [];
      if (busy.length) {
        if (goalId) refused.push(`Goal ${r.id} is still running (${busy.join(', ')} ${busy.length > 1 ? 'are' : 'is'} working). Stop them first: mh stop <agent>.`);
        continue;
      }
      const over = live ? !!live.agents.get(live.lead)?.doneNote || goalOver(r) : goalOver(r);
      if (!over && !(goalId && force)) {
        if (goalId) refused.push(`Goal ${r.id}'s lead hasn't finished${live ? '' : ", and the goal isn't running here"}. mh clean ${r.id} --force cleans it anyway.`);
        continue;
      }
      const res = live ? this.runCleanup(live, force) : cleanGoal(this.home, r, force);
      if (!res.removed.length && !res.deleted.length && !res.kept.length) continue;
      if (!live) this.emit({ goal: r.id, type: 'goal.cleaned', data: { removed: res.removed, deleted: res.deleted, kept: res.kept, force } });
      results.push(res);
    }
    return { results, refused };
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
          nativeSession: a.session?.nativeId ?? a.resumeId ?? null,
          limitedUntil: a.limitedUntil ?? null,
        })),
      })),
      inbox: this.humanInbox.filter(i => !goalId || i.goal === goalId),
      accounts: [...this.accounts.values()].map(a => ({ id: a.id, status: a.status, usedPct: a.usedPct ?? null, resetsAt: a.resetsAt ?? null, window: a.window ?? null })),
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
        const goal = this.startGoal({ request, lead: s('lead'), workflow: s('workflow') ?? s('playbook') });
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
      case 'goal.clean':
        return this.cleanGoals(s('goal'), b.force === true);
      case 'harness.test': {
        const harness = s('harness');
        if (!harness) throw new Error('harness.test needs "harness".');
        if (!this.adapters[harness]) throw new Error(`MetaHarness can't run ${harness} here. Harnesses it can run: ${Object.keys(this.adapters).join(', ')}.`);
        const { probeHarness } = await import('./probe.ts');
        return { ...(await probeHarness(this, harness, s('model') ?? '')) };
      }
      default:
        throw new Error(`Unknown command "${String(b.cmd)}". Commands: goal.start, goal.clean, agent.message, agent.stop, inbox.resolve, harness.test.`);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.pollTimer);
    for (const g of this.goals.values()) {
      for (const a of g.agents.values()) {
        for (const w of a.waiters) clearTimeout(w.timer);
        clearTimeout(a.limitTimer);
        // What the stopping sessions report isn't the agents' doing: the log keeps their state,
        // so the next daemon can resume them (recover).
        a.gen++;
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
        : e.kind === 'notice'
          ? `[MetaHarness] ${e.text}`
          : `[MetaHarness] Message from ${e.from}${e.urgent ? ' (urgent)' : ''}: ${e.text}`,
    )
    .join('\n');
}

/** Whether a role's allow list (Claude Code style, e.g. "Bash(npm test*)") covers a shell command. */
export function roleAllows(role: Role, command: string): boolean {
  const cmd = command.trim();
  return role.allow.some(a => {
    const m = /^Bash\((.*)\)$/.exec(a.trim());
    if (!m) return false;
    const re = new RegExp('^' + m[1].split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return re.test(cmd);
  });
}

/** For an agent's prompt: the dependency folders copied into its worktree from the checkout. */
function depsLines(copied: string[]): string[] {
  if (!copied.length) return [];
  return [
    `- ${copied.join(', ')} ${copied.length > 1 ? 'are copies' : 'is a copy'} of the checkout's, made with hard links, so you can run things straight away. ` +
      `Reinstalling is fine, but don't edit files inside ${copied.length > 1 ? 'them' : 'it'} in place: the human's copy shares them.`,
  ];
}

/** How long ago, for messages: "just now", "3 min ago". */
function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  return min < 1 ? 'just now' : `${min} min ago`;
}

/** A time of day for messages, e.g. 18:20. */
function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5);
}
