import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join, normalize, relative, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventStore } from './store.ts';
import { loadConfig, type Config } from './config.ts';
import { resolveName } from './fuzzy.ts';
import { Hub, TOOL_NAMES } from './hub.ts';
import * as git from './git.ts';
import type { AgentState, MhEvent, NewEvent, Role, Workflow } from './types.ts';
import type { ApprovalDecision, CostSplit, HarnessAdapter, HookRequest, LimitWindow, RateLimitInfo, Session, SessionEvents, ToolRequest, Usage } from './adapters/types.ts';
import { addSplit, addTokens, priceSplit, splitTotal, tokenCount, tokensOf, type Tokens } from './costs.ts';
import { modelSettings, readSettingsFile, writeSettingsFile } from './settings.ts';
import { Gatekeeper, type GatekeeperLimits, type Judgement } from './gatekeeper.ts';
import { elideHeredocs, unwrapShell } from './shellview.ts';
import { Assistant, assistantDecision } from './assistant.ts';
import type { ApprovalMode } from './settings.ts';
import { MCP_SERVER_NAME } from './mcp.ts';
import { readOnlyCommand } from './readonly.ts';
import { goalOver, INTERRUPTED, replayGoal, type AgentReplay, type GoalReplay } from './recover.ts';
import { HISTORY, SharedFolder } from './shared.ts';
import { cleanGoal, describeClean, type CleanResult } from './clean.ts';
import { authorsDir, deniedCommandPrefixes, guardEnv, installGuard, readAuthors, refusedGitCommand, removeAuthors } from './guard.ts';
import { DesignTracker, MAP_FILE, compareDesigns, designReport, type DesignReport, type SnapshotInfo } from './design.ts';
import { Outliner, packFor, type FileDocs, type Highlights } from './languages.ts';
import { configView, deleteItem, saveGuide, saveMcp, saveRole, saveRule, saveWorkflow, scopesOf } from './configedit.ts';
import { loadProfiles } from './harnesses.ts';
import { settle } from './procs.ts';
import { foldEfforts, splitEffort, type EffortVariant } from './effort.ts';
import { matchesPaths, onCommit, onDone, onToolCall, rulesPrompt, RuleState, toolPaths, type Rule, type RuleAgent, type RuleNote, type ToolInfo } from './rules.ts';
import { claimedSkills, skillsFor, skillsPrompt, withSkills, type Skill } from './skills.ts';
import {
  applyCanvas, branchCards, canvasMarkdown, castText, DEFAULT_MAKERS, demoPage, leadMethodology, lensLines, lensMethodology, lensName, makesOf, mixAsk, modelRole, parseCanvasOps, RESPONSIBILITIES,
  responsibilityOf, seedCanvas, sharedPath,
  type Canvas, type CanvasOp, type CanvasResult, type Card, type CardKind, type CardLink, type Ingredient, type Lens, type MakerCan, type Output, type RoomPaths, type RoomState,
} from './rooms.ts';

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
  /** How hard its model thinks, as the role (or the backup it runs on) says; the adapter takes the nearest its harness has. */
  effort?: string;
  parent: string;
  brief: string;
  /** A maker in a brainstorm room: what it's for, and how it should look at the question. */
  responsibility?: string;
  stance?: string;
  /** A maker in a room: who asked its current turn, the lead or the human (its answer goes back to them). */
  askedBy?: string;
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
  /** harness: the harness reported it; prices: estimated from the settings' prices. */
  costSource?: 'harness' | 'prices';
  /** Tokens by kind, all sessions; and the earlier sessions' share. */
  tokens?: Tokens;
  tokensBefore?: Tokens;
  /** Spend by kind of token, when known. */
  costSplit?: CostSplit;
  splitBefore?: CostSplit;
  /** When it last called its model (ms), and how long the provider keeps its prompt cache then. */
  lastCallAt?: number;
  cacheMinutes?: number;
  /** The lastCallAt its spawner was last told about, so each idle spell is reminded once. */
  cacheReminded?: number;
  /** Tokens in its context at its last model call. */
  contextTokens?: number;
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
  /** In a room, stopped by the human mid-turn: what it said is already its answer, so the turn's end isn't another. */
  roomStopped?: boolean;
  /** Its last message in the current turn, for a room: the lead's reply, a maker's answer. */
  turnText?: string;
  /** Tool calls the harness reported as started and not yet finished, in the current turn. */
  toolsRunning: number;
  lastToolEnd: number;
  /** Messages are waiting to pause the running turn between steps (see pauseCheck). */
  pause?: { since: number; urgent: boolean; timer: NodeJS.Timeout };
  /** The human paused it: nothing is delivered until they resume it. midTurn: it was stopped during a turn. */
  held?: { midTurn: boolean };
  inbox: InboxEntry[];
  waiters: Waiter[];
  /** Callers blocked in a quick spawn, waiting for this agent's answer. */
  doneWaiters: ((note: string) => void)[];
  doneNote?: string;
  /** Permission requests waiting in the human's Inbox. */
  pendingApprovals: number;
  /** Shared-folder changes by others since the agent last heard, by path. They don't wake it. */
  fileNotes: Map<string, FileNote>;
  /** When it last became done or idle: after a quiet spell its process is let go (releaseIdle). */
  settledAt?: number;
  /** When it last did something besides waiting: a tool call, a spawn, a message sent or received (for stall reports). */
  progressAt: number;
  /** The teammate it last spawned, was spawned by, or messaged with: who it's most likely waiting on. */
  lastPartner?: { name: string; at: number; text: string; sent: boolean };
  /** The progressAt its stall was last reported at, so each stuck spell is reported once. */
  stallReported?: number;
  /** Its context window is nearly full: it continues in a fresh session soon (see checkContext). */
  refresh?: { since: number; pct: number; timer?: NodeJS.Timeout };
  /** Which rules it has had this session (design §18). A fresh session starts over. */
  rules: RuleState;
  /** Rule notes for an agent between turns: they ride along with whatever reaches it next. */
  ruleNotes: string[];
}

export interface GoalRec {
  id: string;
  /** A brainstorm room (design §21): the human talks with its lead, which keeps a canvas and sends lenses. The request is its topic. */
  kind?: 'room';
  room?: RoomState;
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
  /** The last agent in the human's checkout to run a git command that commits: who a commit the hooks didn't record is named after. */
  gitActor?: { agent: string; at: number };
  /** Commits on the goal branch not yet announced as landed, gathered until the branch goes quiet (see landed). */
  landing?: { from: string; commits: LandedCommit[]; timer?: NodeJS.Timeout };
  /** Watches the folder the git hooks write authors to, so new commits show at once. */
  authorsWatch?: import('node:fs').FSWatcher;
  /** Merges (and the like) stopped on conflicts, by the folder they're in. */
  conflicts: Map<string, OpenConflict>;
  /** Notes the human pinned on areas, and who has had each. */
  notes: Map<string, PinnedNote>;
  /** The shared folder's files and their history. */
  shared: SharedFolder;
  /** Recent tool calls that named a shared file, to tell who wrote it. */
  sharedTouches: { agent: string; at: number; summary: string }[];
  /** The workflow the lead was given, if any. */
  workflow?: string;
  /** Workflows the lead read since, as one hands on to the next: their roles count too. */
  chained: string[];
  status: 'running' | 'ended';
  agents: Map<string, AgentRec>;
  counters: Map<string, number>;
  /** The lead finished while teammates still worked: clean up once they're done too. */
  cleanWhenIdle?: boolean;
  /** Judges this goal's approvals, once one is asked for. */
  gatekeeper?: Gatekeeper;
  /** The gatekeeper's spend, by session (each reports its own total). */
  gatekeeperCost: Map<number, number>;
  /** A stall reported to the lead, and whether the human has heard about it too. */
  stall?: { at: number; humanTold: boolean };
  /** Resolves when the lead calls done. */
  leadDone: Promise<string>;
  resolveLeadDone: (note: string) => void;
}

export interface HumanInboxItem {
  id: string;
  goal: string;
  agent: string;
  /** decision: an agent asks the human to approve something (send with decision: true). */
  kind: 'question' | 'decision' | 'approval' | 'done' | 'stopped' | 'crash' | 'stalled';
  text: string;
  ts: string;
  /** Why it came to the human, e.g. what the gatekeeper said. */
  note?: string;
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
  pause?: Partial<PausePolicy>;
  /** Settings over the ones in settings.json (tests use approvals: 'ask'). */
  settings?: Partial<import('./settings.ts').Settings>;
  gatekeeperLimits?: GatekeeperLimits;
  /** How long an agent whose context is nearly full gets to write its notes before its fresh session starts anyway. */
  contextNotesMs?: number;
  /** How long a finished agent keeps its process before it's let go (its session resumes when messaged). Default 10 minutes; 0 never. */
  releaseMs?: number;
  /** How long the goal branch stays quiet before what landed on it is announced (default a minute). */
  landedQuietMs?: number;
  /** How long close() waits for the harnesses' processes to exit before they're killed. */
  closeGraceMs?: number;
}

/**
 * When a message can't join a running turn, the turn is paused between steps: never while a tool
 * is running, so nothing is cut in half (design §7).
 */
export interface PausePolicy {
  /** How long a normal message waits for the harness to pick it up by itself (a hook, a tool result). */
  graceMs: number;
  /** After a tool finishes, how long to leave a harness that pulls messages to do so before pausing. */
  settleMs: number;
  /** The longest a pause waits for a running tool to finish before interrupting anyway. */
  maxWaitMs: number;
  tickMs: number;
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
  note?: string;
  windows?: LimitWindow[];
  /** When the harness last said where the account stands. */
  checkedAt?: number;
  /** Agents (goal/name) already asked to write their notes in this window. */
  warned: Set<string>;
}

/** What the role editor offers for a harness: its models, the efforts of each, and names that fold a model and an effort together. */
export interface ModelChoices {
  harness: string;
  models: string[];
  efforts: Record<string, string[]>;
  variants: Record<string, EffortVariant>;
  /** Efforts any model takes, typed by hand or not listed (Claude Code's). */
  anyEffort?: string[];
  error: string | null;
}

interface Route {
  harness: string;
  model: string;
  effort?: string;
}

type SpawnResult =
  | { ok: true; name: string; rec: AgentRec; guessedRole?: string; note?: string }
  | { ok: false; error: string };

/** A commit that reached the goal branch: made there, or merged in. */
export interface LandedCommit {
  sha: string;
  summary: string;
  agent?: string;
  paths: string[];
  merge: boolean;
  /** For a merge, who made the commits it brought in. */
  brought?: string[];
}

export interface PinnedNote {
  id: string;
  /** A folder or file in the repository; '' for the whole project. */
  path: string;
  text: string;
  delivered: Set<string>;
}

interface OpenConflict {
  op: git.Conflict['op'];
  sha?: string;
  branch: string;
  agent?: string;
}

/** What pricing an agent needs. */
type Spender = { harness: string; model: string; tokens?: Tokens; cost?: number; costSplit?: CostSplit; costSource?: 'harness' | 'prices' };

/** The name the gatekeeper's session goes by in the log; no teammate can be called this. */
export const GATEKEEPER = '(gatekeeper)';
/** The app's assistant: its name, and the event stream its conversation goes to. */
export const ASSISTANT = '(assistant)';
export const ASSISTANT_STREAM = 'assistant';

const FINISHED: AgentState[] = ['ended', 'crashed'];

/** How many points of the context window a fresh session must free to be worth starting. */
const MIN_CONTEXT_GAIN = 20;

/** Our own tools that don't move work along: an agent calling only these is waiting. */
const WAITING_TOOLS = /(^|[_.])(wait|status|team)$/;

type GoalStatus = 'running' | 'done' | 'ended' | 'stopped';

/** Added to messages that paused an agent's turn. */
const PAUSED_NOTE =
  '\n[MetaHarness] Your turn was paused between steps for this (your last step had finished). Check where you were, then carry on, or change course if the message says so.';

/** How long after a tool call that names a shared file a change to it is put down to that agent. */
const SHARED_TOUCH_MS = 120_000;

/** A shell command that runs git to make commits: commit, merge and the like. */
const GIT_COMMITS = /\bgit\b[^|;&\n]*?\s(?:commit|merge|cherry-pick|revert|pull|rebase|am)\b/;
/** How long after such a command a new commit in the checkout is put down to that agent. */
const GIT_ACTOR_MS = 120_000;

/** What GET /media serves from a room's folder: images, and demo pages. */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
};

export class Daemon {
  readonly home: string;
  readonly repo: string;
  readonly store: EventStore;
  readonly hub: Hub;
  readonly goals = new Map<string, GoalRec>();
  readonly humanInbox: HumanInboxItem[] = [];
  readonly quickTimeoutMs: number;
  config: Config;
  /** Where the config comes from, later ones overriding earlier ones: personal, then the repository's. */
  readonly configDirs: string[];
  /** Model lists asked of each harness's CLI, for the role editor. */
  private modelLists = new Map<string, { at: number; choices: ModelChoices }>();
  /** Base URL of the running server, e.g. http://127.0.0.1:7777. Real harnesses reach /mcp/<token> under it. */
  mcpBase?: string;
  private adapters: Record<string, HarnessAdapter>;
  private tokens = new Map<string, { goal: string; agent: string }>();
  private approvals = new Map<string, (d: ApprovalDecision) => void>();
  private harnessOverride?: string;
  private pollMs: number;
  private pollTimer?: NodeJS.Timeout;
  readonly accounts = new Map<string, AccountRec>();
  /** The last time each harness was asked for its limits, and what went wrong if it failed. */
  private limitChecks = new Map<string, { at: number; error?: string; running?: Promise<void> }>();
  private limitTimer?: NodeJS.Timeout;
  readonly limits: LimitPolicy;
  readonly pausing: PausePolicy;
  /** Git hooks that keep agents from deleting branches, rewinding shared ones, or pushing. */
  readonly guardDir: string;
  private autoClean: boolean;
  readonly gatekeeperLimits?: GatekeeperLimits;
  readonly contextNotesMs: number;
  private releaseMs: number;
  private closeGraceMs: number;
  private landedQuietMs: number;
  /** Design snapshots for the Design view (src/design.ts). */
  design: DesignTracker;
  /** Snapshots being taken, so close() waits for them. */
  private designing = new Set<Promise<unknown>>();
  /** The app's assistant: answers the human's questions, reads only. */
  readonly assistant: Assistant;

  constructor(o: DaemonOptions) {
    this.home = o.home;
    this.repo = o.repo;
    mkdirSync(o.home, { recursive: true });
    this.store = new EventStore(o.dbPath ?? join(o.home, 'mh.db'));
    this.configDirs = o.configDirs ?? [o.home, join(o.repo, '.metaharness')];
    this.config = loadConfig(this.configDirs, { repo: this.repo });
    this.adapters = o.adapters ?? {};
    this.harnessOverride = o.harnessOverride;
    this.quickTimeoutMs = o.quickTimeoutMs ?? 120_000;
    this.pollMs = o.pollMs ?? 3000;
    this.limits = { warnPct: 90, waitMaxMs: 15 * 60_000, retryMs: 15 * 60_000, marginMs: 5000, ...o.limits };
    this.pausing = { graceMs: 20_000, settleMs: 5000, maxWaitMs: 60_000, tickMs: 500, ...o.pause };
    this.hub = new Hub(this);
    this.guardDir = installGuard(o.home);
    this.autoClean = o.autoClean ?? true;
    this.gatekeeperLimits = o.gatekeeperLimits;
    this.contextNotesMs = o.contextNotesMs ?? 120_000;
    this.releaseMs = o.releaseMs ?? 10 * 60_000;
    this.closeGraceMs = o.closeGraceMs ?? 3000;
    this.landedQuietMs = o.landedQuietMs ?? 60_000;
    this.design = new DesignTracker(o.home, new Outliner(this.config.languages));
    let assistantRoute = { harness: '', model: '' };
    let assistantSpent = 0;
    this.assistant = new Assistant({
      start: (brief, events) => {
        assistantSpent = 0;
        const role = this.assistantRole();
        const place = { id: ASSISTANT_STREAM, dir: this.repo, sharedDir: join(this.home, 'assistant', 'shared') };
        return this.startSideSession(ASSISTANT, role, place, brief, events, 'Use the MetaHarness tools.', r => {
          assistantRoute = r;
          this.assistantLog('assistant.started', { role: role.name, ...r });
        });
      },
      log: (type, data) => this.assistantLog(type, data),
      route: c => {
        const r = this.pickRoute(this.assistantRole(c));
        return 'error' in r ? r.error : `${r.route.harness}/${r.route.model}@${r.route.effort ?? ''}`;
      },
      usage: u => {
        const cost = this.sideCost(assistantRoute, u);
        if (cost !== undefined && cost !== assistantSpent) this.assistantLog('assistant.usage', { costUsd: (assistantSpent = cost) });
      },
    });
    if (o.settings) Object.assign(this.config.settings, o.settings);
    this.settingsOverride = o.settings;
  }

  private settingsOverride?: DaemonOptions['settings'];
  /** Set by close(): side work still finishing does nothing more. */
  private closing = false;

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
  startGoal(o: { request: string; lead?: string; workflow?: string; playbook?: string; leadDef?: Role; dir?: string; fromRoom?: string }): string {
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
      refs: new Map(), seenOn: new Map(), workflow, chained: [], conflicts: new Map(), notes: new Map(), shared: new SharedFolder(sharedDir), sharedTouches: [],
      status: 'running', agents: new Map(), counters: new Map(), gatekeeperCost: new Map(), leadDone, resolveLeadDone,
    };
    const gs = git.setupGoal(g.dir, id);
    if ('reason' in gs) g.gitNote = gs.reason;
    else {
      g.git = gs;
      g.refs.set(gs.branch, gs.base);
      this.watchAuthors(g, gs);
    }
    this.goals.set(id, g);
    const leadRole = o.leadDef?.name ?? o.lead ?? 'architect';
    this.emit({
      goal: id, type: 'goal.started',
      data: {
        request: o.request, lead: leadRole, workflow: workflow ?? null, sharedDir, dir: g.dir,
        branch: g.git?.branch ?? null, base: g.git?.base ?? null, notice: this.goalNotice(g) ?? null,
        ...(o.fromRoom ? { fromRoom: o.fromRoom } : {}),
      },
    });
    const brief = o.fromRoom ? `${o.request}\n\n${this.roomBackground(o.fromRoom)}` : o.request;
    const r = this.spawnAgent(id, { role: leadRole, roleDef: o.leadDef, brief, parent: 'human', isLead: true, workflow });
    if (!r.ok) {
      g.status = 'ended';
      this.emit({ goal: id, type: 'goal.ended', data: { reason: r.error } });
      throw new Error(r.error);
    }
    g.lead = r.name;
    this.startPolling();
    if (g.git) this.recordDesign(g, g.git, g.git.base, { kind: 'start' });
    return id;
  }

  /**
   * New commits show at once: the git hooks write their author to a file the daemon watches, and
   * that runs the same refresh the poll does. Only while polling is on (tests drive it by hand).
   */
  private watchAuthors(g: GoalRec, gg: git.GoalGit): void {
    if (this.pollMs <= 0) return;
    try {
      const dir = authorsDir(gg.commonDir);
      mkdirSync(dir, { recursive: true });
      let timer: NodeJS.Timeout | undefined;
      g.authorsWatch = watch(dir, () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.refreshGit(g.id), 250);
      });
      g.authorsWatch.on('error', () => g.authorsWatch?.close());
    } catch {
      // The poll still finds the commits.
    }
  }

  /** Resolves once the design snapshots being taken are done (for tests and close). */
  async designIdle(): Promise<void> {
    while (this.designing.size) await Promise.all([...this.designing]);
  }

  /** Takes a design snapshot in the background; what changed since the last one is logged as design.changed. */
  private recordDesign(g: GoalRec, gg: git.GoalGit, sha: string, info: Omit<SnapshotInfo, 'sha' | 'at' | 'change'>): void {
    if (this.config.settings.design === false) return;
    const p = this.design
      .record(g.id, gg, g.dir, { sha, ...info })
      .then(async r => {
        if (!r) return;
        // Reports for what this landing did and for the goal so far, for later goals and models.
        const list = this.design.list(g.id);
        const prev = list.at(-2);
        try {
          if (prev) await this.scopeReport(g.id, gg, g.dir, { kind: 'landing', title: `Work landed${info.by?.length ? ` (${info.by.join(', ')})` : ''}`, from: prev.sha, to: sha, heads: [sha] });
          if (list[0] && list[0].sha !== sha && list[0].sha !== prev?.sha) await this.scopeReport(g.id, gg, g.dir, { kind: 'goal', title: `The goal up to ${sha.slice(0, 7)}`, from: list[0].sha, to: sha, heads: [sha] });
        } catch {
          // The snapshot stands without its reports; looking at the scope builds them again.
        }
        if (!r.info.change) return;
        const c = r.info.change;
        if (c.areas || c.edges || c.symbols || c.files) this.emit({ goal: g.id, type: 'design.changed', data: { sha, ...c } });
      })
      .catch(e => this.emit({ goal: g.id, type: 'design.failed', data: { sha, error: (e as Error).message } }))
      .finally(() => this.designing.delete(p));
    this.designing.add(p);
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
      /** A room's maker: its responsibility and stance, and who asked its first turn. */
      responsibility?: string; stance?: string; askedBy?: string;
    },
  ): SpawnResult {
    const g = this.goals.get(goalId);
    if (!g) return { ok: false, error: `There's no goal ${goalId}.` };
    // The human may start any role; an agent, the ones its workflows use.
    const spawner = g.agents.get(o.parent);
    const scope = this.rolesFor(spawner);
    const roleNames = scope.roles.map(r => r.name);
    const res = o.roleDef ? { match: o.roleDef.name, guessed: false, suggestions: [] } : resolveName(o.role, roleNames);
    if (!o.roleDef && !this.teamRoles().length) return { ok: false, error: 'No roles are defined yet. Add one as .metaharness/roles/<name>.md.' };
    if (!o.roleDef && scope.workflows.length && this.teamRoles().some(r => r.name === o.role && !roleNames.includes(r.name))) {
      const which = scope.workflows.length > 1 ? `the ${scope.workflows.join(' and ')} workflows use` : `the ${scope.workflows[0]} workflow uses`;
      return { ok: false, error: `${o.role} isn't one of the roles ${which}. Roles you can spawn: ${roleNames.join(', ')}.` };
    }
    if (!res.match) {
      const hint = res.suggestions.length ? ` Did you mean ${res.suggestions[0]}?` : '';
      return { ok: false, error: `There's no role called "${o.role}".${hint} Roles you can spawn: ${roleNames.join(', ')}.` };
    }
    const role = o.roleDef ?? this.config.roles.get(res.match)!;
    const picked = this.pickRoute(role);
    if ('error' in picked) return { ok: false, error: picked.error };
    const { harness, model, effort } = picked.route;
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
    const wantWorktree = !o.quick && !o.isLead && !g.room && (o.worktree ?? (role.worktree || !!o.from));
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
      goal: goalId, name, role, harness, model, ...(effort ? { effort } : {}), parent: o.parent, brief: o.brief, ...(o.responsibility ? { responsibility: o.responsibility } : {}), ...(o.stance ? { stance: o.stance } : {}), ...(o.askedBy ? { askedBy: o.askedBy } : {}),
      quick: !!o.quick, isLead: !!o.isLead, cwd, worktree, state: 'starting', status: '', lastText: '',
      adapter, gen: 0, token, systemPrompt: '', inbox: [], waiters: [], doneWaiters: [], pendingApprovals: 0, fileNotes: new Map(),
      toolsRunning: 0, lastToolEnd: 0, progressAt: Date.now(), rules: new RuleState(), ruleNotes: [],
      ...(parentRec ? { lastPartner: { name: parentRec.name, at: Date.now(), text: o.brief, sent: false } } : {}),
    };
    rec.systemPrompt = this.buildPrompt(g, rec, o.workflow, startedFrom);
    g.agents.set(name, rec);
    if (parentRec && !rec.quick) parentRec.lastPartner = { name, at: Date.now(), text: o.brief, sent: true };
    this.emit({
      goal: goalId, agent: name, parent: o.parent, type: 'agent.spawned',
      data: {
        role: role.name, harness, model, ...(effort ? { effort } : {}), brief: o.brief, quick: !!o.quick, cwd, ...(o.responsibility ? { responsibility: o.responsibility } : {}), ...(o.stance ? { stance: o.stance } : {}),
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
    // A resumed session still has what the rules gave it; a fresh one doesn't.
    if (!resume) rec.rules = new RuleState();
    rec.adapter
      .start(
        {
          goal: rec.goal, agent: rec.name, role: rec.role, model: rec.model, effort: rec.effort, systemPrompt: rec.systemPrompt, brief,
          cwd: rec.cwd, sharedDir: g.sharedDir, mcpUrl: this.mcpBase ? `${this.mcpBase}/mcp/${rec.token}` : '',
          hookUrl: this.mcpBase ? `${this.mcpBase}/hook/${rec.token}` : '', agentDir: this.agentDir(rec),
          mcpServers: rec.role.mcp.map(name => ({ name, def: this.config.mcp.get(name) })),
          // Committing writes to the shared .git (and a worktree's own git directory).
          gitDirs: !g.git || rec.quick ? [] : rec.worktree ? [g.git.commonDir, rec.worktree.gitDir] : [g.git.commonDir],
          env: g.git ? guardEnv(this.guardDir, rec.worktree?.branch, g.git.repo, { goal: rec.goal, agent: rec.name }) : undefined,
          sharedCheckout: this.sharedCheckout(rec),
          deniedCommands: deniedCommandPrefixes(this.sharedCheckout(rec)),
          approvals: this.approvalMode(rec),
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
          data: { nativeSession: session.nativeId, harness: rec.harness, model: rec.model, ...(rec.effort ? { effort: rec.effort } : {}), ...(resume ? { resumed: true } : {}) },
        });
        this.pump(rec);
      })
      .catch((err: Error) => {
        // A session that dies while starting may already have reported its exit.
        if (rec.gen !== gen || FINISHED.includes(rec.state)) return;
        this.setState(rec, 'crashed');
        this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.crashed', data: { reason: `Couldn't start: ${err.message}` } });
        this.reportCrash(rec, `${rec.name} couldn't start: ${err.message}`);
      });
  }

  /** A role's primary harness and model, then its backups, as written in the role. */
  routes(role: Role): Route[] {
    const out: Route[] = [{ harness: role.harness, model: role.model, ...(role.effort ? { effort: role.effort } : {}) }];
    for (const f of role.fallback) {
      // harness/model@effort: a backup without an effort of its own thinks as hard as the role says.
      const { model, effort = role.effort } = splitEffort(f);
      const slash = model.indexOf('/');
      out.push({ ...(slash > 0 ? { harness: model.slice(0, slash), model: model.slice(slash + 1) } : { harness: role.harness, model }), ...(effort ? { effort } : {}) });
    }
    if (this.harnessOverride) for (const r of out) r.harness = this.harnessOverride;
    return out.filter((r, i) => out.findIndex(x => x.harness === r.harness && x.model === r.model && x.effort === r.effort) === i);
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
    const inRoom = !!g.room && !rec.quick;
    const paths = inRoom ? this.roomPaths(g) : undefined;
    const parts = [
      !inRoom ? (rec.role.helper ? this.config.helperMethodology : this.config.methodology)
      : rec.isLead ? leadMethodology({ topic: g.request, paths: paths!, lenses: this.lensRoster(g) })
      : lensMethodology({ topic: g.request, lead: g.lead || 'lead', paths: paths!, makes: this.makesOfAgent(g, rec) }),
    ];
    // A maker that's just a model has no role of its own: its responsibility says what it's for.
    if (rec.role.file !== '(room lens)') parts.push(`## Your role: ${rec.role.name}\n\n${rec.role.instructions}`);
    if (rec.responsibility) parts.push(`## Your responsibility in this room\n\n${rec.responsibility}`);
    if (rec.stance) parts.push(`## Your stance in this room\n\n${rec.stance}`);
    // The lead runs the goal's workflow; any role can have one of its own.
    for (const name of [rec.isLead ? workflow : undefined, rec.role.workflow]) {
      const w = name ? this.config.workflows.get(resolveName(name, [...this.config.workflows.keys()]).match ?? '') : undefined;
      const roles = w?.roles.length ? `\n\nThe roles it uses, the ones you can spawn besides quick helpers: ${w.roles.join(', ')}.` : '';
      if (w) parts.push(`## Workflow: ${w.name}\n\nFollow this guide, adapting it to the task. When it says to continue with another workflow, read that one with the \`workflow\` tool.\n\n${w.body}${roles}`);
    }
    if (rec.isLead && !workflow && !g.room && this.config.workflows.size) {
      const list = [...this.config.workflows.values()].map(w => `- ${w.name}: ${w.goodAt || '—'}`).join('\n');
      parts.push(`## Workflows\n\nGuides for running kinds of tasks. If one fits this goal, read it with the \`workflow\` tool and follow it.\n\n${list}`);
    }
    const rules = rulesPrompt(this.agentRules(rec), ruleAgent(rec), rec.cwd);
    if (rules) parts.push(rules);
    const skills = skillsPrompt(this.skillsFor(rec));
    if (skills) parts.push(skills);
    parts.push(
      [
        '## Where you are',
        '',
        `- Your name: ${rec.name}`,
        inRoom ? `- Room: ${g.request}` : `- Goal: ${g.request}`,
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
    const g = this.goals.get(rec.goal);
    if (g?.room && !rec.quick && rec.isLead) {
      return [
        brief,
        '',
        '---',
        "[MetaHarness] You are the facilitator of this brainstorm room: you help the human get clear and decide, keep the board (the `canvas` tool), and send makers (`spawn`, role: the maker's name). Your final message each turn is your reply to the human: keep it short.",
      ].join('\n');
    }
    if (g?.room && !rec.quick) {
      return [
        brief,
        '',
        '---',
        `[MetaHarness] You are ${rec.name}${rec.role.file === '(room lens)' ? '' : `, the ${rec.role.name}`}, a maker in a brainstorm room: ${rec.askedBy === 'human' ? 'the human' : rec.parent} sent you the ask above.`,
        ...(rec.responsibility ? [`Your responsibility here: ${rec.responsibility}`] : [rec.role.instructions]),
        ...(rec.stance ? [`Your stance: ${rec.stance}`] : []),
        '',
        `Put what you make on the board (the \`canvas\` tool), then call \`done\` with a short answer.`,
      ].join('\n');
    }
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
    let sessionTokens: Tokens | undefined;
    /** How full its context was at this session's first report. */
    let startPct: number | undefined;
    return {
      turnStarted: () => {
        if (live()) {
          rec.toolsRunning = 0;
          rec.turnText = '';
        }
        if (live() && !FINISHED.includes(rec.state) && rec.state !== 'paused' && rec.state !== 'limited') this.setState(rec, 'working');
      },
      turnEnded: () => {
        if (!live() || FINISHED.includes(rec.state)) return;
        rec.toolsRunning = 0;
        this.endPause(rec);
        if (rec.held) return void this.setState(rec, 'paused');
        // A turn refused at the rate limit isn't the agent stopping: it continues later.
        if (rec.state === 'limited') return;
        if (rec.doneNote !== undefined) this.setState(rec, 'done');
        else if (!rec.interrupting) this.endedTurnWithoutDone(rec);
        this.pump(rec);
      },
      text: text => {
        if (!live()) return;
        rec.lastText = text;
        rec.turnText = text;
        rec.lastCallAt = Date.now();
        this.emit({ ...base, type: 'agent.text', data: { text } });
      },
      warning: text => {
        if (live()) this.emit({ ...base, type: 'agent.warning', data: { text } });
      },
      toolCall: (tool, summary, info) => {
        if (!live()) return;
        rec.toolsRunning++;
        rec.lastCallAt = Date.now();
        if (!WAITING_TOOLS.test(tool)) this.touch(rec);
        this.noteGitActor(rec, summary);
        this.noteSharedTouch(rec, summary);
        const touched = this.repoPaths(rec, tool, summary, info);
        this.emit({ ...base, type: 'agent.tool_call', data: { tool, summary, ...(touched.paths.length ? touched : {}) } });
        this.toolRules(rec, tool, summary, info);
        this.pinnedNotes(rec, touched.paths);
      },
      toolResult: (summary, ok) => {
        if (!live()) return;
        rec.toolsRunning = Math.max(0, rec.toolsRunning - 1);
        rec.lastToolEnd = Date.now();
        this.emit({ ...base, type: 'agent.tool_result', data: { summary, ok } });
      },
      usage: u => {
        if (!live()) return;
        const session = tokensOf(u, sessionTokens);
        // More tokens means another model call, which refreshes the prompt cache.
        if (tokenCount(session) > tokenCount(sessionTokens)) rec.lastCallAt = Date.now();
        sessionTokens = session;
        rec.tokens = addTokens(rec.tokensBefore, session);
        if (u.cacheMinutes) rec.cacheMinutes = u.cacheMinutes;
        if (u.contextTokens) rec.contextTokens = u.contextTokens;
        if (u.contextPct !== undefined) {
          rec.contextPct = u.contextPct;
          startPct ??= u.contextPct;
        }
        this.checkContext(rec, startPct);
        // The harness's cost when it reports one, else the settings' prices for its tokens.
        const prices = modelSettings(this.config.settings, rec.harness, rec.model).prices;
        const split = u.costSplit ?? (prices ? priceSplit(session, prices) : undefined);
        let est: number | undefined;
        if (u.costUsd !== undefined) {
          rec.cost = (rec.costBefore ?? 0) + u.costUsd;
          rec.costSource = 'harness';
        } else if (split) {
          est = splitTotal(split);
          rec.cost = (rec.costBefore ?? 0) + est;
          rec.costSource = 'prices';
        }
        if (split) rec.costSplit = addSplit(rec.splitBefore, split);
        this.emit({ ...base, type: 'usage', data: { ...u, ...(split ? { costSplit: split } : {}), ...(est !== undefined ? { estCostUsd: est } : {}) } });
      },
      rateLimit: info => live() && this.onRateLimit(rec, info),
      exited: (reason, detail) => {
        if (!live() || FINISHED.includes(rec.state)) return;
        const state = reason === 'crashed' ? 'crashed' : 'ended';
        this.setState(rec, state);
        this.emit({ ...base, type: `agent.${state}`, data: { reason: detail ?? reason } });
        if (rec.doneNote === undefined) {
          const why = state === 'crashed' && detail ? ` (${detail})` : '';
          const note = `${rec.name} ${state} before calling done${why}.` + (rec.lastText ? ` Its last message: ${rec.lastText}` : '');
          if (state === 'crashed') this.reportCrash(rec, note);
          else this.finish(rec, note, state);
        }
      },
      approval: (tool, detail) => (live() ? this.requestApproval(rec, tool, detail) : Promise.resolve({ allow: false, message: 'This session was replaced.' })),
      decide: async t => {
        if (!live()) return { allow: false, message: 'This session was replaced.' };
        const d = await this.decideTool(rec, t);
        // These harnesses (ACP, Codex) only learn "declined", so the reason follows as a notice.
        if (!d.allow && d.message && live()) this.notice(rec, `MetaHarness refused ${t.tool}: ${t.detail.replace(/\s+/g, ' ').slice(0, 160)}. ${d.message}`);
        return d;
      },
      pull: () => (live() ? this.takeForTurn(rec, 'tool_result') : undefined),
    };
  }

  /** A new session starts its totals from zero: what the earlier ones spent is kept apart. */
  private carryOver(rec: AgentRec): void {
    rec.costBefore = rec.cost;
    rec.tokensBefore = rec.tokens;
    rec.splitBefore = rec.costSplit;
  }

  /** Which agent an MCP token belongs to. */
  agentForToken(token: string): { goal: string; agent: string } | undefined {
    return this.tokens.get(token);
  }

  /** A tool call the harness asks about: the policy decides, or else the human. */
  async decideTool(rec: AgentRec, t: ToolRequest): Promise<ApprovalDecision> {
    const verdict = this.policyVerdict(rec, t);
    return verdict !== 'ask' ? { allow: verdict.allow, message: verdict.reason } : this.requestApproval(rec, t.tool, t.detail);
  }

  /**
   * A permission request the rules didn't settle: the gatekeeper's verdict where the approval
   * mode has one, else (or when it says ASK) the human's, from the Inbox.
   */
  async requestApproval(rec: AgentRec, tool: string, detail: string): Promise<ApprovalDecision> {
    const refused = tool === 'Bash' ? refusedGitCommand(detail, { sharedCheckout: this.sharedCheckout(rec) }) : undefined;
    if (refused) {
      this.emit({ goal: rec.goal, agent: rec.name, type: 'approval.refused', data: { tool, detail: detail.slice(0, 2000), why: refused } });
      return { allow: false, message: refused };
    }
    // Commands that only read don't need the human (design §10), whichever harness asks.
    if (tool === 'Bash' && rec.role.autoApprove !== 'none' && readOnlyCommand(detail).readOnly) {
      this.emit({ goal: rec.goal, agent: rec.name, type: 'approval.auto', data: { tool, detail: detail.slice(0, 2000), why: 'read-only' } });
      return { allow: true };
    }
    const g = this.goals.get(rec.goal)!;
    // What the gatekeeper and the human read: the script without Codex's `bash -lc '…'` around it.
    const shown = tool === 'Bash' ? unwrapShell(detail) : detail;
    let note: string | undefined;
    if (this.usesGatekeeper(rec)) {
      const seen = tool === 'Bash' ? elideHeredocs(shown) : shown;
      const j = await this.gatekeeperFor(g).judge({
        agent: rec.name, role: rec.role.name, brief: rec.brief, tool, detail: seen, shared: g.sharedDir,
        where: `${rec.cwd}${g.room && !rec.quick ? ' (a brainstorm room: it may run and test the code, and write in the shared folder, not change project files)' : rec.worktree ? ' (its own worktree)' : this.sharedCheckout(rec) ? " (the human's checkout, shared with teammates)" : ''}`,
      });
      this.emit({ goal: rec.goal, agent: rec.name, type: 'approval.gatekeeper', data: { tool, detail: seen.slice(0, 2000), verdict: j.verdict, reason: j.reason, ...(j.remembered ? { remembered: true } : {}) } });
      if (j.verdict === 'allow') return { allow: true };
      if (j.verdict === 'deny') return { allow: false, message: `The gatekeeper refused this: ${j.reason} If it's really needed, ask the human (send, to: human) and say why.` };
      note = `Gatekeeper: ${j.reason}`;
    }
    rec.pendingApprovals++;
    return new Promise(resolve => {
      this.toHuman(
        g, rec.name, 'approval', `${tool}: ${shown}`,
        item =>
          this.approvals.set(item.id, d => {
            rec.pendingApprovals--;
            resolve(d);
          }),
        note,
      );
    });
  }

  /** How this agent's approvals are decided: its role's setting, else the settings'. */
  approvalMode(rec: AgentRec): ApprovalMode {
    return rec.role.approvals ?? this.config.settings.approvals;
  }

  private usesGatekeeper(rec: AgentRec): boolean {
    return this.approvalMode(rec) !== 'ask' && rec.role.name !== this.config.settings.gatekeeper && this.config.roles.has(this.config.settings.gatekeeper);
  }

  /** Roles a team can spawn: all but the gatekeeper, the assistant and the room lead. */
  teamRoles(): Role[] {
    const { gatekeeper, assistant, roomLead } = this.config.settings;
    return [...this.config.roles.values()].filter(r => r.name !== gatekeeper && r.name !== assistant && r.name !== roomLead);
  }

  /**
   * The roles an agent may start. A workflow can name the roles it uses, so a lead with many
   * roles to choose from sees only the right ones: those of the workflows in play (the goal's,
   * and those the lead chained to; an agent whose role has a workflow of its own, that one's),
   * plus quick helpers. Every role when no workflow in play names any.
   */
  rolesFor(rec?: AgentRec): { roles: Role[]; workflows: string[] } {
    const all = this.teamRoles();
    const g = rec && this.goals.get(rec.goal);
    if (!rec || !g) return { roles: all, workflows: [] };
    const names = rec.role.workflow && !rec.isLead ? [rec.role.workflow] : [g.workflow, ...g.chained].filter((w): w is string => !!w);
    const flows = names.map(n => this.config.workflows.get(resolveName(n, [...this.config.workflows.keys()]).match ?? '')).filter((w): w is Workflow => !!w);
    if (!flows.length || flows.some(w => !w.roles.length)) return { roles: all, workflows: [] };
    const allowed = new Set(flows.flatMap(w => w.roles));
    return { roles: all.filter(r => r.helper || allowed.has(r.name)), workflows: flows.map(w => w.name) };
  }

  /** The lead read a workflow: when it's the next in a chain, its roles become startable. */
  workflowRead(rec: AgentRec, name: string): void {
    const g = this.goals.get(rec.goal);
    if (!g || !rec.isLead || g.workflow === name || g.chained.includes(name)) return;
    g.chained.push(name);
    this.emit({ goal: rec.goal, agent: rec.name, type: 'workflow.read', data: { workflow: name } });
  }

  /** The assistant's role, on the model and effort picked in its panel when there are. */
  private assistantRole(choice = this.assistant.choice): Role {
    const role = this.config.roles.get(this.config.settings.assistant)!;
    const { harness, model, effort } = choice;
    return { ...role, ...(harness && model ? { harness, model, fallback: [] } : {}), ...(effort ? { effort } : {}) };
  }

  /** Logs to the assistant's conversation, which the app follows as its own event stream. */
  assistantLog(type: string, data: Record<string, unknown>): void {
    const e = this.emit({ goal: ASSISTANT_STREAM, agent: ASSISTANT, type, data: { conv: this.assistant.conv, ...data } });
    if (this.assistantFrom?.conv !== e.data.conv) this.assistantFrom = { conv: String(e.data.conv), seq: e.seq - 1 };
  }

  /** Where the current conversation starts in the assistant's stream, so the app reads only it. */
  private assistantFrom?: { conv: string; seq: number };

  /** The goal's gatekeeper: a session of the gatekeeper role, started on its first request. */
  private gatekeeperFor(g: GoalRec): Gatekeeper {
    if (g.gatekeeper) return g.gatekeeper;
    const role = this.config.roles.get(this.config.settings.gatekeeper)!;
    const log = (type: string, data: Record<string, unknown>) => this.emit({ goal: g.id, agent: GATEKEEPER, type, data });
    let route = { harness: role.harness, model: role.model };
    g.gatekeeper = new Gatekeeper(
      {
        start: (brief, events) =>
          this.startSideSession(GATEKEEPER, role, g, brief, events, 'The gatekeeper has no MetaHarness tools. Answer ALLOW, DENY or ASK.', r => {
            route = r;
            log('gatekeeper.started', { role: role.name, ...r });
          }),
        usage: (u, session) => {
          const cost = this.sideCost(route, u);
          if (cost === undefined) return;
          g.gatekeeperCost.set(session, cost);
          log('gatekeeper.usage', { ...u, costUsd: cost, total: this.gatekeeperCost(g) });
        },
        log,
      },
      this.gatekeeperLimits,
    );
    return g.gatekeeper;
  }

  /**
   * A session that isn't a teammate (the gatekeeper, the assistant): its role's first route that
   * can run, in `place`, with its own token for MCP and hooks, asking before anything but reads.
   */
  private async startSideSession(
    name: string, role: Role, place: { id: string; dir: string; sharedDir: string }, brief: string, events: SessionEvents, noTools: string,
    started: (route: { harness: string; model: string; effort?: string; note?: string }) => void,
  ): Promise<Session> {
    const picked = this.pickRoute(role);
    if ('error' in picked) throw new Error(picked.error);
    const { harness, model, effort } = picked.route;
    const token = randomBytes(16).toString('hex');
    this.tokens.set(token, { goal: place.id, agent: name });
    started({ harness, model, ...(effort ? { effort } : {}), ...(picked.note ? { note: picked.note } : {}) });
    const agentDir = join(this.home, place.id === ASSISTANT_STREAM ? 'assistant' : join('goals', place.id, 'agents', name));
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(place.sharedDir, { recursive: true });
    return this.adapters[harness].start(
      {
        goal: place.id, agent: name, role: { ...role, permissionMode: 'default', approvals: 'ask' }, model, ...(effort ? { effort } : {}),
        systemPrompt: role.instructions, brief, cwd: place.dir, sharedDir: place.sharedDir, gitDirs: [],
        mcpUrl: this.mcpBase ? `${this.mcpBase}/mcp/${token}` : '', hookUrl: this.mcpBase ? `${this.mcpBase}/hook/${token}` : '',
        agentDir, mcpServers: [], sharedCheckout: true, deniedCommands: deniedCommandPrefixes(true),
        callTool: async () => noTools,
      },
      events,
    );
  }

  /** A side session's spend so far: what its harness reports, else its tokens at the settings' prices. */
  private sideCost(route: { harness: string; model: string }, u: Usage): number | undefined {
    if (u.costUsd !== undefined) return u.costUsd;
    const prices = modelSettings(this.config.settings, route.harness, route.model).prices;
    return prices ? splitTotal(priceSplit(tokensOf(u), prices)) : undefined;
  }

  private gatekeeperCost(g: GoalRec): number {
    return [...g.gatekeeperCost.values()].reduce((a, b) => a + b, 0);
  }

  /** The adapter a session runs on: a teammate's, or the gatekeeper's or assistant's role's first runnable route. */
  adapterFor(goal: string, agent: string): HarnessAdapter | undefined {
    const side = agent === GATEKEEPER ? this.config.settings.gatekeeper : agent === ASSISTANT ? this.config.settings.assistant : undefined;
    if (!side) return this.agent(goal, agent)?.adapter;
    const role = agent === ASSISTANT ? this.assistantRole() : this.config.roles.get(side);
    const r = role && this.pickRoute(role);
    return !r || 'error' in r ? undefined : this.adapters[r.route.harness];
  }

  /** What a tool call by a session that isn't a teammate (the gatekeeper) may do. */
  outsiderDecision(agent: string, t: ToolRequest): ApprovalDecision {
    if (agent === GATEKEEPER) return Gatekeeper.decide(t);
    if (agent === ASSISTANT) return assistantDecision(t, this.assistant.choice.write);
    return { allow: false, message: 'MetaHarness does not know this agent.' };
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
    const g = this.goals.get(rec.goal)!;
    // In a room, the turn's last message is the lead's reply, or a maker's answer.
    if (g.room && this.roomTurnWithoutDone(g, rec)) return;
    // A role woken by events (the cartographer) rests between them: nothing to report.
    if (rec.inbox.length || rec.role.wake?.length) return;
    const activeChildren = [...g.agents.values()].some(a => a.parent === rec.name && a.doneNote === undefined && !FINISHED.includes(a.state));
    if (activeChildren) return;
    const note = rec.lastText || '(no message)';
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.idle', data: { note } });
    this.finish(rec, `${rec.name} stopped without calling done. Its last message: ${note}`, 'idle');
  }

  setState(rec: AgentRec, state: AgentState): void {
    if (rec.state === state) return;
    rec.state = state;
    if (state === 'done' || state === 'idle') rec.settledAt = Date.now();
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.state', data: { state } });
    if (['done', 'idle', 'ended', 'crashed'].includes(state)) this.cleanUpIfIdle(this.goals.get(rec.goal)!);
  }

  /* ---------------- tools (called through the hub) ---------------- */

  /**
   * Teammates an agent spawned whose results aren't in yet: at work, or resting while their own
   * teammates work. Quick helpers answer inline, and roles woken by events (the cartographer) never finish.
   */
  workingChildren(rec: AgentRec): AgentRec[] {
    const all = [...this.goals.get(rec.goal)!.agents.values()];
    const working = (a: AgentRec): boolean =>
      !a.quick && !a.role.wake?.length && a.doneNote === undefined && !FINISHED.includes(a.state) &&
      (a.state !== 'idle' || a.inbox.length > 0 || all.some(c => c.parent === a.name && working(c)));
    return all.filter(a => a.parent === rec.name && working(a));
  }

  /** The answer to a done called while teammates it spawned still work: it hears who, and decides what's next. */
  doneHeld(rec: AgentRec, working: AgentRec[]): string {
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.done_held', data: { working: working.map(a => a.name) } });
    return [
      "Not done yet: teammates you spawned are still working, and their results aren't in:",
      ...working.map(a => `- ${a.name} (${a.role.name}): ${a.state}${a.status ? `, ${a.status.slice(0, 200)}` : ''}`),
      '',
      'Decide what comes next: wait for their results (wait), tell them what to do (send), for example to wrap up and call done, or carry on with your own part. Call done once they have reported back.',
    ].join('\n');
  }

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
    if (g.room && !rec.quick) {
      // A maker's answer goes to whoever asked: the lead, as any teammate's, or the human, the
      // lead only hearing of it; the chat shows it either way. The lead's replies never come here.
      if (rec.parent === g.lead && !rec.isLead) {
        if (this.lensAnswered(g, rec, note, how)) return;
      } else if (rec.parent === 'human') {
        this.roomNote(g, `${rec.name}: ${note}`);
        if (how === 'crashed') this.toHuman(g, rec.name, 'crash', note);
        return;
      }
    }
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

  /**
   * A crash goes to whoever spawned the agent, with what they can do about it: they decide
   * (design §8). The lead hears about crashes further down the team too, and either may respawn.
   */
  private reportCrash(rec: AgentRec, note: string): void {
    if (rec.quick) return this.finish(rec, note, 'crashed');
    const g = this.goals.get(rec.goal)!;
    const others = this.routes(rec.role)
      .filter(r => this.adapters[r.harness] && !(r.harness === rec.harness && r.model === rec.model))
      .map(r => `${r.harness}/${r.model}`);
    const elsewhere = others.length ? `, or on: ${others.join(' or ')} to run it there` : '';
    const hint =
      rec.parent === 'human'
        ? `Respawn it from its page in the app, or with mh respawn ${rec.name} (--fresh to start it over from a handoff${others.length ? `, --on ${others[0]} to run it elsewhere` : ''}).`
        : `To carry on, call respawn with name: ${rec.name}. Its session resumes where it stopped; add fresh: true to start it over from a handoff instead${elsewhere}. ` +
          `The crashed one then stays on the team as ${rec.name}-crashed. Or give its work to someone else. Until then, messages to ${rec.name} come to you.`;
    this.finish(rec, `${note}\n\n${hint}`, 'crashed');
    const lead = g.agents.get(g.lead);
    if (lead && lead !== rec && lead.name !== rec.parent && !FINISHED.includes(lead.state)) {
      this.notice(lead, `${rec.name} (spawned by ${rec.parent}) crashed. ${rec.parent} has been told and can respawn it; so can you (respawn with name: ${rec.name}).`);
    }
  }

  /**
   * Starts a crashed agent again under its name. The crashed one stays on the team, with its
   * history, as <name>-crashed; the new one takes its role, brief, spawner, worktree and waiting
   * messages. It resumes the crashed session, unless `fresh` or `on` (another of the role's routes)
   * asks for a new one, which starts from a handoff. `by` is the human, the agent's spawner or the lead.
   */
  respawnAgent(goalId: string, name: string, o: { by: string; fresh?: boolean; on?: string; note?: string }): { ok: true; text: string } | { ok: false; error: string } {
    const g = this.goals.get(goalId);
    if (!g) return { ok: false, error: `There's no goal ${goalId} running here.` };
    const rec = g.agents.get(name);
    if (!rec) {
      const crashed = [...g.agents.values()].filter(a => a.state === 'crashed' && !a.quick).map(a => a.name);
      return { ok: false, error: `There's no agent called ${name}. Crashed teammates: ${crashed.join(', ') || 'none'}.` };
    }
    if (rec.state !== 'crashed') return { ok: false, error: `${name} hasn't crashed (it's ${rec.state}), so there's nothing to respawn.` };
    if (rec.quick) return { ok: false, error: `${name} was a quick helper: spawn a new one instead.` };
    const caller = g.agents.get(o.by);
    if (o.by !== 'human' && !caller?.isLead && rec.parent !== o.by) return { ok: false, error: `Only ${rec.parent} (who spawned ${name}) or the lead can respawn it.` };

    const runnable = this.routes(rec.role).filter(r => this.adapters[r.harness]);
    let route: Route = { harness: rec.harness, model: rec.model, ...(rec.effort ? { effort: rec.effort } : {}) };
    if (o.on) {
      const want = o.on.trim().toLowerCase();
      const found =
        runnable.find(r => `${r.harness}/${r.model}`.toLowerCase() === want) ?? runnable.find(r => r.model.toLowerCase() === want) ?? runnable.find(r => r.harness.toLowerCase() === want);
      if (!found) return { ok: false, error: `${rec.role.name} runs on ${runnable.map(r => `${r.harness}/${r.model}`).join(', ') || 'nothing MetaHarness can start here'}; "${o.on}" isn't one of them.` };
      route = found;
    }
    if (!this.adapters[route.harness]) return { ok: false, error: `MetaHarness can't run ${route.harness} here. Pick another with on: ${runnable.map(r => `${r.harness}/${r.model}`).join(', ') || '(none)'}.` };
    const same = route.harness === rec.harness && route.model === rec.model;
    const nativeId = rec.session?.nativeId ?? rec.resumeId;
    const resume = !o.fresh && same && this.adapters[route.harness].manifest.resume && nativeId ? nativeId : undefined;
    const reason = String(this.store.since(goalId).filter(e => e.agent === name && e.type === 'agent.crashed').at(-1)?.data.reason ?? 'it crashed');
    const by = o.by === 'human' ? 'the human' : o.by;

    // The first message is built from the crashed agent's history, before that history is renamed.
    const entries = rec.inbox.splice(0);
    const news = [o.note ? `From ${by}: ${o.note}` : '', this.forAgent(rec, entries)].filter(Boolean).join('\n\n');
    const first = resume
      ? [`[MetaHarness] Your session crashed (${reason}), and ${by} started it again. A command or tool call you were in may not have finished. Check where your work stands (files, git status), then carry on.`, news]
          .filter(Boolean).join('\n\n')
      : this.handoff(rec, { harness: rec.harness, model: rec.model }, `it crashed (${reason})`, { fresh: same, news: news || undefined });

    let old = `${name}-crashed`;
    for (let n = 2; g.agents.has(old); n++) old = `${name}-crashed-${n}`;
    this.store.renameAgent(goalId, name, old);
    // A new session gets a folder of its own; a resumed one may keep what its harness left there.
    const dir = join(this.home, 'goals', goalId, 'agents', name);
    if (!resume && existsSync(dir)) {
      try {
        renameSync(dir, join(this.home, 'goals', goalId, 'agents', old));
      } catch {
        // It keeps the folder.
      }
    }
    g.agents.set(old, { ...rec, name: old, isLead: false, worktree: undefined, session: undefined, inbox: [], waiters: [], doneWaiters: [], fileNotes: new Map(), ruleNotes: [], pause: undefined, refresh: undefined, limitTimer: undefined });
    for (const i of this.humanInbox) if (i.goal === goalId && i.agent === name) i.agent = old;
    this.emit({ goal: goalId, agent: old, type: 'agent.renamed', data: { from: name, to: old, by: o.by } });
    for (const i of this.humanInbox.filter(i => i.goal === goalId && i.agent === old && i.kind === 'crash')) this.resolveInbox(i.id, 'dismiss');

    // The same record carries on as the new agent, so its credential and its place on the team stay.
    const s = rec.session;
    rec.gen++;
    rec.session = undefined;
    void s?.stop().catch(() => {});
    clearTimeout(rec.limitTimer);
    this.endPause(rec);
    this.clearRefresh(rec);
    Object.assign(rec, {
      harness: route.harness, model: route.model, effort: route.effort, adapter: this.adapters[route.harness], state: 'starting', status: '', lastText: '',
      cost: undefined, costBefore: undefined, costSource: undefined, tokens: undefined, tokensBefore: undefined, costSplit: undefined, splitBefore: undefined,
      lastCallAt: undefined, cacheMinutes: undefined, cacheReminded: undefined, contextTokens: undefined, contextPct: undefined, pendingBrief: undefined,
      limitedUntil: undefined, interrupting: false, toolsRunning: 0, lastToolEnd: 0, held: undefined, waiters: [], doneWaiters: [], doneNote: undefined,
      pendingApprovals: 0, settledAt: undefined, progressAt: Date.now(), stallReported: undefined, resumeId: resume,
    } satisfies Partial<AgentRec>);
    const wt = rec.worktree;
    this.emit({
      goal: goalId, agent: name, parent: rec.parent, type: 'agent.spawned',
      data: {
        role: rec.role.name, harness: rec.harness, model: rec.model, ...(rec.effort ? { effort: rec.effort } : {}), brief: rec.brief, quick: false, cwd: rec.cwd,
        worktree: wt?.path ?? null, branch: wt?.branch ?? null, base: wt?.base ?? null, ...(wt?.deps?.length ? { deps: wt.deps } : {}),
        replaces: old, by: o.by, resumed: !!resume,
      },
    });
    this.markDelivered(rec, entries, resume ? 'resume' : 'handoff');
    if (this.accountLimited(rec.harness, rec.model)) {
      rec.pendingBrief = first;
      this.hitLimit(rec);
    } else this.startSession(rec, first);
    const how = resume ? 'resuming its session' : same ? 'in a fresh session, from a handoff' : 'from a handoff';
    const to = rec.parent === o.by ? 'you' : rec.parent === 'human' ? 'the human' : rec.parent;
    return { ok: true, text: `Started ${name} again on ${rec.harness} · ${rec.model}, ${how}. The crashed one is kept as ${old}. ${name} reports to ${to} when it calls done, as before.` };
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
    const authors = readAuthors(gg.commonDir, g.id);
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
      // The hooks say who made each commit; failing that, a worktree's owner, or whoever in the
      // human's checkout last ran a committing git command.
      const branchOwner = [...g.agents.values()].find(a => a.worktree?.branch === branch)?.name ?? (branch === gg.branch ? this.checkoutActor(g) : undefined);
      const ownerOf = (sha: string) => authors.get(sha) ?? branchOwner;
      const landing = branch === gg.branch;
      // Name a merge after the branch its commit was made on. Several branches can point at the
      // same commit (a reviewer's starts at the implementer's tip), so asking git is a last resort.
      const merged = (from: string, sha: string, fastForward?: boolean) => {
        const stats = git.commitStats(gg, sha);
        this.emit({
          goal: g.id, agent: ownerOf(sha), type: 'git.merge',
          data: {
            from: g.seenOn.get(from) ?? git.branchOf(gg, g.id, from, branch) ?? from.slice(0, 7),
            into: branch, sha, ...(fastForward ? { fastForward } : {}),
            ...(fastForward ? {} : { files: stats.files, added: stats.added, removed: stats.removed, paths: stats.paths }),
          },
        });
      };
      if (landing) g.landing ??= { from: old, commits: [] };
      // Commits already reported on another branch arrived here by a fast-forward merge.
      let fastForwarded = '';
      for (const c of git.commitsBetween(gg, old, sha)) {
        const stats = git.commitStats(gg, c.sha);
        if (landing) {
          // A commit fast-forwarded in from a teammate's branch is theirs, not the merger's.
          const seen = g.seenOn.get(c.sha);
          const ownerOfBranch = (b?: string) => [...g.agents.values()].find(a => a.worktree?.branch === b)?.name;
          const agent = authors.get(c.sha) ?? (seen && seen !== branch ? ownerOfBranch(seen) : branchOwner);
          const brought = c.mergedSha ? [...new Set(git.mergedCommits(gg, c.sha).map(s => authors.get(s) ?? ownerOfBranch(g.seenOn.get(s))).filter((a): a is string => !!a))] : [];
          g.landing!.commits.push({ sha: c.sha, summary: c.summary, ...(agent ? { agent } : {}), paths: stats.paths, merge: !!c.mergedSha, ...(brought.length ? { brought } : {}) });
        }
        if (g.seenOn.has(c.sha)) {
          fastForwarded = c.sha;
          continue;
        }
        if (fastForwarded) merged(fastForwarded, fastForwarded, true);
        fastForwarded = '';
        g.seenOn.set(c.sha, branch);
        const owner = ownerOf(c.sha);
        this.emit({
          goal: g.id, agent: owner, type: 'git.commit',
          data: { branch, sha: c.sha, summary: c.summary, files: stats.files, added: stats.added, removed: stats.removed, paths: stats.paths },
        });
        if (c.mergedSha) merged(c.mergedSha, c.sha);
        else if (owner) this.commitRules(g, gg, owner, c.sha);
      }
      if (fastForwarded) merged(fastForwarded, fastForwarded, true);
      if (landing) this.scheduleLanded(g, gg);
    }
    this.refreshConflicts(g, gg);
  }

  /**
   * Work landed on the goal branch: once it has been quiet for landedQuietMs, it's announced in
   * one go (`git.landed`), a design snapshot is taken, and roles that asked to be woken by it
   * (`wake: landed`, e.g. the cartographer) hear what came in.
   */
  private scheduleLanded(g: GoalRec, gg: git.GoalGit): void {
    const l = g.landing;
    if (!l?.commits.length) return;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => this.landed(g, gg), this.landedQuietMs);
    l.timer.unref?.();
  }

  /** Announces what landed since the last time (see scheduleLanded). Public for tests, which don't wait. */
  landed(g: GoalRec, gg = g.git): void {
    const l = g.landing;
    g.landing = undefined;
    if (!l?.commits.length || !gg) return;
    clearTimeout(l.timer);
    const to = l.commits.at(-1)!.sha;
    const by = [...new Set(l.commits.flatMap(c => [...(c.brought ?? []), c.agent]).filter((a): a is string => !!a))];
    const paths = [...new Set(l.commits.flatMap(c => c.paths))];
    this.emit({
      goal: g.id, type: 'git.landed',
      data: { branch: gg.branch, from: l.from, to, commits: l.commits.length, by, paths: paths.slice(0, 200), summaries: l.commits.slice(-20).map(c => c.summary) },
    });
    this.recordDesign(g, gg, to, { kind: 'landed', by, summaries: l.commits.slice(-20).map(c => c.summary) });
    for (const rec of g.agents.values()) {
      if (!rec.role.wake?.includes('landed') || rec.quick || FINISHED.includes(rec.state)) continue;
      // Its own commits (the map it just wrote) don't wake it again.
      if (l.commits.every(c => c.agent === rec.name)) continue;
      this.notice(rec, landedNote(gg.branch, l.from, to, l.commits, paths));
    }
  }

  /** Looks at git and the shared folders every few seconds, once there's a goal. */
  private startPolling(): void {
    if (this.pollMs <= 0 || this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.refreshGit();
      this.refreshShared();
      this.checkCaches();
      this.checkStalls();
      this.releaseIdle();
    }, this.pollMs).unref();
  }

  /**
   * Agents that finished and have been quiet for releaseMs let their process go: a CLI waiting
   * for a message that may never come still holds memory, MCP servers and whatever its commands
   * left running. Their native session resumes when a message comes, as after a restart.
   */
  releaseIdle(now = Date.now()): void {
    if (this.releaseMs <= 0) return;
    for (const g of this.goals.values())
      for (const rec of g.agents.values()) {
        const s = rec.session;
        if (!s || s.busy() || !s.nativeId || !rec.adapter.manifest.resume || !['done', 'idle'].includes(rec.state)) continue;
        if (rec.inbox.length || rec.waiters.length || rec.pendingApprovals || rec.pause || rec.held || rec.refresh) continue;
        if (now - (rec.settledAt ?? now) < this.releaseMs) continue;
        rec.gen++;
        rec.session = undefined;
        rec.resumeId = s.nativeId;
        this.carryOver(rec);
        void s.stop().catch(() => {});
        this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.released', data: { idleMs: now - (rec.settledAt ?? now) } });
      }
  }

  /**
   * Prompt caches about to expire (DESIGN.md §12). An agent that's between tasks with a large
   * context costs much more to start again once its cache is gone, so its spawner hears about
   * it shortly before: in its running turn, or through the wait it's in. An idle spawner isn't
   * woken for it (that turn would cost more than the cache saves). The human hears about the
   * agents they spawned (the lead) in the app. Each idle spell is reminded once.
   */
  checkCaches(now = Date.now()): void {
    const s = this.config.settings;
    if (!s.cacheReminders) return;
    for (const g of this.goals.values()) {
      if (g.status === 'ended') continue;
      const due = new Map<string, { rec: AgentRec; inSec: number }[]>();
      for (const a of g.agents.values()) {
        if (a.quick || !a.lastCallAt || a.cacheReminded === a.lastCallAt || !['idle', 'done', 'waiting'].includes(a.state)) continue;
        if (a.contextTokens !== undefined && a.contextTokens < s.cacheRemindMinTokens) continue;
        const left = a.lastCallAt + this.cacheLifetime(a) * 60_000 - now;
        if (left <= 0 || left > s.cacheRemindSec * 1000) continue;
        a.cacheReminded = a.lastCallAt;
        due.set(a.parent, [...(due.get(a.parent) ?? []), { rec: a, inSec: Math.round(left / 1000) }]);
      }
      for (const [parent, list] of due) {
        const p = parent === 'human' ? undefined : g.agents.get(parent);
        const reachable = !!p && (p.state === 'waiting' || (p.state === 'working' && p.adapter.manifest.injectMidTurn && !!p.session?.busy()));
        const to = parent === 'human' ? 'human' : reachable ? 'parent' : 'nobody';
        for (const { rec, inSec } of list) {
          this.emit({ goal: g.id, agent: rec.name, type: 'agent.cache_expiring', data: { parent, inSec, contextTokens: rec.contextTokens ?? null, told: to } });
        }
        if (to !== 'parent') continue;
        const names = list.map(({ rec, inSec }) => `${rec.name} (in about ${inSec < 90 ? `${inSec} s` : `${Math.round(inSec / 60)} min`}${rec.contextTokens ? `, ${Math.round(rec.contextTokens / 1000)}k tokens of context` : ''})`);
        this.notice(
          p!,
          `Prompt cache about to expire for ${names.join(', ')}. If you have more work for ${list.length > 1 ? 'them' : 'it'}, send it now: after that, ${list.length > 1 ? 'their' : 'its'} next turn pays to read the whole context again. Otherwise ignore this.`,
        );
      }
    }
  }

  /** The agent did something besides waiting (see stall reports). */
  touch(rec: AgentRec): void {
    rec.progressAt = Date.now();
  }

  /**
   * Agents stuck waiting (DESIGN.md §8): nothing but `wait` for stallMinutes, and what they'd be
   * waiting for can't come, because the teammate they last dealt with is stuck too or has
   * finished, or because nobody on the team is doing anything. Agents waiting on the human, on an
   * approval, or on helpers of their own that still work aren't stuck. The lead hears, once per
   * stuck spell: a stall usually means the plan left a gap, which is the lead's to fix. The human
   * hears when the lead has finished, or when the whole team, lead included, stays stuck for
   * another stallMinutes after the lead was told.
   */
  checkStalls(now = Date.now()): void {
    const mins = this.config.settings.stallMinutes;
    if (!mins) return;
    const ms = mins * 60_000;
    for (const g of this.goals.values()) {
      if (g.status === 'ended') continue;
      const going = [...g.agents.values()].filter(a => !a.quick && !FINISHED.includes(a.state) && (a.doneNote === undefined || a.session?.busy()));
      // Idle with no teammates of its own still going: it stopped, and its spawner was told.
      const live = going.filter(a => a.state !== 'idle' || going.some(c => c.parent === a.name));
      if (!live.length) continue;
      if (g.stall && live.some(a => a.progressAt > g.stall!.at)) g.stall = undefined;
      const asking = new Set(this.humanInbox.filter(i => i.goal === g.id && ['approval', 'decision', 'question', 'stalled'].includes(i.kind)).map(i => i.agent));
      const isStuck = (a: AgentRec) =>
        (a.state === 'waiting' || a.state === 'idle') && !a.held && !a.pendingApprovals && !a.inbox.length && !asking.has(a.name) && now - a.progressAt >= ms;
      const stuck = new Set(live.filter(isStuck));
      const everyone = stuck.size === live.length;
      const gone = (name: string) => {
        const p = g.agents.get(name);
        return !!p && !p.quick && !live.includes(p);
      };
      const goneAs = (name: string) => {
        const st = g.agents.get(name)!.state;
        return st === 'done' ? 'finished' : st === 'idle' ? 'stopped without calling done' : st;
      };
      const report: { a: AgentRec; why: string }[] = [];
      for (const a of stuck) {
        if (live.some(c => c.parent === a.name && !stuck.has(c))) continue;
        const p = a.lastPartner;
        const partner = p && g.agents.get(p.name);
        const why =
          partner && stuck.has(partner) ? `${partner.name} is waiting too`
          : p && gone(p.name) ? `${p.name} has ${goneAs(p.name)}`
          : everyone ? 'nobody on the team is working'
          : '';
        if (why) report.push({ a, why });
      }
      const lead = g.agents.get(g.lead);
      const leadHere = !!lead && live.includes(lead);
      const fresh = report.filter(r => r.a.stallReported !== r.a.progressAt);
      if (fresh.length) {
        for (const r of fresh) r.a.stallReported = r.a.progressAt;
        const lines = fresh.map(({ a, why }) => this.stallLine(a, why, now));
        const told = leadHere ? 'lead' : 'human';
        this.emit({ goal: g.id, type: 'goal.stalled', data: { agents: fresh.map(r => ({ name: r.a.name, minutes: Math.round((now - r.a.progressAt) / 60_000), why: r.why })), everyone, told } });
        const head = everyone
          ? `Nobody on the team has done anything for ${mins}+ minutes: everyone is waiting.`
          : `${fresh.length > 1 ? 'These teammates seem' : 'This teammate seems'} stuck, waiting for something that can't come:`;
        if (leadHere) {
          g.stall = { at: now, humanTold: false };
          this.notice(
            lead!,
            `${head}\n${lines.join('\n')}\nAgents waiting on each other, or on someone who has finished, usually means the plan left a gap: who hands what to whom, or who decides. ` +
              `Look at what each one expects and unblock it: answer it, pass on what it needs, change the plan, or tell it to wrap up and call done. If they're waiting on purpose, ignore this.`,
          );
        } else {
          this.toHuman(g, fresh[0].a.name, 'stalled', `${head}\n${lines.join('\n')}\n\nThe lead has finished, so nobody else will sort this out. Your reply goes to ${fresh[0].a.name}.`);
        }
        continue;
      }
      // The lead was told, and the whole team, lead included, is still stuck: the human hears.
      if (g.stall && !g.stall.humanTold && everyone && leadHere && stuck.has(lead!) && now - g.stall.at >= ms) {
        g.stall.humanTold = true;
        const lines = [...stuck].map(a => this.stallLine(a, report.find(r => r.a === a)?.why ?? 'waiting', now));
        this.emit({ goal: g.id, type: 'goal.stalled', data: { agents: [...stuck].map(a => ({ name: a.name, minutes: Math.round((now - a.progressAt) / 60_000) })), everyone, told: 'human' } });
        this.toHuman(
          g, lead!.name, 'stalled',
          `The team has been stuck for ${Math.round((now - Math.min(...[...stuck].map(a => a.progressAt))) / 60_000)} minutes: everyone is waiting, and ${lead!.name} (the lead) was told ${Math.round((now - g.stall.at) / 60_000)} minutes ago but nothing has moved.\n${lines.join('\n')}\n\nYour reply goes to ${lead!.name}.`,
        );
      }
    }
  }

  /** One stuck agent, for a stall report. */
  private stallLine(a: AgentRec, why: string, now: number): string {
    const min = Math.max(1, Math.round((now - a.progressAt) / 60_000));
    const p = a.lastPartner;
    const last = p ? ` Last ${p.sent ? `to ${p.name}` : `from ${p.name}`}, ${ago(p.at)}: "${p.text.replace(/\s+/g, ' ').slice(0, 160)}".` : '';
    const status = a.status ? ` Its status: "${a.status.slice(0, 120)}".` : '';
    return `- ${a.name} (${a.role.name}): waiting ${min} min with nothing happening; ${why}.${last}${status}`;
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
    // A room's canvas and chat change with every word: the room shows them, and agents read them when they need to.
    if (g.room && (c.path === 'room/canvas.md' || c.path === 'room/chat.md')) return;
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
    // A room's images and demos are on its board, where the lead hears of them.
    if (g.room && /^room\/(media|demos)\//.test(c.path)) return;
    for (const a of g.agents.values()) {
      if (a.quick || FINISHED.includes(a.state)) continue;
      if (a.name === by && !clash) continue;
      a.fileNotes.set(c.path, { path: c.path, by, at, deleted: c.deleted, clash: clash && (a.name === clash.owner || a.name === clash.by) ? clash : undefined });
    }
  }

  /** Who wrote a shared file just now: the agent whose latest recent tool call named it. */
  private sharedWriter(g: GoalRec, path: string): string | undefined {
    // The room's canvas and chat are written by MetaHarness itself.
    if (g.room && (path === 'room/canvas.md' || path === 'room/chat.md')) return undefined;
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

  /* ---------------- rules and skills (design §18) ---------------- */

  /** The rules as an agent gets them: those pointing at a skill only when it carries the skill. */
  private agentRules(rec: AgentRec): Rule[] {
    return withSkills(this.config.rules.values(), this.skillsFor(rec));
  }

  /** The skills an agent carries: those its role names, and those no role names; on, and for its harness. */
  skillsFor(rec: AgentRec): Skill[] {
    return skillsFor(this.config.skills.values(), { harness: rec.harness, skills: rec.role.skills ?? [] }, claimedSkills(this.config.roles.values()));
  }

  /** Path and new-file rules for one tool call. */
  private toolRules(rec: AgentRec, tool: string, summary: string, info?: ToolInfo): void {
    if (FINISHED.includes(rec.state)) return;
    for (const n of onToolCall(this.agentRules(rec), ruleAgent(rec), rec.cwd, rec.rules, tool, summary, info)) this.ruleNote(rec, n);
  }

  /** Commit rules for a commit an agent made (not a merge). */
  private commitRules(g: GoalRec, gg: git.GoalGit, name: string, sha: string): void {
    const rec = g.agents.get(name);
    if (!rec || rec.quick) return;
    const notes = onCommit(this.agentRules(rec), ruleAgent(rec), rec.cwd, rec.rules, sha, git.changedFiles(gg, sha));
    for (const n of notes) this.ruleNote(rec, n);
  }

  /** The done rules an agent hasn't had this session: the reply that holds its first done back. */
  doneRules(rec: AgentRec): string | undefined {
    // Answering in a room isn't finishing work: nobody changes the project there.
    if (this.goals.get(rec.goal)?.room && !rec.quick) return undefined;
    const n = onDone(this.agentRules(rec), ruleAgent(rec), rec.cwd, rec.rules);
    if (!n) return undefined;
    this.emit({ goal: rec.goal, agent: rec.name, type: 'rule.fired', data: { rule: n.rule, when: n.when, paths: [] } });
    return n.text;
  }

  /** In a turn, a rule's note joins it; between turns it waits for whatever reaches the agent next, so it never wakes anyone. */
  private ruleNote(rec: AgentRec, n: RuleNote): void {
    const skill = this.config.rules.get(n.rule)?.skill;
    this.emit({ goal: rec.goal, agent: rec.name, type: 'rule.fired', data: { rule: n.rule, when: n.when, paths: n.paths.slice(0, 20), ...(skill ? { skill } : {}) } });
    if (rec.session?.busy() && !FINISHED.includes(rec.state)) this.notice(rec, n.text);
    else rec.ruleNotes.push(n.text);
  }

  /**
   * The repository files a tool call names, relative to the repository's top (a worktree's top
   * for an agent in one), for the Design view's activity and for pinned notes. `edit`: an edit
   * tool wrote them; otherwise it read, searched or ran something naming them.
   */
  private repoPaths(rec: AgentRec, tool: string, summary: string, info?: ToolInfo): { paths: string[]; edit?: true } {
    const g = this.goals.get(rec.goal);
    // MetaHarness's own tools (a message naming a file) aren't work on the code.
    const own = (TOOL_NAMES as readonly string[]).includes(tool.replace(/^(mcp__)?metaharness[_.:/-]+/, ''));
    if (!g?.git || own || FINISHED.includes(rec.state)) return { paths: [] };
    const { paths, edit } = toolPaths(tool, summary, rec.cwd, info);
    if (!paths.length) return { paths: [] };
    const root = [...g.agents.values()].map(a => a.worktree?.path).find(w => w && (rec.cwd === w || rec.cwd.startsWith(w + sep))) ?? g.git.repo;
    const rel = paths.map(p => relative(root, join(rec.cwd, p.path)).split(sep).join('/')).filter(p => p && !p.startsWith('..'));
    return { paths: rel.slice(0, 20), ...(edit ? { edit: true as const } : {}) };
  }

  /** Notes the human pinned on an area reach each agent once, the first time it works there. */
  private pinnedNotes(rec: AgentRec, paths: string[]): void {
    const g = this.goals.get(rec.goal);
    if (!g?.notes.size || !paths.length || rec.quick) return;
    for (const n of g.notes.values()) {
      if (n.delivered.has(rec.name)) continue;
      const hit = paths.find(p => n.path === '' || p === n.path || p.startsWith(n.path + '/'));
      if (!hit) continue;
      n.delivered.add(rec.name);
      this.emit({ goal: g.id, agent: rec.name, type: 'note.delivered', data: { id: n.id, path: hit } });
      const text = `[MetaHarness · note from the human on ${n.path || 'the whole project'}] ${n.text} (You're working on ${hit}.)`;
      if (rec.session?.busy() && !FINISHED.includes(rec.state)) this.notice(rec, text);
      else rec.ruleNotes.push(text);
    }
  }

  /** Pins a note on an area (a folder or file path, '' for everything) for the agents who work there. */
  pinNote(goalId: string, path: string, text: string): { id: string } {
    const g = this.goals.get(goalId);
    if (!g) throw new Error(`Goal ${goalId} isn't running here, so nobody would read the note.`);
    if (!text.trim()) throw new Error('The note is empty.');
    const id = randomUUID().slice(0, 8);
    const clean = path.trim().replace(/^\.?\/+|\/+$/g, '');
    g.notes.set(id, { id, path: clean, text: text.trim(), delivered: new Set() });
    this.emit({ goal: goalId, type: 'note.pinned', data: { id, path: clean, text: text.trim() } });
    return { id };
  }

  unpinNote(goalId: string, id: string): void {
    const g = this.goals.get(goalId);
    if (!g?.notes.delete(id)) throw new Error(`There's no note ${id} on goal ${goalId}.`);
    this.emit({ goal: goalId, type: 'note.removed', data: { id } });
  }

  /** Keeps a pinned note for future goals: a path rule in the repository's rules folder. */
  keepNote(goalId: string, id: string, scope = 'repo'): string {
    const g = this.goals.get(goalId);
    const n = g?.notes.get(id) ?? this.pastNotes(goalId).get(id);
    if (!n) throw new Error(`There's no note ${id} on goal ${goalId}.`);
    const slug = (n.path || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
    let name = `note-${slug}`;
    const existing = new Set(this.config.rules.keys());
    for (let i = 2; existing.has(name); i++) name = `note-${slug}-${i}`;
    const file = saveRule(scopesOf(this.configDirs), {
      name, scope, when: 'path', description: `the human's note on ${n.path || 'the whole project'}`, paths: n.path ? [n.path, `${n.path}/**`] : ['**'], body: n.text,
    });
    this.reloadConfig();
    this.emit({ goal: goalId, type: 'note.kept', data: { id, rule: name, file } });
    return file;
  }

  /** Notes pinned on a goal that isn't loaded, from its log. */
  private pastNotes(goalId: string): Map<string, { id: string; path: string; text: string }> {
    const out = new Map<string, { id: string; path: string; text: string }>();
    for (const e of this.store.since(goalId)) {
      if (e.type === 'note.pinned') out.set(String(e.data.id), { id: String(e.data.id), path: String(e.data.path), text: String(e.data.text) });
      else if (e.type === 'note.removed') out.delete(String(e.data.id));
    }
    return out;
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
  deliver(goalId: string, from: string, to: string, text: string, urgent = false, decision = false, viaRoom = false): string {
    const g = this.goals.get(goalId);
    if (!g) return `There's no goal ${goalId}.`;
    const target = to.trim().toLowerCase();
    // In a room, the lead's replies go to the chat, and lenses talk only with the lead (design §21).
    if (g.room && !viaRoom && from !== 'human' && g.agents.has(from) && !g.agents.get(from)?.quick) {
      const r = this.roomSend(g, from, to, text);
      if (r !== undefined) return r;
    }
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
      const sender = g.agents.get(from);
      if (sender) {
        const at = Date.now();
        sender.lastPartner = { name, at, text, sent: true };
        rec.lastPartner = { name: from, at, text, sent: false };
      }
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

  private toHuman(g: GoalRec, agent: string, kind: HumanInboxItem['kind'], text: string, onCreate?: (item: HumanInboxItem) => void, note?: string): HumanInboxItem {
    const item: HumanInboxItem = { id: randomUUID().slice(0, 8), goal: g.id, agent, kind, text, ts: new Date().toISOString(), ...(note ? { note } : {}) };
    this.humanInbox.push(item);
    // Before anyone hears of it, so an answer given at once (from an event listener) finds its way back.
    onCreate?.(item);
    this.emit({ goal: g.id, agent, type: 'inbox.item', data: { id: item.id, kind, text, ...(note ? { note } : {}) } });
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
    if (!rec.inbox.length || rec.held) return;
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
      this.carryOver(rec);
      return void this.startSession(rec, this.forAgent(rec, entries));
    }
    if (s.busy()) {
      // An interrupted turn is ending; its messages go in the next turn.
      if (rec.interrupting) return;
      const urgent = rec.inbox.some(e => e.urgent);
      const m = rec.adapter.manifest;
      if (!urgent && m.injectMidTurn) {
        const entries = rec.inbox.splice(0);
        this.markDelivered(rec, entries, 'inject');
        void s.send(this.forAgent(rec, entries), 'inject');
        return;
      }
      // Urgent, or no way into the running turn: pause it between steps (or wait for the turn's end).
      if (m.interrupt || m.resume) this.startPause(rec, urgent);
      return;
    }
    // A new turn on an account at its limit would only be refused.
    if (this.accountLimited(rec.harness, rec.model)) return void this.hitLimit(rec);
    // Its context is nearly full: the messages start a fresh session instead.
    if (rec.refresh) return this.refreshSession(rec);
    const via = rec.interrupting ? 'interrupt' : rec.state === 'done' ? 'resume' : 'new_turn';
    rec.interrupting = false;
    const entries = rec.inbox.splice(0);
    this.markDelivered(rec, entries, via);
    void s.send(this.forAgent(rec, entries) + (via === 'interrupt' ? PAUSED_NOTE : ''), 'new_turn');
  }

  /**
   * Messages are waiting and can't join the running turn. Urgent ones pause it at the next step
   * boundary; others first give the harness graceMs to pick them up itself (hooks, tool results),
   * then do the same. If the turn ends first, they simply start the next one.
   */
  private startPause(rec: AgentRec, urgent: boolean): void {
    if (rec.pause) {
      rec.pause.urgent ||= urgent;
      return;
    }
    rec.pause = { since: Date.now(), urgent, timer: setInterval(() => this.pauseCheck(rec), this.pausing.tickMs).unref() };
    this.pauseCheck(rec);
  }

  private endPause(rec: AgentRec): void {
    if (!rec.pause) return;
    clearInterval(rec.pause.timer);
    rec.pause = undefined;
  }

  /** Pauses the turn once no tool is running (or the wait is too long). */
  private pauseCheck(rec: AgentRec): void {
    const p = rec.pause;
    const s = rec.session;
    if (!p) return;
    if ((!rec.inbox.length && !rec.held) || !s?.busy() || rec.interrupting || FINISHED.includes(rec.state)) return this.endPause(rec);
    const now = Date.now();
    const waitFrom = p.urgent ? p.since : p.since + this.pausing.graceMs;
    if (now < waitFrom) return;
    // A harness that pulls messages gets a moment after each tool to do so before the pause.
    const settle = rec.adapter.manifest.pullsMessages && !p.urgent ? this.pausing.settleMs : 0;
    // A tool waiting for the human's approval hasn't started, so it's no reason to wait.
    const between = rec.toolsRunning - rec.pendingApprovals <= 0 && now - rec.lastToolEnd >= settle;
    if (!between && now - waitFrom < this.pausing.maxWaitMs) return;
    this.endPause(rec);
    if (rec.held) this.holdNow(rec, s);
    else if (!this.interrupt(rec, s)) return;
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.paused_between_steps', data: { urgent: p.urgent, waitedMs: now - p.since, cut: !between, ...(rec.held ? { held: true } : {}) } });
  }

  /** Stops a held agent's turn: natively, else by ending the process and keeping its session to resume. */
  private holdNow(rec: AgentRec, s: Session): void {
    const m = rec.adapter.manifest;
    if (m.interrupt && s.interrupt) return void s.interrupt().catch(() => {});
    if (m.resume && s.nativeId) {
      rec.gen++;
      rec.session = undefined;
      rec.resumeId = s.nativeId;
      this.carryOver(rec);
      void s.stop().catch(() => {});
      this.setState(rec, 'paused');
    }
    // Otherwise it pauses when the turn ends.
  }

  /**
   * The human pauses an agent: messages wait, and a running turn stops at the next step boundary
   * (never mid-command). Its session stays, to resume.
   */
  pauseAgent(goalId: string, name: string, by = 'human'): string {
    const rec = this.agent(goalId, name);
    if (!rec) return `There's no agent called ${name}.`;
    if (FINISHED.includes(rec.state)) return `${name} has already ${rec.state}.`;
    if (rec.held || rec.state === 'paused') return `${name} is already paused.`;
    const busy = !!rec.session?.busy();
    rec.held = { midTurn: busy };
    // A wait() it's in belongs to the turn being stopped.
    for (const w of rec.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve([]);
    }
    this.emit({ goal: goalId, agent: name, type: 'agent.paused', data: { by } });
    if (!busy) {
      this.setState(rec, 'paused');
      return `Paused ${name}.`;
    }
    this.endPause(rec);
    this.startPause(rec, true);
    return `Pausing ${name} once its current step finishes.`;
  }

  /** Lets a paused agent go on: waiting messages are delivered, and one stopped mid-turn is told to carry on. */
  unpauseAgent(goalId: string, name: string, by = 'human'): string {
    const rec = this.agent(goalId, name);
    if (!rec) return `There's no agent called ${name}.`;
    if (!rec.held && rec.state !== 'paused') return `${name} isn't paused.`;
    // After a restart the hold isn't known; telling it to carry on is harmless.
    const midTurn = rec.held?.midTurn ?? true;
    rec.held = undefined;
    this.endPause(rec);
    this.emit({ goal: goalId, agent: name, type: 'agent.resumed', data: { by } });
    if (rec.state === 'paused') this.setState(rec, rec.doneNote !== undefined ? 'done' : 'idle');
    if (midTurn && !rec.session?.busy()) this.notice(rec, 'The human paused you between steps and has now let you continue. Carry on where you left off.');
    else this.pump(rec);
    return `Resumed ${name}.`;
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
    this.carryOver(rec);
    void s.stop().catch(() => {});
    this.startSession(rec, this.forAgent(rec, entries) + PAUSED_NOTE, s.nativeId);
    return true;
  }

  /* ---------------- hooks (design §16: the middle rung of each ladder) ---------------- */

  /** Whether an agent works in the human's checkout, which teammates share, rather than its own worktree. */
  private sharedCheckout(rec: AgentRec): boolean {
    return !rec.worktree && !!this.goals.get(rec.goal)?.git;
  }

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
    if (!rec) {
      if (req.event !== 'before_tool') return {};
      const adapter = who && this.adapterFor(who.goal, who.agent);
      const t = adapter?.toolRequest?.(req.tool, req.args ?? {}) ?? { kind: 'other' as const, tool: req.tool, detail: '' };
      const d = who ? this.outsiderDecision(who.agent, t) : { allow: false, message: 'MetaHarness does not know this agent.' };
      return { allow: d.allow, reason: d.message };
    }
    if (req.event === 'before_model') {
      const messages = this.takeForTurn(rec, 'hook');
      return messages ? { messages } : {};
    }
    const t = rec.adapter.toolRequest?.(req.tool, req.args ?? {}) ?? { kind: 'other', tool: req.tool, detail: JSON.stringify(req.args ?? {}).slice(0, 8000) };
    const d = await this.decideTool(rec, t);
    return { allow: d.allow, reason: d.allow ? undefined : (d.message ?? 'The human denied this.') };
  }

  /** toolPolicy, with refusals logged. */
  private policyVerdict(rec: AgentRec, t: ToolRequest): { allow: boolean; reason?: string } | 'ask' {
    const v = this.toolPolicy(rec, t);
    if (v !== 'ask' && !v.allow) this.emit({ goal: rec.goal, agent: rec.name, type: 'approval.refused', data: { tool: t.tool, detail: t.detail.slice(0, 2000), why: v.reason ?? null } });
    return v;
  }

  /** What may run without asking: reads, MetaHarness's own tools, edits in the agent's own directories, and commands its role allows. */
  toolPolicy(rec: AgentRec, t: ToolRequest): { allow: boolean; reason?: string } | 'ask' {
    switch (t.kind) {
      case 'delegate':
        return { allow: false, reason: 'MetaHarness handles delegation: use its spawn tool (quick: true for a quick helper).' };
      case 'ask_user':
        return { allow: false, reason: 'Ask with the MetaHarness send tool, to: human. The answer arrives as a message.' };
      case 'message':
        // A harness subagent let through (Antigravity's image-generator) reports back to the session that started it.
        if (rec.session?.nativeId && t.detail.startsWith(`${rec.session.nativeId}:`)) return { allow: true };
        return { allow: false, reason: 'Message teammates with the MetaHarness send tool (to: their name, or human); it reaches them on any harness.' };
      case 'schedule':
        return { allow: false, reason: 'To wait, use the MetaHarness wait tool (timeout in seconds, up to 600); a message ends it early.' };
      case 'read':
        return { allow: true };
      case 'mcp':
        // Ours, and the servers the role names, are what the agent is there to use.
        return t.server === MCP_SERVER_NAME || (!!t.server && rec.role.mcp.includes(t.server)) ? { allow: true } : 'ask';
      case 'edit': {
        const g = this.goals.get(rec.goal)!;
        const inside = (dir: string) => !!t.path && (t.path === dir || t.path.startsWith(dir.endsWith('/') ? dir : dir + '/'));
        if (g.room && !rec.quick && !inside(g.sharedDir)) {
          return { allow: false, reason: `This is a brainstorm room: nobody changes the project's files here; your own files (images, demos, reports) go in the shared folder, ${g.sharedDir}. Say what you'd change in your answer: building it is for a goal, once the human decides.` };
        }
        if (rec.role.permissionMode === 'default' || (rec.quick && !inside(g.sharedDir))) return 'ask';
        return inside(rec.cwd) || inside(g.sharedDir) ? { allow: true } : 'ask';
      }
      case 'shell': {
        const refused = refusedGitCommand(t.detail, { sharedCheckout: this.sharedCheckout(rec) });
        if (refused) return { allow: false, reason: refused };
        return roleAllows(rec.role, t.detail) ? { allow: true } : 'ask';
      }
      case 'image':
        // In a room, making images is what makers are there for, and the human is watching.
        return this.goals.get(rec.goal)?.room ? { allow: true } : 'ask';
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

  /** Takes in what a harness says about an account. Updates can be partial (a refused turn may say only "limited"), so what's known is kept. */
  private updateAccount(id: string, info: RateLimitInfo): { a: AccountRec; changed: boolean; was: AccountRec['status'] } {
    const prev = this.accounts.get(id);
    const a: AccountRec = prev ?? { id, status: 'ok', warned: new Set() };
    const was = a.status;
    const statusChanged = a.status !== info.status;
    const changed =
      statusChanged ||
      (info.note !== undefined && info.note !== a.note) ||
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
    if (info.windows) a.windows = info.windows;
    else if (a.windows && info.window && info.usedPct !== undefined) {
      // A turn reports only its tightest window: refresh that one in what the last check found.
      const w: LimitWindow = { name: info.window, usedPct: info.usedPct, ...(info.resetsAt ? { resetsAt: info.resetsAt } : {}) };
      a.windows = a.windows.some(x => x.name === w.name) ? a.windows.map(x => (x.name === w.name ? w : x)) : [...a.windows, w];
    }
    // A note lasts until the status changes or a new one comes.
    if (info.note !== undefined || statusChanged) a.note = info.note;
    a.checkedAt = Date.now();
    this.accounts.set(a.id, a);
    return { a, changed, was };
  }

  private onRateLimit(rec: AgentRec, info: RateLimitInfo): void {
    const { a, changed } = this.updateAccount(this.accountOf(rec.harness, rec.model), info);
    if (changed) {
      this.emit({
        goal: rec.goal, agent: rec.name, type: 'account.limit',
        data: { account: a.id, status: a.status, usedPct: a.usedPct ?? null, resetsAt: a.resetsAt ? new Date(a.resetsAt).toISOString() : null, window: a.window ?? null, note: a.note ?? null },
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

  /**
   * Asks harnesses where their accounts stand, between turns: every one that can say,
   * or just `harness`. At most once a minute per harness unless forced. Agents waiting out a
   * limit that has lifted carry on straight away.
   */
  async checkLimits(harness?: string, force = false): Promise<void> {
    const ids = Object.keys(this.adapters).filter(id => this.adapters[id].readLimits && (!harness || id === harness));
    await Promise.all(
      ids.map(id => {
        const last = this.limitChecks.get(id);
        if (last?.running) return last.running;
        if (!force && last && Date.now() - last.at < 60_000) return;
        const running = Promise.race([
          this.adapters[id].readLimits!(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer in 90 seconds')), 90_000).unref()),
        ]).then(
          found => {
            for (const [account, info] of Object.entries(found)) {
              const { a, was } = this.updateAccount(account, info);
              if (was === 'limited' && a.status !== 'limited') {
                for (const r of this.agentsOn(account)) if (r.state === 'limited') (clearTimeout(r.limitTimer), this.limitOver(r));
              }
            }
            this.limitChecks.set(id, { at: Date.now() });
          },
          (e: Error) => void this.limitChecks.set(id, { at: Date.now(), error: e.message }),
        );
        this.limitChecks.set(id, { at: last?.at ?? 0, error: last?.error, running });
        return running;
      }),
    );
  }

  /**
   * Checks limits now, then every `limitCheckMinutes` (the setting is read each time, so a change
   * applies). An account a turn reported within that time is fresh already: Claude's check costs a turn.
   */
  startLimitChecks(): void {
    if (this.limitTimer) return;
    const tick = () => {
      const every = this.config.settings.limitCheckMinutes * 60_000;
      if (every <= 0) return;
      const stale = (at = 0) => Date.now() - at >= every;
      const due = Object.keys(this.adapters).filter(id => this.adapters[id].readLimits && stale(this.limitChecks.get(id)?.at) && stale(this.accounts.get(id)?.checkedAt));
      for (const id of due) void this.checkLimits(id);
    };
    tick();
    this.limitTimer = setInterval(tick, 60_000).unref();
  }

  /** The accounts and the last limit check of each harness, as clients show them. */
  accountsView() {
    return {
      accounts: [...this.accounts.values()].map(a => ({
        id: a.id, status: a.status, usedPct: a.usedPct ?? null, resetsAt: a.resetsAt ?? null, window: a.window ?? null, note: a.note ?? null,
        windows: a.windows ?? [], checkedAt: a.checkedAt ?? null,
      })),
      limitChecks: Object.keys(this.adapters)
        .filter(id => this.adapters[id].readLimits)
        .map(id => ({ harness: id, at: this.limitChecks.get(id)?.at || null, error: this.limitChecks.get(id)?.error ?? null, checking: !!this.limitChecks.get(id)?.running })),
    };
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
    const from = { harness: rec.harness, model: rec.model, ...(rec.effort ? { effort: rec.effort } : {}) };
    const brief = rec.pendingBrief ?? this.handoff(rec, from, reason);
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.moved', data: { from, to, reason } });
    this.replaceSession(rec, to, brief);
    const g = this.goals.get(rec.goal)!;
    const line = `${rec.name} moved from ${from.harness} · ${from.model} to ${to.harness} · ${to.model}, because ${reason}. It continues from a handoff.`;
    for (const who of new Set([rec.parent, g.lead])) {
      const r = g.agents.get(who);
      if (r && r !== rec && !FINISHED.includes(r.state)) this.notice(r, line);
    }
  }

  /**
   * Ends an agent's session and starts a new one on `to` with `brief`. Its name, credential,
   * worktree and waiting messages stay; what the old session spent is kept apart.
   */
  private replaceSession(rec: AgentRec, to: Route, brief: string): void {
    const old = rec.session;
    rec.gen++;
    rec.session = undefined;
    rec.resumeId = undefined;
    rec.interrupting = false;
    rec.toolsRunning = 0;
    this.endPause(rec);
    this.clearRefresh(rec);
    this.carryOver(rec);
    clearTimeout(rec.limitTimer);
    rec.limitedUntil = undefined;
    rec.contextPct = rec.contextTokens = undefined;
    // Its wait() calls belong to the old session; the new one makes its own.
    for (const w of rec.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve([]);
    }
    void old?.stop().catch(() => {});
    rec.harness = to.harness;
    rec.model = to.model;
    rec.effort = to.effort;
    rec.adapter = this.adapters[to.harness];
    this.setState(rec, 'starting');
    this.startSession(rec, brief);
  }

  /**
   * An agent whose context window is nearly full continues in a fresh session from a handoff
   * (design §16), before its harness compacts it or runs out of room. During a turn it's first
   * asked to write notes, then the new session starts at the next step boundary (refreshCheck).
   * Between turns nothing happens until a message comes for it: that message starts the fresh
   * session, so no turn is spent on the switch.
   */
  private checkContext(rec: AgentRec, startPct?: number): void {
    const at = this.config.settings.contextHandoffPct;
    const pct = rec.contextPct;
    if (rec.refresh) {
      // The harness compacted it first.
      if (pct !== undefined && pct < at) this.clearRefresh(rec);
      return;
    }
    if (!at || pct === undefined || pct < at || rec.quick || FINISHED.includes(rec.state)) return;
    // A session that started nearly as full (a long handoff, a small window) wouldn't gain from another.
    if (startPct !== undefined && pct - startPct < MIN_CONTEXT_GAIN) return;
    const busy = !!rec.session?.busy();
    rec.refresh = { since: Date.now(), pct };
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.context_full', data: { pct, contextTokens: rec.contextTokens ?? null, notesAsked: busy } });
    if (!busy) return;
    this.notice(
      rec,
      `Your context window is ${pct}% full, so in a few minutes you'll continue in a fresh session, from a handoff. ` +
        `Write where you are to shared/notes/${rec.name}.md now: what's done, what's next, decisions and why, and anything uncommitted. ` +
        `Then carry on with your current step; the switch waits until it's finished.`,
    );
    rec.refresh.timer = setInterval(() => this.refreshCheck(rec), this.pausing.tickMs).unref();
  }

  /** Starts the fresh session once the notes are written (or their time is up) and no step is running. */
  private refreshCheck(rec: AgentRec): void {
    const r = rec.refresh;
    if (!r) return;
    const s = rec.session;
    if (FINISHED.includes(rec.state)) return this.clearRefresh(rec);
    if (!s?.busy()) {
      // The turn ended: the next message starts the fresh session (pump).
      clearInterval(r.timer);
      r.timer = undefined;
      return;
    }
    if (rec.held || rec.state === 'paused' || rec.state === 'limited' || rec.interrupting) return;
    const notes = join(this.goals.get(rec.goal)!.sharedDir, 'notes', `${rec.name}.md`);
    let wrote = false;
    try {
      // File times come from a coarser clock than Date.now(), so a second's slack.
      wrote = statSync(notes).mtimeMs >= r.since - 1000;
    } catch {
      // No notes yet.
    }
    if (!wrote && Date.now() - r.since < this.contextNotesMs) return;
    // Never mid-command, and never with an approval in the Inbox that would then be answered to nobody.
    const between = rec.pendingApprovals === 0 && (rec.state === 'waiting' || rec.toolsRunning <= 0);
    if (between) this.refreshSession(rec);
  }

  private clearRefresh(rec: AgentRec): void {
    if (rec.refresh?.timer) clearInterval(rec.refresh.timer);
    rec.refresh = undefined;
  }

  /** The fresh session: same harness and model, a handoff for a brief, waiting messages added to it. */
  private refreshSession(rec: AgentRec): void {
    const pct = rec.refresh?.pct ?? rec.contextPct;
    const entries = rec.inbox.splice(0);
    this.markDelivered(rec, entries, 'handoff');
    const route = { harness: rec.harness, model: rec.model };
    const brief = this.handoff(rec, route, `its context window was ${pct}% full`, { fresh: true, news: this.forAgent(rec, entries) });
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.context_handoff', data: { pct: pct ?? null, contextTokens: rec.contextTokens ?? null, midTurn: !!rec.session?.busy() } });
    this.replaceSession(rec, route, brief);
  }

  /**
   * The brief for an agent's new session after a move, or when its context was full. Built from
   * what the daemon saw, so it doesn't depend on the old session being able to write anything.
   */
  handoff(rec: AgentRec, from: Route, reason: string, o: { fresh?: boolean; news?: string } = {}): string {
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
      o.fresh ? 20 : 12,
    );
    const tools = last(events.filter(e => e.type === 'agent.tool_call').map(e => `- ${e.data.tool} ${cut(e.data.summary, 120)}`), 12);
    const spawner = rec.parent === 'human' ? 'the human' : rec.parent;
    const parts = [
      o.fresh
        ? `[MetaHarness] You're continuing as ${rec.name}, the ${rec.role.name}, in a fresh session: your last one stopped because ${reason}. ` +
          `Your name and working directory are the same, and teammates reach you as before. What's below is where it got to; read it and the state of the work, then carry on.`
        : `[MetaHarness] You're taking over as ${rec.name}, the ${rec.role.name}. Until now ${from.harness} · ${from.model} did this work, and it stopped because ${reason}. ` +
          `Your name and working directory are the same, and teammates reach you as before. Read what's below and the state of the work, then carry on.`,
      ...(rec.brief.trim() !== g.request.trim() ? [`## The goal (the human's request)\n\n${g.request}`] : []),
      `## The original brief (from ${spawner})\n\n${rec.brief}`,
    ];
    const did: string[] = [];
    if (statuses.length) did.push(`Status lines, oldest first:\n${statuses.map(t => `- ${t}`).join('\n')}`);
    if (messages.length) did.push(`Messages:\n${messages.join('\n')}`);
    if (tools.length) did.push(`Its last tool calls:\n${tools.join('\n')}`);
    if (rec.lastText) did.push(`The last thing it said: ${cut(rec.lastText, 800)}`);
    if (did.length) parts.push(`## What happened so far\n\n${did.join('\n\n')}`);
    const team = this.teamLines(g, rec);
    if (team.length) parts.push(`## Your team now\n\n${team.join('\n')}`);
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
    if (o.news) parts.push(`## New since then\n\n${o.news}`);
    return this.firstMessage(rec, parts.join('\n\n'));
  }

  /**
   * Waiting messages for an adapter to add to the running turn itself (a hook, a tool result).
   * Shared-folder notes ride along too: this costs nothing, unlike a new turn.
   */
  private takeForTurn(rec: AgentRec, via: string): string | undefined {
    if ((!rec.inbox.length && !rec.fileNotes.size && !rec.ruleNotes.length) || rec.interrupting || rec.state === 'paused' || rec.held) return undefined;
    const entries = rec.inbox.splice(0);
    this.markDelivered(rec, entries, via);
    if (!rec.inbox.length) this.endPause(rec);
    return this.forAgent(rec, entries);
  }

  /** Messages for an agent, with the notes it hasn't had yet. */
  private forAgent(rec: AgentRec, entries: InboxEntry[]): string {
    return [formatForAgent(entries), this.takeNotes(rec)].filter(Boolean).join('\n');
  }

  /** What rides along with the next thing that reaches an agent: rule notes, then shared-folder changes. Empties both. */
  takeNotes(rec: AgentRec): string {
    return [...rec.ruleNotes.splice(0), this.takeFileNotes(rec)].filter(Boolean).join('\n\n');
  }

  /** A message from MetaHarness itself. */
  private notice(rec: AgentRec, text: string): void {
    this.enqueue(rec, { id: randomUUID(), kind: 'notice', from: 'MetaHarness', text, urgent: false, ts: new Date().toISOString() });
  }

  private markDelivered(rec: AgentRec, entries: InboxEntry[], via: string): void {
    // Something to act on: whatever it was waiting for may have come.
    if (entries.some(e => e.kind !== 'notice')) this.touch(rec);
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
    // A room's lead never waits on a helper: it sends a maker and ends its turn.
    const g = this.goals.get(caller.goal);
    if (g?.room && caller.isLead) return { text: this.roomSpawn(caller, role, brief) ?? '' };
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
    this.endPause(rec);
    this.clearRefresh(rec);
    this.setState(rec, 'ended');
    this.emit({ goal: goalId, agent: name, type: 'agent.ended', data: { reason: `stopped by ${by}` } });
    if (rec.doneNote === undefined) this.finish(rec, `${name} was stopped by ${by}.`, 'ended');
    return `Stopped ${name}.`;
  }

  /** Pauses (or resumes) every agent still working on a goal. */
  pauseGoal(goalId: string, resume: boolean, by = 'human'): string {
    const g = this.goals.get(goalId);
    if (!g) return `There's no goal ${goalId} running here.`;
    const names = [...g.agents.values()].filter(a => !FINISHED.includes(a.state)).map(a => a.name);
    const lines = names.map(n => (resume ? this.unpauseAgent(goalId, n, by) : this.pauseAgent(goalId, n, by)));
    this.emit({ goal: goalId, type: resume ? 'goal.resumed' : 'goal.paused', data: { by } });
    return lines.length ? lines.join(' ') : 'Nobody is working on it.';
  }

  /** Ends a goal: every agent still on it stops, then its worktrees and merged branches go as usual. */
  endGoal(goalId: string, by = 'human'): string {
    const g = this.goals.get(goalId);
    if (!g) return `There's no goal ${goalId} running here.`;
    if (g.status === 'ended') return `Goal ${goalId} has already ended.`;
    const live = [...g.agents.values()].filter(a => !FINISHED.includes(a.state));
    // Worth naming: the ones that hadn't finished.
    const stopped = live.filter(a => a.doneNote === undefined).map(a => a.name);
    for (const a of live) {
      // Its spawner is stopping too; nobody needs the note.
      a.doneNote ??= `${a.name} was stopped when the goal ended.`;
      this.stopAgent(goalId, a.name, by);
    }
    g.status = 'ended';
    void g.gatekeeper?.stop();
    this.emit({ goal: goalId, type: 'goal.ended', data: { reason: `ended by ${by}`, stopped } });
    const res = g.git ? this.runCleanup(g, false) : undefined;
    const cleaned = res ? describeClean(res, `mh clean ${g.id} --force removes them.`) : '';
    return [`Ended goal ${goalId}${stopped.length ? `; stopped ${stopped.join(', ')}` : ''}.`, cleaned].filter(Boolean).join(' ');
  }

  /** The command to open an agent's session in its own harness, run from its folder. */
  openNative(goalId: string, name: string): { command?: string; note: string } {
    const rec = this.agent(goalId, name);
    if (!rec) return { note: `There's no agent called ${name}.` };
    const id = rec.session?.nativeId ?? rec.resumeId;
    const cmd = id && rec.adapter?.nativeCommand?.(id);
    if (!cmd) return { note: id ? `MetaHarness doesn't know how to open a ${rec.harness} session by hand.` : `${name} has no session yet.` };
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const busy = !rec.held && rec.state !== 'paused' && !FINISHED.includes(rec.state) && rec.state !== 'done' && rec.state !== 'idle';
    return {
      command: `cd ${quote(rec.cwd)} && ${cmd}`,
      note: busy ? `${name} is still running: pause it first (agent.pause), or two programs will drive one session at once.` : `Opens ${name}'s session in ${rec.harness}.`,
    };
  }

  /* ---------------- brainstorm rooms (design §21) ---------------- */

  /** A room's id: the one given, else the latest room still open. */
  private roomId(id?: string): string {
    const rid = id ?? [...this.goals.values()].filter(g => g.room && g.status === 'running').at(-1)?.id;
    const g = rid ? this.goals.get(rid) : undefined;
    if (!g?.room) throw new Error(rid ? `There's no room ${rid} running here.` : 'There are no rooms open.');
    return g.id;
  }

  roomPaths(g: GoalRec): RoomPaths {
    const room = join(g.sharedDir, 'room');
    return { canvas: join(room, 'canvas.md'), chat: join(room, 'chat.md'), reports: join(g.sharedDir, 'reports'), media: join(room, 'media'), demos: join(room, 'demos') };
  }

  /**
   * Opens a room on a topic, with the makers its lead may send and the human may ask (the
   * built-in four when none are given). Everyone reads the human's checkout; nobody changes it.
   * `from` carries a past room's board (or, with `cards`, the cards branched off it), or a goal's
   * outcome, over.
   */
  startRoom(o: { topic: string; lenses?: Lens[]; from?: string; cards?: string[] }): string {
    const lenses = (o.lenses ?? DEFAULT_MAKERS.filter(r => this.teamRoles().some(x => x.name === r)).map(role => ({ role }))).map(p => this.checkLens(p));
    const leadRole = this.config.roles.get(this.config.settings.roomLead);
    if (!leadRole) throw new Error(`There's no role called ${this.config.settings.roomLead} to lead the room (Settings → Room lead).`);
    const id = randomUUID().slice(0, 8);
    const sharedDir = join(this.home, 'goals', id, 'shared');
    let resolveLeadDone!: (note: string) => void;
    const leadDone = new Promise<string>(r => (resolveLeadDone = r));
    const room: RoomState = { topic: o.topic, lenses: [], canvas: { cards: [], links: [], frames: [], seq: 0 } };
    const g: GoalRec = {
      id, kind: 'room', room, request: o.topic, dir: this.repo, lead: '', createdAt: new Date().toISOString(), sharedDir,
      refs: new Map(), seenOn: new Map(), chained: [], conflicts: new Map(), notes: new Map(), shared: new SharedFolder(sharedDir), sharedTouches: [],
      status: 'running', agents: new Map(), counters: new Map(), gatekeeperCost: new Map(), leadDone, resolveLeadDone,
    };
    const paths = this.roomPaths(g);
    for (const dir of [paths.media, paths.demos]) mkdirSync(dir, { recursive: true });
    const gs = git.setupGoal(g.dir, id);
    if ('reason' in gs) g.gitNote = gs.reason;
    else {
      g.git = gs;
      g.refs.set(gs.branch, gs.base);
      this.watchAuthors(g, gs);
    }
    this.goals.set(id, g);
    for (const p of lenses) room.lenses.push({ ...p, name: lensName(p, room.lenses.map(c => c.name!)) });
    this.emit({
      goal: id, type: 'goal.started',
      data: {
        kind: 'room', request: o.topic, lead: leadRole.name, sharedDir, dir: g.dir, branch: g.git?.branch ?? null, base: g.git?.base ?? null,
        from: o.from ?? null, ...(o.cards?.length ? { cards: o.cards } : {}), notice: this.goalNotice(g) ?? null,
      },
    });
    this.emitLenses(g);
    writeFileSync(paths.chat, `# ${o.topic.split('\n')[0]}\n\nThe room's chat, as it goes.\n`);
    const seed = o.from ? this.roomSeed(o.from, o.cards) : undefined;
    if (seed) {
      seedCanvas(room.canvas, seed, seed.by);
      // Images and demos come along, at the same place in this room's folder.
      if (seed.dir) {
        for (const c of room.canvas.cards) {
          const src = c.file && join(seed.dir, c.file);
          if (!src || !existsSync(src)) continue;
          mkdirSync(join(sharedDir, c.file!, '..'), { recursive: true });
          copyFileSync(src, join(sharedDir, c.file!));
        }
      }
    }
    this.canvasChanged(g);
    if (o.from && o.cards?.length) this.markBranch(o.from, o.cards, id);
    const r = this.spawnAgent(id, { role: leadRole.name, roleDef: leadRole, brief: this.roomOpening(g, seed?.cards.length ?? 0), parent: 'human', isLead: true, name: 'lead' });
    if (!r.ok) {
      g.status = 'ended';
      this.emit({ goal: id, type: 'goal.ended', data: { reason: r.error } });
      throw new Error(r.error);
    }
    g.lead = r.name;
    this.startPolling();
    if (g.git) this.recordDesign(g, g.git, g.git.base, { kind: 'start' });
    return id;
  }

  /** What the lead hears first: the topic, and what to do with it. */
  private roomOpening(g: GoalRec, seeded: number): string {
    return [
      g.request,
      '',
      seeded
        ? `[Room] The board starts with ${seeded} card${seeded > 1 ? 's' : ''} carried over: read it with \`canvas\` first.`
        : '[Room] The board is empty.',
      'Open the room: put the question (and anything the topic already says: ideas, constraints, references) on the board, send a maker if something is worth making or finding right away, and greet the human with a line on how you read the topic and the one question that would narrow it down most. Keep it short.',
    ].join('\n');
  }

  /** A maker as declared: a role that exists, or a model on a harness that runs here; a model-only maker needs a responsibility. */
  private checkLens(p: Lens): Lens {
    const lens: Lens = { ...p };
    for (const k of ['role', 'name', 'on', 'responsibility', 'stance'] as const) if (typeof lens[k] !== 'string' || !lens[k]!.trim()) delete lens[k];
    if (lens.off !== true) delete lens.off;
    if (lens.role) {
      const res = resolveName(lens.role, this.teamRoles().map(r => r.name));
      if (!res.match) throw new Error(`There's no role called "${lens.role}". Roles: ${this.teamRoles().map(r => r.name).join(', ')}.`);
      lens.role = res.match;
    } else {
      if (!lens.on) throw new Error('A maker without a role needs a model (harness/model).');
      if (!lens.responsibility) throw new Error(`The ${lens.on} maker needs a responsibility: it's all it's told about its part.`);
    }
    if (lens.on) {
      const harness = lens.role ? this.routeRole(this.config.roles.get(lens.role)!, lens.on).harness : modelRole(lens).harness;
      if (!this.adapters[this.harnessOverride ?? harness]) throw new Error(`MetaHarness can't run ${harness} here.`);
    }
    return lens;
  }

  /**
   * What a new room's board starts with: a past room's cards (the ones picked and those linked
   * to them, or every card not dropped) and the folder their files are in, or a goal's outcome and its reports.
   */
  private roomSeed(from: string, cards?: string[]): { by: string; cards: Card[]; links: CardLink[]; dir?: string } | undefined {
    const live = this.goals.get(from);
    const events = live?.room ? [] : this.store.since(from);
    const start = live?.room ? undefined : events.find(e => e.type === 'goal.started');
    if (live?.room || start?.data.kind === 'room') {
      const last = live?.room?.canvas ?? (events.filter(e => e.type === 'room.canvas').at(-1)?.data as unknown as Canvas | undefined);
      const canvas: Canvas = { cards: last?.cards ?? [], links: last?.links ?? [], frames: [], seq: 0 };
      const picked = cards?.length ? branchCards(canvas, cards) : { cards: canvas.cards.filter(c => c.status !== 'dropped'), links: canvas.links };
      return { by: `room ${from}`, ...picked, dir: live?.sharedDir ?? String(start?.data.sharedDir ?? '') };
    }
    if (!start) return undefined;
    const r = replayGoal(events);
    if (!r) return undefined;
    const note = r.agents.get(r.lead)?.doneNote?.replace(/\s+/g, ' ').trim();
    const title = r.request.split('\n')[0].slice(0, 120);
    const refs = [...r.shared.keys()].filter(p => /(^|\/)(report|design)\.md$/i.test(p)).map(p => join(r.sharedDir, p));
    const card: Card = {
      id: 'g1', kind: 'finding', by: `goal ${from}`, title: note ? `Goal "${title}" finished` : `Goal "${title}" ended without an outcome`,
      ...(note || r.branch ? { text: [note?.slice(0, 1200), r.branch && r.base ? `Its work is on ${r.branch}, from ${r.base.slice(0, 7)}.` : ''].filter(Boolean).join('\n\n') } : {}),
      ...(refs.length ? { refs } : {}),
    };
    return { by: `goal ${from}`, cards: [card], links: [] };
  }

  /** Cards branched off into a new room show it, while their room is open. */
  private markBranch(from: string, cards: string[], to: string): void {
    const g = this.goals.get(from);
    if (!g?.room || g.status === 'ended') return;
    for (const c of g.room.canvas.cards) if (cards.includes(c.id)) c.branches = [...(c.branches ?? []), to];
    this.canvasChanged(g);
    this.tellLead(g, `[Room] The human branched ${cards.join(', ')} into a room of its own (${to}): leave that topic to it.`);
  }

  /** For a goal started from a room: where the lead finds what the room settled. */
  private roomBackground(roomId: string): string {
    const start = this.store.since(roomId).find(e => e.type === 'goal.started');
    if (!start) return '';
    const shared = String(start.data.sharedDir);
    const design = ['room/design.md', 'design.md'].map(p => join(shared, p)).find(p => existsSync(p));
    return [
      `[MetaHarness] This goal comes out of a brainstorm room (${roomId}) on: ${String(start.data.request).split('\n')[0]}`,
      `- Its board: ${join(shared, 'room', 'canvas.md')}. The concept card holds the idea pillar by pillar; decision cards are what the human settled, some with the exact values they kept from a demo; the demos (${join(shared, 'room', 'demos')}) and images (${join(shared, 'room', 'media')}) are references to match.`,
      ...(design ? [`- The design written there: ${design}`] : []),
      `- The whole chat: ${join(shared, 'room', 'chat.md')}`,
      'Read the board and the design before you plan.',
    ].join('\n');
  }

  /** The makers, with each one's responsibility as it will be told and what it makes. */
  private emitLenses(g: GoalRec): void {
    this.emit({ goal: g.id, type: 'room.lenses', data: { lenses: g.room!.lenses.map(p => ({ ...p, responsibility: responsibilityOf(p), makes: makesOf(p), ...this.makerCan(p) })) } });
  }

  /** The makers as the lead reads them. */
  private lensRoster(g: GoalRec): string[] {
    return lensLines(g.room!.lenses, n => g.agents.has(n), p => this.makerCan(p));
  }

  /** What a maker's harness can do: the first route of its role that runs here. */
  private makerCan(p: Lens): MakerCan {
    const role = this.lensRole(p);
    const route = role && this.routes(role).find(r => this.adapters[this.harnessOverride ?? r.harness]);
    const m = route && this.adapters[this.harnessOverride ?? route.harness]?.manifest;
    return { ...(m?.web ? { web: true } : {}), ...(m?.images ? { images: true } : {}) };
  }

  /** What an agent in a room makes: its maker's output, else its role's usual one. */
  private makesOfAgent(g: GoalRec, rec: AgentRec): Output {
    return makesOf(g.room!.lenses.find(l => l.name === rec.name) ?? { role: rec.role.name, responsibility: rec.responsibility });
  }

  /** A note for the lead: it rides along with whatever reaches it next. */
  private tellLead(g: GoalRec, note: string): void {
    const lead = g.agents.get(g.lead);
    if (lead && !FINISHED.includes(lead.state)) lead.ruleNotes.push(note);
  }

  /** The human adds a maker. The lead hears of it. */
  roomAddLens(goalId: string, p: Lens): string {
    const g = this.goals.get(goalId)!;
    const st = g.room!;
    const lens = this.checkLens(p);
    const name = lensName(lens, [...st.lenses.map(c => c.name!), ...g.agents.keys()]);
    st.lenses.push({ ...lens, name });
    this.emitLenses(g);
    const r = responsibilityOf(lens);
    this.tellLead(g, `[Room] The human added a maker you can send: ${name} (${lens.role ?? lens.on}, makes ${makesOf(lens)} cards${r ? `: ${r}` : ''}).`);
    return `${name} is a maker the lead can send.`;
  }

  /** The human puts a maker away (nobody can send it) or brings it back. One at work finishes first. */
  roomLensOff(goalId: string, name: string, off: boolean): string {
    const g = this.goals.get(goalId)!;
    const lens = g.room!.lenses.find(c => c.name === name);
    if (!lens) throw new Error(`There's no maker called ${name}.`);
    if (!!lens.off === off) return off ? `${name} is already put away.` : `${name} is already available.`;
    if (off) lens.off = true;
    else delete lens.off;
    this.emitLenses(g);
    this.tellLead(g, off ? `[Room] The human put ${name} away: don't send it.` : `[Room] ${name} is available again.`);
    return off ? `Put ${name} away.` : `${name} is available again.`;
  }

  /** A maker's role: its own (on its own model, if it has one), or one made from its model. */
  private lensRole(lens: Lens): Role | undefined {
    if (!lens.role) return modelRole(lens);
    const role = this.config.roles.get(lens.role);
    return role && lens.on ? this.routeRole(role, lens.on) : role;
  }

  /** A role on the harness/model a maker asks for, with no backups of its own. */
  private routeRole(role: Role, on: string): Role {
    const { model, effort } = splitEffort(on);
    const slash = model.indexOf('/');
    return { ...role, ...(slash > 0 ? { harness: model.slice(0, slash), model: model.slice(slash + 1) } : { model }), ...(effort ? { effort } : {}), fallback: [] };
  }

  /** A maker by its name, or the first available one in a role. */
  private findLens(g: GoalRec, name: string): Lens | undefined {
    const t = name.trim().replace(/^@/, '').toLowerCase();
    const lenses = g.room!.lenses;
    return lenses.find(c => c.name!.toLowerCase() === t) ?? lenses.find(c => c.role?.toLowerCase() === t && !c.off) ?? lenses.find(c => c.role?.toLowerCase() === t);
  }

  /** Posts to the chat (and its file). Returns the message's id. */
  private say(g: GoalRec, d: { from: string; to: string[]; text: string; kind: string; [k: string]: unknown }): string {
    const id = randomUUID().slice(0, 8);
    const agent = d.from === 'human' || d.from === 'MetaHarness' ? undefined : d.from;
    this.emit({ goal: g.id, ...(agent ? { agent } : {}), type: 'room.message', data: { id, ...d } });
    if (d.kind !== 'note') {
      const head = `${d.from === 'human' ? 'You' : d.from} → ${d.to.map(t => (t === 'human' ? 'you' : t)).join(', ')}${d.kind === 'dispatch' ? ' (sent)' : ''}`;
      try {
        appendFileSync(this.roomPaths(g).chat, `\n### ${head}\n\n${d.text}\n`);
      } catch {
        // The log has it.
      }
    }
    return id;
  }

  /** A line from MetaHarness in the chat. */
  private roomNote(g: GoalRec, text: string): void {
    this.say(g, { from: 'MetaHarness', to: ['human'], text, kind: 'note' });
  }

  /** The human says something to the lead, about a card or not. */
  roomPost(goalId: string, o: { text: string; card?: string }): string {
    const g = this.openRoom(goalId);
    const lead = g.agents.get(g.lead);
    if (!lead || FINISHED.includes(lead.state)) throw new Error(`The lead has ${lead?.state ?? 'gone'}: respawn it from its panel to carry on.`);
    const card = o.card ? g.room!.canvas.cards.find(c => c.id === o.card) : undefined;
    this.say(g, { from: 'human', to: [g.lead], text: o.text, kind: 'ask', ...(card ? { card: card.id } : {}) });
    const text = card ? `[About ${card.id}, ${card.kind}: ${card.title}]\n${o.text}` : o.text;
    this.deliver(g.id, 'human', g.lead, text, false, false, true);
    return 'Sent.';
  }

  /** A room that's still open. */
  private openRoom(goalId: string): GoalRec {
    const g = this.goals.get(goalId)!;
    if (g.status === 'ended') throw new Error('This room has ended. Start a new room from it to carry on.');
    return g;
  }

  /** The lead sends a maker (its `spawn` in a room). Undefined: not in a room. */
  roomSpawn(rec: AgentRec, name: string, brief: string): string | undefined {
    const g = this.goals.get(rec.goal);
    if (!g?.room || rec.quick) return undefined;
    if (!rec.isLead) return `Only ${g.lead} sends makers. Say in your answer what else should be made or looked into, and by whom.`;
    const lens = this.findLens(g, name);
    if (!lens) {
      const open = g.room.lenses.filter(c => !c.off).map(c => c.name);
      return `There's no maker called "${name}". ${open.length ? `Makers you can send: ${open.join(', ')}.` : 'There are no makers to send: tell the human which kind you need, and they can add one.'}`;
    }
    if (lens.off) return `${lens.name} is put away by the human, so it can't be sent. Makers you can send: ${g.room.lenses.filter(c => !c.off).map(c => c.name).join(', ') || 'none'}.`;
    return this.sendMaker(g, lens, brief, rec.name);
  }

  /**
   * Gives a maker an ask, from the lead or straight from the human: its session starts the first
   * time, and later asks are new turns of it, so it keeps what it learnt. Its answer goes back to
   * whoever asked (the lead hears of the human's). `shown` is what the chat says was asked.
   */
  private sendMaker(g: GoalRec, lens: Lens, ask: string, from: string, shown = ask): string {
    const askedBy = from === 'human' ? 'human' : g.lead;
    const existing = g.agents.get(lens.name!);
    if (existing && FINISHED.includes(existing.state)) return `${lens.name} has ${existing.state}. It can be respawned from its panel; ask another maker meanwhile.`;
    this.say(g, { from, to: [lens.name!], text: shown, kind: 'dispatch' });
    const after = from === 'human' ? 'Its answer shows in the chat.' : 'Its answer reaches you as a message: end your turn meanwhile.';
    if (existing) {
      existing.doneNote = undefined;
      existing.askedBy = askedBy;
      this.deliver(g.id, from, existing.name, ask, false, false, true);
      return `Sent ${existing.name} (${existing.harness} · ${existing.model}) the ask. ${after}`;
    }
    const role = this.lensRole(lens);
    if (!role) return `${lens.name}'s role, ${lens.role}, isn't in the configuration any more.`;
    const r = this.spawnAgent(g.id, { role: role.name, roleDef: role, brief: ask, parent: g.lead, name: lens.name, stance: lens.stance, responsibility: responsibilityOf(lens), askedBy });
    if (!r.ok) {
      this.roomNote(g, `${lens.name} couldn't start: ${r.error}`);
      return `${lens.name} couldn't start: ${r.error}`;
    }
    return `Sent ${r.name} (${r.rec.harness} · ${r.rec.model}).${r.note ? ` ${r.note}` : ''} ${after}`;
  }

  /** A maker the human can ask: by name, else the first available one that makes `makes`. */
  private pickMaker(g: GoalRec, name: string | undefined, makes?: Output): Lens {
    const lenses = g.room!.lenses;
    if (name) {
      const lens = this.findLens(g, name);
      if (!lens) throw new Error(`There's no maker called ${name}.`);
      if (lens.off) throw new Error(`${lens.name} is put away: bring it back first.`);
      return lens;
    }
    const lens = lenses.find(l => !l.off && makesOf(l) === makes);
    if (!lens) throw new Error(`No maker here makes ${makes} cards: add one (+ Maker) and try again.`);
    return lens;
  }

  /** The human asks a maker directly, about some cards or not. The lead hears of it. */
  roomAsk(goalId: string, o: { maker: string; text: string; cards?: string[] }): string {
    const g = this.openRoom(goalId);
    const lens = this.pickMaker(g, o.maker);
    const cards = (o.cards ?? []).map(id => g.room!.canvas.cards.find(c => c.id === id)).filter((c): c is Card => !!c);
    const ask = [
      ...(cards.length ? [`[About ${cards.map(c => `${c.id} (${c.kind}) "${c.title}"`).join(', ')}]`] : []),
      o.text,
      '',
      `[Room] The human asks you directly. Put what you make on the board${cards.length ? `, with "from" naming the cards it builds on` : ''}, then answer them with \`done\`.`,
    ].join('\n');
    this.tellLead(g, `[Room] The human asked ${lens.name} directly${cards.length ? ` about ${cards.map(c => c.id).join(', ')}` : ''}: ${o.text.replace(/\s+/g, ' ').slice(0, 300)}`);
    return this.sendMaker(g, lens, ask, 'human', cards.length ? `[${cards.map(c => c.id).join(', ')}] ${o.text}` : o.text);
  }

  /**
   * Mixes cards into something new: placeholders for the results go on the board at once,
   * linked to what they're made from, and the maker that makes that kind fills them. The lead
   * hears of it.
   */
  roomMix(goalId: string, o: { cards: Ingredient[]; make: string; count?: number; note?: string; maker?: string }): string {
    const g = this.openRoom(goalId);
    const c = g.room!.canvas;
    const ingredients = o.cards.map(i => ({ card: c.cards.find(x => x.id === i.id), take: i.take })).filter((i): i is { card: Card; take: string | undefined } => !!i.card);
    if (!ingredients.length) throw new Error('A mix needs cards from the board.');
    const make = (['image', 'demo', 'text', 'ideas', 'source'] as const).find(m => m === o.make);
    if (!make) throw new Error('A mix makes an image, a demo, a text, ideas or a source.');
    const output: Output = make === 'ideas' ? 'text' : make;
    const lens = this.pickMaker(g, o.maker, output);
    const count = Math.max(1, Math.min(4, Math.round(o.count ?? 1)));
    const kind: CardKind = make === 'ideas' ? 'idea' : make;
    const from = ingredients.map(i => ({ id: i.card.id, ...(i.take?.trim() ? { take: i.take.trim().slice(0, 60) } : {}) }));
    const made: string[] = [];
    for (let n = 0; n < count; n++) {
      const card: Card = { id: `c${++c.seq}`, kind, title: `Mixing ${from.map(i => i.id).join(' + ')}…`, by: lens.name!, pending: lens.name!, from };
      c.cards.push(card);
      made.push(card.id);
    }
    this.canvasChanged(g);
    const ask = mixAsk({ ingredients, make, cards: made, note: o.note, shared: g.sharedDir });
    const shown = `Mix ${from.map(i => `${i.id}${i.take ? ` (${i.take})` : ''}`).join(' + ')} → ${count > 1 ? `${count} ` : ''}${make}${count > 1 && make !== 'ideas' ? 's' : ''}${o.note?.trim() ? `: ${o.note.trim()}` : ''}`;
    this.tellLead(g, `[Room] The human mixed cards: ${shown}. ${lens.name} fills ${made.join(', ')}.`);
    const r = this.sendMaker(g, lens, ask, 'human', shown);
    if (!g.agents.has(lens.name!)) {
      // It couldn't start: the placeholders go.
      applyCanvas(c, made.map(id => ({ op: 'remove' as const, id })), 'MetaHarness');
      this.canvasChanged(g);
    }
    return r;
  }

  /**
   * What someone in a room `send`s. The lead's message to the human is a reply in the chat, and
   * to a maker, sends it. A maker talks only with the lead. Undefined: delivered as usual.
   */
  private roomSend(g: GoalRec, from: string, to: string, text: string): string | undefined {
    const t = to.trim().replace(/^@/, '').toLowerCase();
    const human = ['human', 'you', 'user'].includes(t);
    const rec = g.agents.get(from)!;
    if (rec.isLead) {
      if (human) {
        this.roomReply(g, rec, text);
        return 'Posted to the human. Their answer reaches you as a message.';
      }
      // To a maker, it's an ask like any other: the maker answers it.
      const lens = this.findLens(g, to);
      return lens ? this.roomSpawn(rec, lens.name!, text) : undefined;
    }
    if (rec.parent !== g.lead) return undefined;
    if (human || (t !== 'lead' && t !== g.lead.toLowerCase() && g.room!.lenses.some(c => c.name!.toLowerCase() === t || c.role?.toLowerCase() === t))) {
      this.deliver(g.id, from, g.lead, human ? `(for the human) ${text}` : `(for ${to}) ${text}`, false, false, true);
      return `In a room, ${g.lead} talks with the human and sends the makers: it has your message.`;
    }
    return undefined;
  }

  /** The lead says something to the human, in the chat. What it says after that in the same turn is its next reply. */
  private roomReply(g: GoalRec, rec: AgentRec, text: string, stopped = false): void {
    rec.turnText = '';
    this.emit({ goal: g.id, agent: rec.name, type: 'message.sent', data: { to: 'human', text, room: true } });
    this.say(g, { from: rec.name, to: ['human'], text, kind: 'reply', ...(stopped ? { stopped: true } : {}) });
  }

  /** The lead's `done` in a room: its reply. Undefined: not the lead in a room. */
  roomLeadDone(rec: AgentRec, note: string): string | undefined {
    const g = this.goals.get(rec.goal);
    if (!g?.room || !rec.isLead) return undefined;
    this.roomReply(g, rec, note);
    return 'Posted to the human. End your turn now; their next message, or a maker\'s answer, wakes you.';
  }

  /** A turn in a room ended without `done`: the lead's last message is its reply, a maker's its answer. */
  private roomTurnWithoutDone(g: GoalRec, rec: AgentRec): boolean {
    if (rec.quick) return false;
    if (rec.roomStopped) {
      rec.roomStopped = false;
      return true;
    }
    if (rec.isLead) {
      const text = rec.turnText?.trim();
      if (text) this.roomReply(g, rec, text);
      return true;
    }
    if (rec.parent !== g.lead) return false;
    const note = rec.turnText?.trim() || rec.lastText || '(no answer)';
    this.emit({ goal: rec.goal, agent: rec.name, type: 'agent.idle', data: { note } });
    this.finish(rec, note, 'idle');
    return true;
  }

  /**
   * A maker answered (or ended): the chat shows it, and the placeholders it was filling stop
   * being placeholders. Returns true when the human asked, so the lead only hears of it.
   */
  private lensAnswered(g: GoalRec, rec: AgentRec, note: string, how: 'done' | 'idle' | 'ended' | 'crashed', stopped = false): boolean {
    const toHuman = rec.askedBy === 'human';
    const c = g.room!.canvas;
    const unfilled = c.cards.filter(x => x.pending === rec.name);
    if (unfilled.length) {
      for (const x of unfilled) delete x.pending;
      this.canvasChanged(g);
    }
    this.say(g, { from: rec.name, to: [toHuman ? 'human' : g.lead], text: note, kind: how === 'ended' || how === 'crashed' ? 'note' : 'lens', ...(stopped ? { stopped: true } : {}) });
    if (toHuman) this.tellLead(g, `[Room] ${rec.name} answered the human${stopped ? ' (stopped by them)' : ''}: ${note.replace(/\s+/g, ' ').slice(0, 400)}`);
    return toHuman;
  }

  /** The human stops what the lead or a maker is doing; it stays, to be asked again. What it said so far goes on as its reply or answer. */
  roomStop(goalId: string, name: string): string {
    const g = this.goals.get(goalId)!;
    const rec = g.agents.get(name);
    const s = rec?.session;
    if (!rec || !s?.busy()) return `${name} isn't working on anything.`;
    const m = rec.adapter.manifest;
    if (!(m.interrupt && s.interrupt) && !(m.resume && s.nativeId)) throw new Error(`${rec.harness} can't stop a turn and keep its session.`);
    const said = rec.turnText?.trim() || '(stopped before it said anything)';
    this.endPause(rec);
    if (m.interrupt && s.interrupt) {
      // The turn ends on its own; its end isn't another answer.
      rec.roomStopped = true;
      void s.interrupt().catch(() => {});
    } else {
      rec.gen++;
      rec.session = undefined;
      rec.resumeId = s.nativeId;
      this.carryOver(rec);
      void s.stop().catch(() => {});
      this.setState(rec, 'idle');
    }
    this.emit({ goal: g.id, agent: name, type: 'agent.interrupted', data: { how: 'stopped', by: 'human' } });
    if (rec.isLead) this.roomReply(g, rec, said, true);
    else if (!this.lensAnswered(g, rec, said, 'idle', true)) {
      const lead = g.agents.get(rec.parent);
      if (lead) this.enqueue(lead, { id: randomUUID(), kind: 'done', from: rec.name, text: `(the human stopped it here) ${said}`, urgent: false, ts: new Date().toISOString() });
    }
    if (!rec.roomStopped) this.pump(rec);
    return `Stopped ${name}.`;
  }

  /** The `team` tool in a room: the lead, the makers, and what each is doing. */
  roomTeam(rec: AgentRec): string | undefined {
    const g = this.goals.get(rec.goal);
    if (!g?.room || rec.quick) return undefined;
    const paths = this.roomPaths(g);
    return [
      `Room: ${g.request}`,
      `Lead: ${g.lead}${rec.name === g.lead ? '  ← you' : ''}`,
      `Shared folder: ${g.sharedDir} (the board: ${paths.canvas}; images: ${paths.media}; demos: ${paths.demos}; the chat: ${paths.chat})`,
      '',
      'Makers:',
      ...g.room.lenses.map(l => {
        const a = g.agents.get(l.name!);
        const line = lensLines([l], () => !!a, p => this.makerCan(p))[0];
        return `${line}${a ? `, ${a.state}${a.status ? `: ${a.status.slice(0, 120)}` : ''}` : ''}${l.name === rec.name ? '  ← you' : ''}`;
      }),
      ...(g.room.lenses.length ? [] : ['(none)']),
      '',
      rec.isLead ? 'Send a maker with spawn (role: its name).' : `You talk with ${g.lead}; put what you make on the board.`,
    ].join('\n');
  }

  /** Someone changes the board: the lead or a maker through the `canvas` tool, the human from the room. */
  roomCanvas(goalId: string, ops: CanvasOp[], by: string): CanvasResult {
    const g = this.goals.get(goalId)!;
    const r = applyCanvas(g.room!.canvas, ops, by, g.sharedDir);
    if (!r.changed) return r;
    this.canvasChanged(g);
    // Where the human put cards is theirs: only what changed on the board is worth the lead's attention.
    const said = r.done.filter(d => !/^(moved|tidied)/.test(d));
    if (by !== g.lead && said.length) this.tellLead(g, `[Room] ${by === 'human' ? 'The human' : by} changed the board: ${said.join('; ')}.`);
    return r;
  }

  /** The `canvas` tool: changes, or the whole board to read. */
  canvasTool(rec: AgentRec, ops: CanvasOp[]): string {
    const g = this.goals.get(rec.goal);
    if (!g?.room) return 'The board is for brainstorm rooms; there is none in a goal.';
    if (!ops.length) return canvasMarkdown(g.request, g.room.canvas, g.sharedDir);
    const r = this.roomCanvas(g.id, ops, rec.name);
    return [r.done.length ? `Done: ${r.done.join('; ')}.` : 'Nothing changed.', ...(r.skipped.length ? [`Skipped: ${r.skipped.join('; ')}.`] : [])].join('\n');
  }

  private canvasChanged(g: GoalRec): void {
    const c = g.room!.canvas;
    this.emit({ goal: g.id, type: 'room.canvas', data: { cards: c.cards, links: c.links, frames: c.frames } });
    try {
      writeFileSync(this.roomPaths(g).canvas, canvasMarkdown(g.request, c, g.sharedDir));
    } catch {
      // The event has it; the file is for the agents.
    }
  }

  /**
   * A file of a room's for the browser (GET /media): an image as it is, a demo page with the
   * room's knobs wired in (starting from `values` when given). Rooms not loaded here are read
   * from where their log says.
   */
  roomMedia(goalId: string, path: string, values?: Record<string, number>): { type: string; body: Buffer | string } {
    if (!/^[0-9a-f-]+$/i.test(goalId)) throw new Error(`There's no room ${goalId}.`);
    const dir = this.goals.get(goalId)?.sharedDir ?? join(this.home, 'goals', goalId, 'shared');
    const rel = sharedPath(dir, path);
    const ext = extname(path).toLowerCase();
    const type = MEDIA_TYPES[ext];
    if (!rel || !type || rel.split('/')[0] === HISTORY) throw new Error(`${path} isn't an image or a demo in the room's folder.`);
    const file = join(dir, rel);
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`There's no ${rel} in the room's folder.`);
    if (ext === '.html' || ext === '.htm') return { type, body: demoPage(readFileSync(file, 'utf8'), values) };
    return { type, body: readFileSync(file) };
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
      // A room is one sitting: after a restart it's over (start a new room from it).
      if (start.data.kind === 'room') {
        this.endLeftRoom(start.goal);
        continue;
      }
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

  /** A room the last daemon left open ends here, and its worktree and merged branch go as when the human ends one. */
  private endLeftRoom(id: string): void {
    const r = replayGoal(this.store.since(id));
    if (!r || r.ended) return;
    this.emit({ goal: id, type: 'goal.ended', data: { reason: 'the daemon restarted', stopped: [] } });
    if (!this.autoClean) return;
    const res = cleanGoal(this.home, r, false);
    if (res.removed.length || res.deleted.length || res.kept.length) {
      this.emit({ goal: id, type: 'goal.cleaned', data: { removed: res.removed, deleted: res.deleted, kept: res.kept, force: false } });
    }
  }

  private restoreGoal(r: GoalReplay): { resumed: string[]; later: string[] } {
    let resolveLeadDone!: (note: string) => void;
    const leadDone = new Promise<string>(res => (resolveLeadDone = res));
    const g: GoalRec = {
      id: r.id, request: r.request, dir: r.dir, lead: r.lead, createdAt: r.createdAt, sharedDir: r.sharedDir,
      refs: r.refs, seenOn: r.seenOn, workflow: r.workflow, status: 'running',
      chained: [...new Set(this.store.ofType('workflow.read').filter(e => e.goal === r.id).map(e => String(e.data.workflow)))], agents: new Map(), counters: r.counters,
      conflicts: r.conflicts, notes: r.notes, shared: new SharedFolder(r.sharedDir), sharedTouches: [], leadDone, resolveLeadDone,
      // Spent before the restart; sessions from now on are counted from 0.
      gatekeeperCost: new Map(r.gatekeeperCost ? [[-1, r.gatekeeperCost]] : []),
    };
    mkdirSync(g.sharedDir, { recursive: true });
    // What's there now counts as seen; changes made while the daemon was down aren't reported.
    g.shared.seed(r.shared);
    // The branch and base the goal started on, not whatever is checked out now.
    const gs = r.base ? git.setupGoal(g.dir, g.id) : { reason: 'there was no git repository when it started' };
    if ('reason' in gs) g.gitNote = gs.reason;
    else {
      g.git = { ...gs, branch: r.branch ?? gs.branch, base: r.base ?? gs.base };
      this.watchAuthors(g, g.git);
    }
    this.goals.set(g.id, g);
    for (const a of r.agents.values()) g.agents.set(a.name, this.restoreAgent(g, a));

    for (const i of r.inbox) {
      // The session that asked is gone; if the agent still needs it, it asks again.
      if (i.kind === 'approval') {
        this.emit({ goal: g.id, agent: i.agent, type: 'inbox.resolved', data: { id: i.id, decision: 'dismiss', reply: null, why: 'the daemon restarted' } });
        continue;
      }
      this.humanInbox.push({ id: i.id, goal: g.id, agent: i.agent, kind: i.kind as HumanInboxItem['kind'], text: i.text, ts: i.ts, ...(i.note ? { note: i.note } : {}) });
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
      goal: g.id, name: a.name, role, harness: a.harness, model: a.model, ...(a.effort ? { effort: a.effort } : {}), parent: a.parent, brief: a.brief,
      quick: a.quick, isLead: a.name === g.lead, cwd: a.cwd, worktree, state: a.state, status: a.status,
      cost: a.cost, costBefore: a.costBefore, costSource: a.costSource, tokens: a.tokens, tokensBefore: a.tokensBefore, costSplit: a.costSplit, splitBefore: a.splitBefore,
      lastCallAt: a.lastCallAt, cacheMinutes: a.cacheMinutes, contextPct: a.contextPct, lastText: a.lastText,
      adapter: this.adapters[a.harness], resumeId: a.nativeSession, gen: 0, token, systemPrompt: '', doneNote: a.doneNote,
      inbox: [], waiters: [], doneWaiters: [], pendingApprovals: 0, fileNotes: new Map(), toolsRunning: 0, lastToolEnd: 0,
      progressAt: Date.now(), rules: new RuleState(), ruleNotes: [],
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
    this.carryOver(rec);
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
    const team = this.teamLines(g, rec);
    return [
      '[MetaHarness] MetaHarness restarted while you were working, so your last turn was cut off. A command or tool call ' +
        "you were in may not have finished, and a `wait` or `spawn` you were in returned nothing. Check where your work stands " +
        '(files, git status), then carry on.',
      ...(team.length ? ['', 'Your team now:', ...team] : []),
    ].join('\n');
  }

  /** Teammates and their states, with the results of those `rec` spawned: for a session that starts without its old context. */
  private teamLines(g: GoalRec, rec: AgentRec): string[] {
    const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
    return [...g.agents.values()]
      .filter(a => a !== rec && !a.quick)
      .map(a => {
        const status = a.status && a.doneNote === undefined ? `, "${cut(a.status, 120)}"` : '';
        const result = a.parent === rec.name && a.doneNote !== undefined ? `. It finished: ${cut(a.doneNote, 400)}` : '';
        return `- ${a.name} (${a.role.name}${a.parent === rec.name ? ', yours' : ''}): ${a.state}${status}${result}`;
      });
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
        note: typeof e.data.note === 'string' ? e.data.note : undefined,
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

  /**
   * Deletes goals for good: the worktrees and merged branches go as in a clean, then the goal's
   * folder (shared files and their history, agents' folders) and its events. Commits on the
   * human's branches stay. A goal still at work must be ended first; one whose worktrees or
   * branches hold unsaved work is left alone unless `force`, which removes that work too. A
   * folder whose goal the log no longer has just goes.
   */
  deleteGoals(ids: string[], force = false): { deleted: string[]; kept: { goal: string; items: string[] }[]; refused: string[] } {
    const out = { deleted: [] as string[], kept: [] as { goal: string; items: string[] }[], refused: [] as string[] };
    const known = new Set(this.store.ofType('goal.started').map(e => e.goal));
    for (const id of ids) {
      if (!/^[0-9a-f-]+$/i.test(id) || id === ASSISTANT_STREAM) {
        out.refused.push(`There's no goal ${id}.`);
        continue;
      }
      const dir = join(this.home, 'goals', id);
      if (!known.has(id)) {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          out.deleted.push(id);
        } else out.refused.push(`There's no goal ${id}.`);
        continue;
      }
      const live = this.goals.get(id);
      const busy = live && live.status !== 'ended' ? this.busyAgents(live) : [];
      if (busy.length) {
        out.refused.push(`Goal ${id} is still at work (${busy.join(', ')}). End it first.`);
        continue;
      }
      const r = replayGoal(this.store.since(id));
      const res = live ? this.runCleanup(live, force) : r ? cleanGoal(this.home, r, force) : undefined;
      if (res?.kept.length && !force) {
        out.kept.push({ goal: id, items: res.kept });
        continue;
      }
      if (live) {
        if (live.status !== 'ended') this.endGoal(id, 'the human, deleting it');
        for (const a of live.agents.values()) this.tokens.delete(a.token);
        this.goals.delete(id);
      }
      for (let i = this.humanInbox.length - 1; i >= 0; i--) if (this.humanInbox[i].goal === id) this.humanInbox.splice(i, 1);
      const gg = live?.git ?? this.pastGoalGit(id);
      if (gg) removeAuthors(gg.commonDir, id);
      live?.authorsWatch?.close();
      this.store.deleteGoal(id);
      rmSync(dir, { recursive: true, force: true });
      out.deleted.push(id);
    }
    return out;
  }

  /**
   * How much each goal keeps on disk (its folder: shared files with their history, agents'
   * folders, worktrees), counting hard-linked files once. Folders the log no longer has a goal
   * for are listed too, so they can go.
   */
  goalSizes(): { id: string; bytes: number; known: boolean }[] {
    const root = join(this.home, 'goals');
    if (!existsSync(root)) return [];
    const known = new Set(this.store.ofType('goal.started').map(e => e.goal));
    return readdirSync(root).map(id => ({ id, bytes: folderBytes(join(root, id)), known: known.has(id) }));
  }

  /** Opens a goal's shared folder (or the folder it ran in) in the file manager, on the machine the daemon runs on. */
  openGoalFolder(id: string, which: 'shared' | 'dir'): string {
    const start = this.store.ofType('goal.started').find(e => e.goal === id);
    if (!start) throw new Error(`There's no goal ${id}.`);
    const path = which === 'dir' ? String(start.data.dir ?? '') : this.goals.get(id)?.sharedDir ?? join(this.home, 'goals', id, 'shared');
    if (!path || !existsSync(path)) throw new Error(`${path || 'That folder'} isn't there any more.`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [path], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    return path;
  }

  /* ---------------- client API ---------------- */

  /**
   * What clients show (design §13): goals with their agents, the Inbox, accounts, and what each
   * harness can report (so a client hides a field it can't fill rather than showing a zero). A
   * goal that isn't loaded here, such as one that finished before a restart, is rebuilt from the log.
   */
  snapshot(goalId?: string) {
    const loaded = [...this.goals.values()].filter(g => !goalId || g.id === goalId);
    const goals = loaded.map(g => this.goalView(g));
    let inbox = this.humanInbox.filter(i => !goalId || i.goal === goalId);
    if (goalId && !loaded.length) {
      const r = this.store.ofType('goal.started').some(e => e.goal === goalId) ? replayGoal(this.store.since(goalId)) : undefined;
      if (r) {
        goals.push(this.replayView(r));
        inbox = r.inbox.map(i => ({ id: i.id, goal: r.id, agent: i.agent, kind: i.kind as HumanInboxItem['kind'], text: i.text, ts: i.ts, ...(i.note ? { note: i.note } : {}) }));
      }
    }
    const harnesses = Object.fromEntries(Object.entries(this.adapters).map(([id, a]) => [id, a.manifest]));
    return {
      goals,
      inbox,
      // What a client offers when starting a goal or spawning an agent.
      roles: [...this.config.roles.values()].map(r => ({ name: r.name, harness: r.harness, model: r.model, goodAt: r.goodAt, helper: r.helper, worktree: r.worktree })),
      workflows: [...this.config.workflows.values()].map(w => ({ name: w.name, goodAt: w.goodAt })),
      ...this.accountsView(),
      harnesses,
    };
  }

  /**
   * running: the lead is at work; done: it finished (teammates may still be asked things); ended:
   * stopped for good; stopped: not running here, and its lead never finished (a log from before a restart).
   */
  private goalStatus(g: GoalRec): GoalStatus {
    if (g.status === 'ended') return 'ended';
    const lead = g.agents.get(g.lead);
    return lead && (lead.doneNote !== undefined || FINISHED.includes(lead.state)) ? 'done' : 'running';
  }

  private goalView(g: GoalRec) {
    const agents = [...g.agents.values()];
    const costs = [...agents.map(a => this.priced(a).cost), g.gatekeeperCost.size ? this.gatekeeperCost(g) : undefined].filter((c): c is number => c !== undefined);
    return {
      id: g.id,
      kind: g.kind ?? 'goal',
      request: g.request,
      status: this.goalStatus(g),
      live: true,
      lead: g.lead,
      createdAt: g.createdAt,
      dir: g.dir,
      sharedDir: g.sharedDir,
      branch: g.git?.branch ?? null,
      workflow: g.workflow ?? null,
      notice: this.goalNotice(g) ?? null,
      cost: costs.length ? costs.reduce((x, y) => x + y, 0) : null,
      agents: agents.map(a => ({
        name: a.name,
        role: a.role.name,
        harness: a.harness,
        model: a.model,
        effort: a.effort ?? null,
        parent: a.parent,
        state: a.state,
        /** The human asked for a pause that waits for the current step to finish. */
        pausing: !!a.held && a.state !== 'paused',
        status: a.status,
        brief: a.brief,
        quick: a.quick,
        branch: a.worktree?.branch ?? null,
        worktree: a.worktree?.path ?? null,
        cwd: a.cwd,
        cost: this.priced(a).cost ?? null,
        contextPct: a.contextPct ?? null,
        unread: a.inbox.length,
        awaitingApproval: a.pendingApprovals,
        nativeSession: a.session?.nativeId ?? a.resumeId ?? null,
        limitedUntil: a.limitedUntil ?? null,
        doneNote: a.doneNote ?? null,
        waitingOn: this.waitingOn(g, a),
        ...this.spendView(a),
      })),
      gatekeeperCost: g.gatekeeperCost.size ? this.gatekeeperCost(g) : null,
    };
  }

  /**
   * Who an agent is held up by, for the graph: the human (an approval, a question or decision
   * it sent), the teammates or helpers it started that still work, or else whoever it last dealt
   * with. Only while it waits (or has an approval open).
   */
  private waitingOn(g: GoalRec, a: AgentRec): { who: string[]; why: 'approval' | 'question' | 'decision' | 'helpers' | 'partner' } | null {
    if (a.pendingApprovals) return { who: ['human'], why: 'approval' };
    if (a.state !== 'waiting') return null;
    const asked = this.humanInbox.find(i => i.goal === g.id && i.agent === a.name && (i.kind === 'question' || i.kind === 'decision'));
    if (asked) return { who: ['human'], why: asked.kind as 'question' | 'decision' };
    const kids = [...g.agents.values()].filter(c => c.parent === a.name && !FINISHED.includes(c.state) && c.doneNote === undefined).map(c => c.name);
    if (kids.length) return { who: kids, why: 'helpers' };
    const p = a.lastPartner?.name;
    return p && (p === 'human' || g.agents.has(p)) ? { who: [p], why: 'partner' } : null;
  }

  /** What an agent spent, by kind of token, and how long its prompt cache stays warm. */
  private spendView(a: Spender & { lastCallAt?: number; cacheMinutes?: number }) {
    const minutes = this.cacheLifetime(a);
    const p = this.priced(a);
    return {
      tokens: a.tokens ?? null,
      costSplit: p.costSplit ?? null,
      costSource: p.costSource ?? null,
      lastCallAt: a.lastCallAt ?? null,
      cacheMinutes: minutes,
      cacheUntil: a.lastCallAt ? a.lastCallAt + minutes * 60_000 : null,
    };
  }

  /**
   * An agent's cost: the harness's own figure when it reports one, else its tokens at the
   * settings' current prices (so a price set later counts for work already done).
   */
  private priced(a: Spender): { cost?: number; costSplit?: CostSplit; costSource?: 'harness' | 'prices' } {
    if (a.costSource === 'harness') return a;
    const prices = modelSettings(this.config.settings, a.harness, a.model).prices;
    if (!prices || !a.tokens) return a;
    const costSplit = priceSplit(a.tokens, prices);
    return { cost: splitTotal(costSplit), costSplit, costSource: 'prices' };
  }

  /** The settings' cache lifetime for the model, else what the harness reported, else the default. */
  cacheLifetime(a: { harness: string; model: string; cacheMinutes?: number }): number {
    return modelSettings(this.config.settings, a.harness, a.model).cacheMinutes ?? a.cacheMinutes ?? this.config.settings.defaultCacheMinutes;
  }

  /** A goal not loaded here, as the log left it. */
  private replayView(r: GoalReplay) {
    const agents = [...r.agents.values()];
    // Rooms before the lead and its canvas (2026-10-26) had a coordinator, with its own spend.
    const costs = [...agents.map(a => this.priced(a).cost), r.gatekeeperCost || undefined, r.coordinatorCost || undefined].filter((c): c is number => c !== undefined);
    const lead = r.agents.get(r.lead);
    return {
      id: r.id,
      kind: r.kind ?? 'goal',
      request: r.request,
      status: (r.ended ? 'ended' : lead && (lead.doneNote !== undefined || ['ended', 'crashed'].includes(lead.state)) ? 'done' : 'stopped') as GoalStatus,
      live: false,
      lead: r.lead,
      createdAt: r.createdAt,
      dir: r.dir,
      sharedDir: r.sharedDir,
      branch: r.branch ?? null,
      workflow: r.workflow ?? null,
      notice: null,
      cost: costs.length ? costs.reduce((x, y) => x + y, 0) : null,
      agents: agents.map(a => ({
        // One that called done may not have ended its turn before the log stopped.
        name: a.name, role: a.role, harness: a.harness, model: a.model, effort: a.effort ?? null, parent: a.parent, pausing: false,
        state: a.doneNote !== undefined && INTERRUPTED.includes(a.state) ? 'done' : a.state,
        status: a.status, brief: a.brief, quick: a.quick, branch: a.worktree?.branch ?? null, worktree: a.worktree?.path ?? null,
        cwd: a.cwd, cost: this.priced(a).cost ?? null, contextPct: a.contextPct ?? null, unread: a.undelivered.length, awaitingApproval: 0, waitingOn: null,
        nativeSession: a.nativeSession ?? null, limitedUntil: null, doneNote: a.doneNote ?? null,
        ...this.spendView(a),
      })),
      gatekeeperCost: r.gatekeeperCost || null,
    };
  }

  /** Every goal in the log, newest first: the Goals list. */
  listGoals() {
    // What the Goals list shows of each: its outcome (the lead's note), who's at work, what waits for the human.
    const summary = (v: ReturnType<Daemon['goalView']>) => ({
      id: v.id, kind: v.kind, request: v.request, status: v.status, live: v.live, createdAt: v.createdAt, dir: v.dir, lead: v.lead, cost: v.cost,
      agents: v.agents.length, working: v.agents.filter(a => ['starting', 'working', 'waiting', 'limited'].includes(a.state)).length,
      branch: v.branch, workflow: v.workflow, result: v.agents.find(a => a.name === v.lead)?.doneNote ?? null,
      inbox: this.humanInbox.filter(i => i.goal === v.id).length,
      /** Approvals, decisions and questions: an agent waits on each. */
      needs: this.humanInbox.filter(i => i.goal === v.id && ['approval', 'decision', 'question'].includes(i.kind)).length,
    });
    return this.store
      .ofType('goal.started')
      .map(e => {
        const g = this.goals.get(e.goal);
        if (g) return summary(this.goalView(g));
        const r = replayGoal(this.store.since(e.goal));
        return r ? summary(this.replayView(r)) : undefined;
      })
      .filter(<T>(x: T | undefined): x is T => x !== undefined)
      .reverse();
  }

  /** One agent in full: its prompt, where it works, how to open its session, what its harness reports. */
  agentDetail(goalId: string, name: string) {
    const rec = this.agent(goalId, name);
    if (!rec) {
      const a = this.store.ofType('goal.started').some(e => e.goal === goalId) ? replayGoal(this.store.since(goalId))?.agents.get(name) : undefined;
      if (!a) throw new Error(`There's no agent ${name} in goal ${goalId}.`);
      return { goal: goalId, name, role: a.role, harness: a.harness, model: a.model, parent: a.parent, brief: a.brief, systemPrompt: null, cwd: a.cwd, worktree: a.worktree ?? null, startedFrom: a.startedFrom ?? null, nativeSession: a.nativeSession ?? null, open: null, live: false };
    }
    return {
      goal: goalId, name, role: rec.role.name, harness: rec.harness, model: rec.model, parent: rec.parent, brief: rec.brief,
      systemPrompt: rec.systemPrompt, roleFile: rec.role.file, cwd: rec.cwd,
      worktree: rec.worktree ? { path: rec.worktree.path, branch: rec.worktree.branch, base: rec.worktree.base, deps: rec.worktree.deps ?? [] } : null,
      nativeSession: rec.session?.nativeId ?? rec.resumeId ?? null, open: this.openNative(goalId, name), manifest: rec.adapter?.manifest ?? null, live: true,
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
        const goal = this.startGoal({ request, lead: s('lead'), workflow: s('workflow') ?? s('playbook'), fromRoom: s('fromRoom') });
        return { goal, notice: this.goalNotice(this.goals.get(goal)!) ?? null };
      }
      case 'room.start': {
        const topic = s('topic');
        if (!topic) throw new Error('room.start needs a topic.');
        // No makers given: the built-in ones.
        const lenses = Array.isArray(b.lenses) ? (b.lenses as Lens[]).filter(p => p && (p.role || p.on)) : undefined;
        const cards = Array.isArray(b.cards) ? b.cards.map(String) : undefined;
        const room = this.startRoom({ topic, lenses, from: s('from'), cards });
        return { goal: room, room, notice: this.goalNotice(this.goals.get(room)!) ?? null };
      }
      case 'room.post': {
        const text = s('text');
        if (!text) throw new Error('room.post needs "text".');
        return { result: this.roomPost(this.roomId(s('goal')), { text, card: s('card') }) };
      }
      case 'room.lens': {
        if (!s('role') && !s('on')) throw new Error('room.lens needs a role, or a model (on), for the maker.');
        return { result: this.roomAddLens(this.roomId(s('goal')), { role: s('role'), name: s('name'), on: s('on'), responsibility: s('responsibility'), stance: s('stance') }) };
      }
      case 'room.lensOff': {
        const lens = s('lens');
        if (!lens) throw new Error('room.lensOff needs "lens".');
        return { result: this.roomLensOff(this.roomId(s('goal')), lens, b.off !== false) };
      }
      case 'room.stop': {
        const agent = s('agent');
        if (!agent) throw new Error('room.stop needs "agent".');
        return { result: this.roomStop(this.roomId(s('goal')), agent) };
      }
      case 'room.canvas': {
        const ops = parseCanvasOps(b);
        const r = this.roomCanvas(this.roomId(s('goal')), ops, 'human');
        if (!r.changed && r.skipped.length) throw new Error(r.skipped.join('; '));
        return { result: r.changed ? 'Board updated.' : 'Nothing changed.' };
      }
      case 'room.ask': {
        const text = s('text');
        if (!text) throw new Error('room.ask needs "text".');
        const maker = s('maker') ?? s('lens');
        if (!maker) throw new Error('room.ask needs "maker".');
        return { result: this.roomAsk(this.roomId(s('goal')), { maker, text, cards: Array.isArray(b.cards) ? b.cards.map(String) : undefined }) };
      }
      case 'room.mix': {
        const cards: Ingredient[] = Array.isArray(b.cards)
          ? b.cards.map(c => (c && typeof c === 'object' ? { id: String((c as Ingredient).id ?? ''), take: typeof (c as Ingredient).take === 'string' ? (c as Ingredient).take : undefined } : { id: String(c) }))
          : [];
        const make = s('make');
        if (!cards.length || !make) throw new Error('room.mix needs "cards" (ids, or {id, take}) and "make" (image, demo, text, ideas or source).');
        return { result: this.roomMix(this.roomId(s('goal')), { cards, make, count: Number(b.count) || 1, note: s('note'), maker: s('maker') }) };
      }
      case 'room.end': {
        const id = this.roomId(s('goal'));
        return { goal: id, result: this.endGoal(id) };
      }
      case 'cast.save': {
        const name = s('name')?.trim().replace(/[^\w.-]+/g, '-');
        const participants = Array.isArray(b.participants) ? (b.participants as Lens[]).filter(p => p?.role || p?.on).map(({ role, name, on, responsibility, stance }) => ({ role, name, on, responsibility, stance })) : [];
        if (!name || !participants.length) throw new Error('cast.save needs a name and participants.');
        const scope = scopesOf(this.configDirs).find(x => x.scope === (s('scope') ?? 'repo')) ?? scopesOf(this.configDirs).at(-1)!;
        const file = join(scope.dir, 'casts', `${name}.md`);
        mkdirSync(join(scope.dir, 'casts'), { recursive: true });
        writeFileSync(file, castText({ goodAt: s('goodAt'), participants }));
        this.reloadConfig();
        return { result: `Saved the cast ${name}.`, file, config: this.configView() };
      }
      case 'cast.delete': {
        const c = this.config.casts.get(s('name') ?? '');
        if (!c) throw new Error(`There's no cast called ${s('name')}.`);
        rmSync(c.file, { force: true });
        this.reloadConfig();
        return { result: `Deleted the cast ${c.name}.`, config: this.configView() };
      }
      case 'agent.message': {
        const to = s('to'), text = s('text');
        if (!to || !text) throw new Error('agent.message needs "to" and "text".');
        const goal = goalOrLatest();
        // In a room, what you say to the lead shows in the chat.
        const g = this.goals.get(goal);
        if (g?.room && to === g.lead) return { goal, result: this.roomPost(goal, { text }) };
        return { goal, result: this.deliver(goal, 'human', to, text, b.urgent === true) };
      }
      case 'agent.stop':
      case 'agent.pause':
      case 'agent.resume': {
        const agent = s('agent');
        if (!agent) throw new Error(`${b.cmd} needs "agent".`);
        const goal = goalOrLatest();
        const result = b.cmd === 'agent.stop' ? this.stopAgent(goal, agent) : b.cmd === 'agent.pause' ? this.pauseAgent(goal, agent) : this.unpauseAgent(goal, agent);
        return { goal, result };
      }
      case 'goal.pause':
      case 'goal.resume': {
        const goal = goalOrLatest();
        return { goal, result: this.pauseGoal(goal, b.cmd === 'goal.resume') };
      }
      case 'goal.end': {
        const goal = goalOrLatest();
        return { goal, result: this.endGoal(goal) };
      }
      case 'agent.spawn': {
        const role = s('role'), brief = s('brief');
        if (!role || !brief) throw new Error('agent.spawn needs "role" and "brief".');
        const goal = goalOrLatest();
        const parent = s('parent') ?? 'human';
        if (parent !== 'human' && !this.agent(goal, parent)) throw new Error(`There's no agent called ${parent} to spawn under.`);
        const r = this.spawnAgent(goal, { role, brief, parent, name: s('name'), worktree: typeof b.worktree === 'boolean' ? b.worktree : undefined, from: s('from') });
        if (!r.ok) throw new Error(r.error);
        return { goal, agent: r.name, result: `Started ${r.name} (${r.rec.harness} · ${r.rec.model})${r.note ? `. ${r.note}` : '.'}` };
      }
      case 'agent.respawn': {
        const agent = s('agent');
        if (!agent) throw new Error('agent.respawn needs "agent".');
        const goal = goalOrLatest();
        const r = this.respawnAgent(goal, agent, { by: 'human', fresh: b.fresh === true, on: s('on'), note: s('note') });
        if (!r.ok) throw new Error(r.error);
        return { goal, agent, result: r.text };
      }
      case 'agent.open_native': {
        const agent = s('agent');
        if (!agent) throw new Error('agent.open_native needs "agent".');
        const goal = goalOrLatest();
        return { goal, ...this.openNative(goal, agent) };
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
      case 'goal.delete': {
        const ids = Array.isArray(b.goals) ? b.goals.map(String) : s('goal') ? [s('goal')!] : [];
        if (!ids.length) throw new Error('goal.delete needs "goals": the goals to delete.');
        return this.deleteGoals(ids, b.force === true);
      }
      case 'note.pin':
        return { result: 'Pinned. Agents get it the first time they work there.', ...this.pinNote(String(b.goal), String(b.path ?? ''), String(b.text ?? '')) };
      case 'note.remove':
        this.unpinNote(String(b.goal), String(b.id));
        return { result: 'Removed.' };
      case 'note.keep': {
        const file = this.keepNote(String(b.goal), String(b.id), b.scope ? String(b.scope) : 'repo');
        return { result: `Saved as a rule in ${file}: agents get it in future goals too.`, file };
      }
      case 'goal.sizes':
        return { sizes: this.goalSizes() };
      case 'goal.open_folder':
        return { path: this.openGoalFolder(s('goal') ?? '', s('which') === 'dir' ? 'dir' : 'shared') };
      case 'limits.check': {
        const harness = s('harness');
        if (harness && !this.adapters[harness]?.readLimits) throw new Error(`MetaHarness can't read ${harness}'s limits here.`);
        await this.checkLimits(harness, true);
        return this.accountsView();
      }
      case 'harness.test': {
        const harness = s('harness');
        if (!harness) throw new Error('harness.test needs "harness".');
        if (!this.adapters[harness]) throw new Error(`MetaHarness can't run ${harness} here. Harnesses it can run: ${Object.keys(this.adapters).join(', ')}.`);
        const { probeHarness } = await import('./probe.ts');
        return { ...(await probeHarness(this, harness, s('model') ?? '')) };
      }
      case 'config.get':
        return this.configView();
      case 'role.save':
      case 'role.delete':
      case 'workflow.save':
      case 'workflow.delete':
      case 'rule.save':
      case 'rule.delete':
      case 'guide.save':
      case 'mcp.save': {
        const scopes = scopesOf(this.configDirs);
        const file =
          b.cmd === 'role.save' ? saveRole(scopes, b)
          : b.cmd === 'workflow.save' ? saveWorkflow(scopes, b)
          : b.cmd === 'rule.save' ? saveRule(scopes, b)
          : b.cmd === 'guide.save' ? saveGuide(scopes, b)
          : b.cmd === 'mcp.save' ? saveMcp(scopes, b)
          : deleteItem(scopes, b.cmd === 'role.delete' ? 'role' : b.cmd === 'rule.delete' ? 'rule' : 'workflow', b);
        this.reloadConfig();
        const what = String(b.cmd).endsWith('.delete') ? 'Deleted' : 'Saved';
        return { result: `${what} ${file}. Agents started from now on use it.`, file, config: this.configView() };
      }
      case 'settings.save': {
        const scope = scopesOf(this.configDirs).find(x => x.scope === b.scope);
        if (!scope) throw new Error(`There's no ${String(b.scope)} config folder here.`);
        if (!b.patch || typeof b.patch !== 'object') throw new Error('settings.save needs "patch": the keys to change.');
        const file = writeSettingsFile(scope.dir, b.patch as Record<string, unknown>);
        this.reloadConfig();
        return { result: `Saved ${file}.`, file, config: this.configView() };
      }
      case 'role.builtin': {
        // A built-in role (the gatekeeper, the assistant, the room lead), written out so it can be edited like any other.
        const name = s('role') === 'assistant' ? this.config.settings.assistant : s('role') === 'roomLead' ? this.config.settings.roomLead : this.config.settings.gatekeeper;
        const r = this.config.roles.get(name)!;
        const file = saveRole(scopesOf(this.configDirs), {
          scope: b.scope, name: r.name, harness: r.harness, model: r.model, ...(r.effort ? { effort: r.effort } : {}), fallback: r.fallback, goodAt: r.goodAt, instructions: r.instructions, helper: true,
        });
        this.reloadConfig();
        return { result: `Saved ${file}.`, file, config: this.configView() };
      }
      case 'role.update': {
        // Some of a role's fields; the rest stay as its file has them.
        const name = s('name');
        const cur = this.configView().roles.filter(r => r.name === name).at(-1);
        if (!cur) throw new Error(`There's no role file called ${name}. Built-in roles are written out with role.builtin first.`);
        const changes = (b.changes && typeof b.changes === 'object' ? b.changes : {}) as Record<string, unknown>;
        const file = saveRole(scopesOf(this.configDirs), { ...cur, ...changes, name: cur.name, scope: cur.scope, previous: { name: cur.name, scope: cur.scope } });
        this.reloadConfig();
        return { result: `Saved ${file}. Agents started from now on use it.`, file, config: this.configView() };
      }
      case 'assistant.ask': {
        const text = s('text');
        if (!text) throw new Error('assistant.ask needs "text".');
        this.assistant.ask(text, s('context'));
        return { conv: this.assistant.conv };
      }
      case 'assistant.reset':
        await this.assistant.reset();
        return { conv: this.assistant.conv, choice: this.assistant.choice };
      case 'assistant.state': {
        const role = this.config.roles.get(this.config.settings.assistant) && this.assistantRole();
        const r = role && this.pickRoute(role);
        const from = this.assistantFrom?.conv === this.assistant.conv ? this.assistantFrom.seq : (this.store.since(ASSISTANT_STREAM).at(-1)?.seq ?? 0);
        return {
          conv: this.assistant.conv, since: from, busy: this.assistant.busy(), role: role?.name ?? null, route: r && !('error' in r) ? r.route : null, error: r && 'error' in r ? r.error : null,
          choice: this.assistant.choice, dir: this.repo,
        };
      }
      case 'assistant.set': {
        // harness and model together pick its model ("" for the role's); effort alone; write: true or false.
        const harness = s('harness');
        if (harness && !this.adapters[harness] && !this.harnessOverride) throw new Error(`MetaHarness can't run ${harness} here.`);
        this.assistant.set({ ...('model' in b ? { harness, model: s('model') } : {}), ...('effort' in b ? { effort: s('effort') } : {}), ...(typeof b.write === 'boolean' ? { write: b.write } : {}) });
        return { choice: this.assistant.choice };
      }
      case 'assistant.make_default': {
        // The model and effort picked in the panel become its role's own, so they outlast a restart.
        const { harness, model, effort } = this.assistant.choice;
        if (!model && !effort) throw new Error("The assistant already runs on its role's model and effort.");
        const name = this.config.settings.assistant;
        const cur = this.configView().roles.filter(r => r.name === name).at(-1);
        // The built-in role is written out first, to your personal folder (else the repository's).
        if (!cur || cur.scope === 'built-in') await this.command({ cmd: 'role.builtin', role: 'assistant', scope: scopesOf(this.configDirs)[0].scope });
        const role = this.configView().roles.filter(x => x.name === name).at(-1)!;
        // Backups named by model alone meant the old harness; the new model is no backup of itself.
        const fallback = role.fallback.map(f => (splitEffort(f).model.includes('/') ? f : `${role.harness}/${f}`)).filter(f => splitEffort(f).model !== `${harness}/${model}`);
        const r = await this.command({ cmd: 'role.update', name, changes: { ...(model ? { harness, model, fallback } : {}), ...(effort ? { effort } : {}) } });
        // Its route is the same as before, so the session carries on.
        this.assistant.adopt();
        this.assistantLog('assistant.default_saved', { harness: harness ?? null, model: model ?? null, effort: effort ?? null, file: r.file ?? null });
        return { result: r.result, file: r.file, config: this.configView(), choice: this.assistant.choice };
      }
      case 'assistant.options': {
        // What the panel offers: the role's own route, and every harness that runs here with its models and efforts.
        const role = this.config.roles.get(this.config.settings.assistant)!;
        const views = this.configView().harnesses.filter(h => h.runnable);
        const harnesses = await Promise.all(
          views.map(async h => {
            const m = await this.harnessModels(h.id);
            // Listed by the harness, known to its profile, or used by a role; a name with its effort folded in shows as its model.
            const used = [...this.config.roles.values()].filter(r => r.harness === h.id && r.model).map(r => r.model);
            const models = [...new Set([...m.models, ...h.models, ...used])].filter(x => !m.variants[x]);
            return { id: h.id, title: h.title, models, efforts: m.efforts, anyEffort: m.anyEffort ?? null };
          }),
        );
        return { role: { harness: role.harness, model: role.model, effort: role.effort ?? null }, harnesses };
      }
      case 'assistant.apply':
      case 'assistant.dismiss': {
        const p = this.assistant.proposals.get(s('id') ?? '');
        if (!p) throw new Error(`There's no proposal ${s('id')}.`);
        if (p.status !== 'open') throw new Error(`That proposal was already ${p.status}.`);
        if (b.cmd === 'assistant.dismiss') {
          p.status = 'dismissed';
          this.assistantLog('assistant.proposal_done', { id: p.id, status: p.status });
          return { result: 'Dismissed.' };
        }
        const r = await this.command(p.command);
        p.status = 'applied';
        this.assistantLog('assistant.proposal_done', { id: p.id, status: p.status, result: r.result ?? null });
        return r;
      }
      case 'harness.check': {
        const p = loadProfiles(this.configDirs).get(s('harness') ?? '');
        if (!p) throw new Error(`There's no harness profile called ${s('harness')}.`);
        const { inspect } = await import('./harnesses.ts');
        return { report: await inspect(p) };
      }
      case 'harness.models': {
        const harness = s('harness');
        if (!harness) throw new Error('harness.models needs "harness".');
        return { ...(await this.harnessModels(harness, b.refresh === true)) };
      }
      default:
        throw new Error(`Unknown command "${String(b.cmd)}". Commands: goal.start, goal.pause, goal.resume, goal.end, goal.clean, goal.delete, goal.sizes, goal.open_folder, agent.message, agent.spawn, agent.pause, agent.resume, agent.stop, agent.open_native, inbox.resolve, harness.test, harness.check, harness.models, limits.check, config.get, settings.save, role.builtin, role.update, assistant.ask, assistant.reset, assistant.state, assistant.set, assistant.make_default, assistant.options, assistant.apply, assistant.dismiss, role.save, role.delete, workflow.save, workflow.delete, rule.save, rule.delete, guide.save, mcp.save.`);
    }
  }

  /* ---------------- configuration from clients ---------------- */

  /** Reads the config files again: what's saved applies to agents started from now on. */
  reloadConfig(): void {
    this.config = loadConfig(this.configDirs, { repo: this.repo });
    if (this.settingsOverride) Object.assign(this.config.settings, this.settingsOverride);
    this.design = new DesignTracker(this.home, new Outliner(this.config.languages));
    this.highlighted.clear();
  }

  /** Roles, workflows, guidelines and MCP servers with the folder each comes from, plus the harnesses a role can name. */
  configView() {
    const profiles = loadProfiles(this.configDirs);
    // The scripted harness is for tests and demos, never a role's own choice.
    const ids = new Set([...profiles.keys(), ...Object.keys(this.adapters).filter(id => id !== 'fake')]);
    const harnesses = [...ids].map(id => ({
      id,
      title: profiles.get(id)?.title ?? id,
      /** MetaHarness can run it here: it's installed and has a transport. */
      runnable: !!this.adapters[id],
      models: profiles.get(id)?.models ?? [],
      transport: profiles.get(id)?.transport ?? null,
      manifest: this.adapters[id]?.manifest ?? null,
      install: profiles.get(id)?.install ?? null,
      login: profiles.get(id)?.login ?? null,
    }));
    const settings = {
      effective: this.config.settings,
      files: scopesOf(this.configDirs).map(s => ({ scope: s.scope, dir: s.dir, values: readSettingsFile(s.dir) })),
    };
    const casts = [...this.config.casts.values()].map(c => ({ name: c.name, goodAt: c.goodAt, participants: c.participants }));
    const responsibilities = RESPONSIBILITIES.map(r => ({ name: r.name, text: r.text, roles: r.roles, makes: r.makes }));
    return { ...configView(scopesOf(this.configDirs)), harnesses, settings, casts, responsibilities, override: this.harnessOverride ?? null };
  }

  /** The models a harness offers: those its profile knows, plus what its CLI lists (asked once every ten minutes). */
  /**
   * A harness's models for the role editor, each with the efforts it takes. Models listed once
   * per effort (Antigravity's) are folded into one; `variants` maps each such name to its parts.
   */
  async harnessModels(id: string, refresh = false): Promise<ModelChoices> {
    const p = loadProfiles(this.configDirs).get(id);
    if (!p) return { harness: id, models: [], efforts: {}, variants: {}, error: `There's no harness profile called ${id}.` };
    const cached = this.modelLists.get(id);
    if (cached && !refresh && Date.now() - cached.at < 600_000) return cached.choices;
    const { findBin, asModelList } = await import('./harnesses.ts');
    const bin = findBin(p.bin);
    let models = [...(p.models ?? [])];
    let listed: Record<string, string[]> = {};
    let error: string | undefined;
    if (bin && p.listModels) {
      try {
        const r = asModelList(await p.listModels(bin, { ...process.env, ...p.env }));
        models = [...new Set([...models, ...r.models])];
        listed = r.efforts;
      } catch (e) {
        error = (e as Error).message;
      }
    } else if (!bin) error = `${p.bin} isn't installed here.`;
    const folded = foldEfforts(models);
    const efforts: Record<string, string[]> = {};
    for (const m of folded.models) {
      const e = listed[m] ?? folded.efforts[m] ?? p.efforts;
      if (e?.length) efforts[m] = e;
    }
    const choices = { harness: id, models: folded.models, efforts, variants: folded.variants, ...(p.efforts ? { anyEffort: p.efforts } : {}), error: error ?? null };
    this.modelLists.set(id, { at: Date.now(), choices });
    return choices;
  }

  /**
   * A file in a goal's shared folder: its latest text, or one version from .history/, with the
   * versions kept. Paths outside the folder are refused.
   */
  /* ---------------- git and design views (design §14) ---------------- */

  /** A goal's git state: live, or from its log for a goal this daemon didn't start. */
  goalGit(goalId: string): git.GoalGit | undefined {
    return this.goals.get(goalId)?.git ?? this.pastGoalGit(goalId);
  }

  private pastGoalGit(goalId: string): git.GoalGit | undefined {
    const start = this.store.ofType('goal.started').find(e => e.goal === goalId);
    const { dir, branch, base } = (start?.data ?? {}) as { dir?: string; branch?: string; base?: string };
    if (!dir || !base || !existsSync(dir)) return undefined;
    const gs = git.setupGoal(dir, goalId);
    return 'reason' in gs ? undefined : { ...gs, branch: branch ?? gs.branch, base };
  }

  /** The agents with a worktree, live or from the log. */
  private worktreesOf(goalId: string): { agent: string; path: string; branch: string; base: string }[] {
    const live = this.goals.get(goalId);
    if (live) return [...live.agents.values()].filter(a => a.worktree).map(a => ({ agent: a.name, ...a.worktree! }));
    const r = replayGoal(this.store.since(goalId));
    return r ? [...r.agents.values()].filter(a => a.worktree).map(a => ({ agent: a.name, ...a.worktree! })) : [];
  }

  /** Branches, how far each is ahead of or behind the goal branch, and uncommitted work: the Git view's header. */
  gitView(goalId: string) {
    const gg = this.goalGit(goalId);
    if (!gg) return { git: null, note: this.goals.get(goalId)?.gitNote ?? 'No git repository for this goal (or it has gone).' };
    const tip = git.resolveCommit(gg, gg.branch) ?? gg.base;
    const dir = this.goals.get(goalId)?.dir ?? gg.repo;
    const branches = this.worktreesOf(goalId).map(w => {
      const t = git.resolveCommit(gg, w.branch);
      return {
        name: w.branch, agent: w.agent, base: w.base, tip: t ?? null,
        ahead: t ? git.countCommits(gg, tip, t) : 0, behind: t ? git.countCommits(gg, t, tip) : 0,
        uncommitted: existsSync(w.path) ? git.statusShort(w.path).length : null, worktree: existsSync(w.path) ? w.path : null,
      };
    });
    const conflicts = [...(this.goals.get(goalId)?.conflicts.entries() ?? [])].map(([d, c]) => ({ dir: d, ...c }));
    // The latest snapshot's areas, so each commit can say which parts of the design it touched.
    const last = this.design.list(goalId).at(-1);
    const areas = last ? this.design.cached(goalId, last.sha)?.map.areas.map(a => ({ path: a.path, title: a.title })) : undefined;
    return {
      git: { repo: gg.repo, branch: gg.branch, base: gg.base, tip, commits: git.countCommits(gg, gg.base, tip), uncommitted: git.statusShort(dir).length },
      branches, conflicts, mapFile: MAP_FILE, areas: areas ?? [],
    };
  }

  /** A diff for the Git view: one commit, a range, the whole goal, or an agent's uncommitted work. */
  diffView(goalId: string, q: { sha?: string; from?: string; to?: string; agent?: string; whole?: boolean; paths?: string[] }) {
    const gg = this.goalGit(goalId);
    if (!gg) throw new Error('No git repository for this goal.');
    const rev = (r: string) => {
      const sha = /^[\w./@^~-]+$/.test(r) && !r.startsWith('-') ? git.resolveTreeish(gg, r) : undefined;
      if (!sha) throw new Error(`There's no commit or branch "${r}".`);
      return sha;
    };
    if (q.sha) return { title: `${q.sha.slice(0, 7)} ${git.subject(gg, rev(q.sha))}`, files: git.commitDiff(gg, rev(q.sha)) };
    if (q.whole) {
      const tip = git.resolveCommit(gg, gg.branch) ?? gg.base;
      return { title: `Everything on ${gg.branch} since the goal started`, files: git.rangeDiff(gg, gg.base, tip) };
    }
    if (q.from && q.to) return { title: `${q.from.slice(0, 7)} → ${q.to.slice(0, 7)}`, files: git.rangeDiff(gg, rev(q.from), rev(q.to), q.paths) };
    if (q.agent) {
      const w = this.worktreesOf(goalId).find(x => x.agent === q.agent);
      const dir = w?.path ?? this.goals.get(goalId)?.dir ?? gg.repo;
      if (!existsSync(dir)) throw new Error(`${q.agent}'s worktree has been removed.`);
      return { title: w ? `Uncommitted in ${q.agent}'s worktree` : 'Uncommitted in your checkout', shared: !w, files: git.workingDiff(dir) };
    }
    throw new Error('Say which diff: sha, from and to, whole, or agent.');
  }

  /** The design at a commit (default: the latest snapshot, else the goal branch now), with the timeline. */
  async designView(goalId: string, rev?: string) {
    const gg = this.goalGit(goalId);
    if (!gg) return { snapshot: null, list: [], note: 'No git repository for this goal, so no design to show.' };
    const list = this.design.list(goalId);
    const tip = git.resolveCommit(gg, gg.branch) ?? gg.base;
    const sha = !rev ? (list.at(-1)?.sha ?? tip) : rev === 'now' ? tip : /^[\w./@^~-]+$/.test(rev) && !rev.startsWith('-') ? git.resolveCommit(gg, rev) : undefined;
    if (!sha) throw new Error(`There's no commit or branch "${rev}".`);
    const dir = this.goals.get(goalId)?.dir ?? gg.repo;
    return {
      snapshot: await this.design.get(goalId, gg, dir, sha), list, tip,
      languages: [...this.config.languages.values()].map(p => ({ name: p.name, extensions: p.extensions, engine: p.grammar ? 'tree-sitter' : 'patterns', builtIn: p.builtIn })),
    };
  }

  async designCompare(goalId: string, from: string, to: string) {
    const gg = this.goalGit(goalId);
    if (!gg) throw new Error('No git repository for this goal.');
    const dir = this.goals.get(goalId)?.dir ?? gg.repo;
    const sha = (r: string) => {
      const s = /^[\w./@^~-]+$/.test(r) && !r.startsWith('-') ? git.resolveCommit(gg, r) : undefined;
      if (!s) throw new Error(`There's no commit or branch "${r}".`);
      return s;
    };
    const [a, b] = await Promise.all([this.design.get(goalId, gg, dir, sha(from)), this.design.get(goalId, gg, dir, sha(to))]);
    return compareDesigns(a, b);
  }

  /**
   * The Design view's scope (design §14): the design after a piece of work, what it changed
   * against the design before, its commits and its report. A scope is the whole goal
   * (optionally with the agents' unmerged branches merged in, as a picture), one commit, an
   * agent's branch, or a range between two commits.
   */
  async designScope(goalId: string, q: { kind?: string; sha?: string; from?: string; to?: string; agent?: string; branches?: boolean; title?: string }) {
    const gg = this.goalGit(goalId);
    if (!gg) return { snapshot: null, list: [], note: 'No git repository for this goal, so no design to show.' };
    const dir = this.goals.get(goalId)?.dir ?? gg.repo;
    const list = this.design.list(goalId);
    const tip = git.resolveCommit(gg, gg.branch) ?? gg.base;
    const rev = (r: string) => {
      const s = /^[\w./@^~-]+$/.test(r) && !r.startsWith('-') ? git.resolveTreeish(gg, r) : undefined;
      if (!s) throw new Error(`There's no commit or branch "${r}".`);
      return s;
    };
    const short = (s: string) => s.slice(0, 7);
    let scope: { kind: string; title: string; from: string; to: string; heads: string[] };
    let conflicts: string[] = [];
    let merged: string[] = [];
    const kind = q.kind ?? 'goal';
    if (kind === 'commit') {
      if (!q.sha) throw new Error('A commit scope needs &sha=<commit>.');
      const sha = rev(q.sha);
      scope = { kind, title: `${short(sha)} ${git.subject(gg, sha)}`, from: git.resolveCommit(gg, `${sha}^1`) ?? git.EMPTY_TREE, to: sha, heads: [sha] };
    } else if (kind === 'branch') {
      const w = this.worktreesOf(goalId).find(x => x.agent === q.agent);
      const t = w ? git.resolveCommit(gg, w.branch) : undefined;
      if (!w || !t) throw new Error(`${q.agent ?? 'That agent'} has no branch.`);
      scope = { kind, title: `${w.agent}'s branch`, from: git.mergeBase(gg, tip, t) ?? w.base, to: t, heads: [t] };
    } else if (kind === 'range') {
      if (!q.from || !q.to) throw new Error('A range needs &from=<commit>&to=<commit>.');
      const to = rev(q.to);
      scope = { kind: 'range', title: q.title?.slice(0, 200) || `${short(q.from)} → ${short(q.to)}`, from: rev(q.from), to, heads: git.resolveCommit(gg, to) ? [to] : [] };
    } else {
      scope = { kind: 'goal', title: `Everything on ${gg.branch} since the goal started`, from: gg.base, to: tip, heads: [tip] };
      if (q.branches) {
        const open = this.worktreesOf(goalId)
          .map(w => ({ agent: w.agent, tip: git.resolveCommit(gg, w.branch) }))
          .filter((w): w is { agent: string; tip: string } => !!w.tip && git.countCommits(gg, tip, w.tip) > 0);
        if (open.length) {
          const m = git.mergedTree(gg, tip, open.map(w => w.tip));
          conflicts = m.conflicts;
          merged = open.map(w => w.agent);
          scope = { ...scope, title: `${scope.title}, with ${merged.join(', ')}'s unmerged work`, to: m.tree, heads: [tip, ...open.map(w => w.tip)] };
        }
      }
    }
    const { report, before, after, change } = await this.scopeReport(goalId, gg, dir, scope);
    return {
      scope: { kind: scope.kind, title: scope.title, from: scope.from, to: scope.to, conflicts, merged },
      snapshot: after, change, report, list, tip,
      removedAreas: before.map.areas.filter(a => change.areas.removed.includes(a.path)),
    };
  }

  /** The code graph at a commit or tree (the Systems lens; src/codegraph.ts), the goal branch now by default. */
  async designCode(goalId: string, rev?: string) {
    const gg = this.goalGit(goalId);
    if (!gg) throw new Error('No git repository for this goal.');
    const dir = this.goals.get(goalId)?.dir ?? gg.repo;
    const sha = !rev ? (git.resolveCommit(gg, gg.branch) ?? gg.base) : /^[\w./@^~-]+$/.test(rev) && !rev.startsWith('-') ? git.resolveTreeish(gg, rev) : undefined;
    if (!sha) throw new Error(`There's no commit or branch "${rev}".`);
    return { sha, graph: await this.design.code(goalId, gg, dir, sha) };
  }

  /** A file's text at a commit or tree, for the Systems lens to show a function's code. */
  async designSource(goalId: string, rev: string, path: string) {
    const gg = this.goalGit(goalId);
    if (!gg) throw new Error('No git repository for this goal.');
    const sha = /^[\w./@^~-]+$/.test(rev) && !rev.startsWith('-') ? git.resolveTreeish(gg, rev) : undefined;
    if (!sha) throw new Error(`There's no commit or branch "${rev}".`);
    if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`${path} isn't a path in the repository.`);
    const text = git.showFile(gg, sha, path);
    if (text === undefined) throw new Error(`There's no ${path} at ${sha.slice(0, 7)}.`);
    // Coloured by its language pack's highlights.scm; a commit's file never changes, so it's kept.
    const key = `${sha}\n${path}`;
    let highlights = this.highlighted.get(key);
    if (!highlights) {
      const pack = packFor(this.design.outliner.packs.values(), path);
      highlights = pack ? this.design.outliner.highlight(pack, text).catch(() => undefined) : Promise.resolve(undefined);
      this.highlighted.set(key, highlights);
      if (this.highlighted.size > 200) this.highlighted.delete(this.highlighted.keys().next().value!);
    }
    const h = await highlights;
    return { path, sha, text, ...(h ? { highlights: h } : {}) };
  }

  /** Files coloured for the Design view, by commit and path. */
  private highlighted = new Map<string, Promise<Highlights | undefined>>();

  /** What a file and its definitions say they're for at a commit or tree (their doc comments), for the Design view's hover. */
  async designDocs(goalId: string, rev: string, path: string): Promise<{ path: string; sha: string } & FileDocs> {
    const gg = this.goalGit(goalId);
    if (!gg) throw new Error('No git repository for this goal.');
    const sha = /^[\w./@^~-]+$/.test(rev) && !rev.startsWith('-') ? git.resolveTreeish(gg, rev) : undefined;
    if (!sha) throw new Error(`There's no commit or branch "${rev}".`);
    if (!path || path.startsWith('/') || path.split('/').includes('..')) throw new Error(`${path} isn't a path in the repository.`);
    const key = `${sha}\n${path}`;
    let docs = this.documented.get(key);
    if (!docs) {
      const text = git.showFile(gg, sha, path);
      const pack = packFor(this.design.outliner.packs.values(), path);
      docs = text !== undefined && pack ? this.design.outliner.docs(pack, text).catch(() => undefined) : Promise.resolve(undefined);
      this.documented.set(key, docs);
      if (this.documented.size > 500) this.documented.delete(this.documented.keys().next().value!);
    }
    return { path, sha, ...((await docs) ?? { symbols: [] }) };
  }

  /** Files' doc comments, by commit and path. */
  private documented = new Map<string, Promise<FileDocs | undefined>>();

  /** Builds a scope's report (src/design.ts) and keeps it beside the snapshots. */
  private async scopeReport(goalId: string, gg: git.GoalGit, dir: string, scope: { kind: string; title: string; from: string; to: string; heads: string[] }) {
    const [before, after] = await Promise.all([this.design.get(goalId, gg, dir, scope.from), this.design.get(goalId, gg, dir, scope.to)]);
    const change = compareDesigns(before, after);
    const authors = new Map<string, string>();
    const mergeSizes = new Map<string, { added: number; removed: number; files: number }>();
    for (const e of this.store.since(goalId)) {
      if ((e.type !== 'git.commit' && e.type !== 'git.merge') || !e.data.sha) continue;
      const sha = String(e.data.sha);
      if (e.agent && !authors.has(sha)) authors.set(sha, e.agent);
      if (typeof e.data.added === 'number') mergeSizes.set(sha, { added: e.data.added, removed: Number(e.data.removed) || 0, files: Number(e.data.files) || 0 });
    }
    const report: DesignReport = designReport({
      goal: goalId, scope: { kind: scope.kind, title: scope.title, from: scope.from, to: scope.to }, before, after, change,
      log: scope.heads.length ? git.scopeLog(gg, scope.heads, scope.from) : [], net: git.numstat(gg, scope.from, scope.to), authors, mergeSizes,
    });
    try {
      this.design.saveReport(report);
    } catch {
      // A report that can't be kept is still shown.
    }
    return { report, before, after, change };
  }

  sharedFile(goalId: string, path: string, version?: number) {
    if (!/^[0-9a-f-]+$/i.test(goalId)) throw new Error(`There's no goal ${goalId}.`);
    const dir = this.goals.get(goalId)?.sharedDir ?? join(this.home, 'goals', goalId, 'shared');
    const rel = normalize(path).replace(/^([/\\])+/, '');
    if (!rel || rel.startsWith('..') || rel.split(sep)[0] === HISTORY) throw new Error(`${path} isn't a file in the shared folder.`);
    const histDir = join(dir, HISTORY, rel);
    const versions = existsSync(histDir)
      ? readdirSync(histDir)
          .map(f => /^(\d+)-(.+?)(\.[^.]*)?$/.exec(f))
          .filter((m): m is RegExpExecArray => !!m)
          .map(m => ({ version: Number(m[1]), by: m[2], file: join(histDir, m[0]) }))
          .sort((a, b) => a.version - b.version)
      : [];
    const pick = version !== undefined ? versions.find(v => v.version === version) : undefined;
    if (version !== undefined && !pick) throw new Error(`Version ${version} of ${rel} wasn't kept.`);
    const file = pick?.file ?? join(dir, rel);
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      return { path: rel, version: version ?? null, exists: false, text: null, binary: false, size: 0, versions: versions.map(({ version, by }) => ({ version, by })) };
    }
    const size = statSync(file).size;
    const buf = readFileSync(file).subarray(0, 512 * 1024);
    const binary = buf.includes(0);
    return {
      path: rel, version: pick?.version ?? versions.at(-1)?.version ?? null, exists: true, size, binary,
      text: binary ? null : buf.toString('utf8') + (size > buf.length ? '\n\n[… cut: the file is larger than 512 KB]' : ''),
      versions: versions.map(({ version, by }) => ({ version, by })),
    };
  }

  async close(): Promise<void> {
    clearInterval(this.pollTimer);
    clearInterval(this.limitTimer);
    for (const g of this.goals.values()) {
      g.authorsWatch?.close();
      clearTimeout(g.landing?.timer);
    }
    this.closing = true;
    await this.designIdle();
    const stopping: Promise<unknown>[] = [this.assistant.stop()];
    for (const g of this.goals.values()) {
      if (g.gatekeeper) stopping.push(g.gatekeeper.stop());
      for (const a of g.agents.values()) {
        for (const w of a.waiters) clearTimeout(w.timer);
        clearTimeout(a.limitTimer);
        this.endPause(a);
        this.clearRefresh(a);
        // What the stopping sessions report isn't the agents' doing: the log keeps their state,
        // so the next daemon can resume them (recover).
        a.gen++;
        if (a.session && !FINISHED.includes(a.state)) stopping.push(a.session.stop().catch(() => {}));
      }
    }
    await Promise.all(stopping.map(p => p.catch(() => {})));
    // A few seconds for the CLIs to save and exit; what's left is killed as the process exits.
    await settle(this.closeGraceMs);
    this.store.close();
  }
}

export function formatForAgent(entries: InboxEntry[]): string {
  return entries
    .map(e =>
      e.kind === 'done'
        ? `[MetaHarness] ${e.from} finished: ${e.text}`
        : e.kind === 'notice'
          ? e.text.startsWith('[MetaHarness') ? e.text : `[MetaHarness] ${e.text}`
          : `[MetaHarness] Message from ${e.from}${e.urgent ? ' (urgent)' : ''}: ${e.text}`,
    )
    .join('\n');
}

/** Whether a role's allow list (Claude Code style, e.g. "Bash(npm test*)") covers a shell command. */
/** Who an agent is, for the roles: and harness: lines of rules. */
function ruleAgent(rec: AgentRec): RuleAgent {
  return { role: rec.role.name, helper: rec.quick || rec.role.helper, lead: rec.isLead, harness: rec.harness };
}

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
/** What a role woken by landed work (`wake: landed`) hears: the commits, the files, and how to see the diff. */
export function landedNote(branch: string, from: string, to: string, commits: LandedCommit[], paths: string[]): string {
  const shown = commits.slice(-15);
  return [
    `Work landed on ${branch}: ${commits.length} commit${commits.length === 1 ? '' : 's'}, ${from.slice(0, 7)}..${to.slice(0, 7)}.`,
    ...(commits.length > shown.length ? [`- … ${commits.length - shown.length} earlier`] : []),
    ...shown.map(c => `- ${c.sha.slice(0, 7)} ${c.agent ?? 'unnamed'}: ${c.summary}`),
    `Files: ${paths.slice(0, 30).join(', ')}${paths.length > 30 ? `, and ${paths.length - 30} more` : ''}.`,
    `The changes: \`git diff --stat ${from.slice(0, 12)} ${to.slice(0, 12)}\`, then the diff of the files that matter.`,
  ].join('\n');
}

function depsLines(copied: string[]): string[] {
  if (!copied.length) return [];
  return [
    `- ${copied.join(', ')} ${copied.length > 1 ? 'are copies' : 'is a copy'} of the checkout's, made with hard links, so you can run things straight away. ` +
      `Reinstalling is fine, but don't edit files inside ${copied.length > 1 ? 'them' : 'it'} in place: the human's copy shares them.`,
  ];
}

/** Bytes under a folder, not following links, each hard-linked file once. */
function folderBytes(dir: string, seen = new Set<string>()): number {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += folderBytes(p, seen);
    else if (e.isFile()) {
      try {
        const st = statSync(p);
        const key = `${st.dev}:${st.ino}`;
        if (st.nlink > 1 && seen.has(key)) continue;
        seen.add(key);
        total += st.size;
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return total;
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
