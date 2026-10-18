/** What the daemon's API returns (src/daemon.ts snapshot, listGoals, agentDetail). */

export type AgentState = 'starting' | 'working' | 'waiting' | 'limited' | 'idle' | 'done' | 'ended' | 'crashed' | 'paused';
export type GoalStatus = 'running' | 'done' | 'ended' | 'stopped';

export interface Agent {
  name: string;
  role: string;
  harness: string;
  model: string;
  parent: string;
  state: AgentState;
  pausing: boolean;
  status: string;
  brief: string;
  quick: boolean;
  branch: string | null;
  worktree: string | null;
  cwd: string;
  cost: number | null;
  contextPct: number | null;
  unread: number;
  awaitingApproval: number;
  nativeSession: string | null;
  limitedUntil: number | null;
  doneNote: string | null;
  tokens: Tokens | null;
  costSplit: CostSplit | null;
  /** harness: reported by the harness; prices: estimated from the settings' prices. */
  costSource: 'harness' | 'prices' | null;
  /** When it last called its model, and until when its prompt cache stays warm (ms). */
  lastCallAt: number | null;
  cacheMinutes: number;
  cacheUntil: number | null;
}

export interface Tokens {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Goal {
  id: string;
  request: string;
  status: GoalStatus;
  live: boolean;
  lead: string;
  createdAt: string;
  dir: string;
  sharedDir: string;
  branch: string | null;
  workflow: string | null;
  notice: string | null;
  cost: number | null;
  agents: Agent[];
  /** What the approvals gatekeeper spent on this goal. */
  gatekeeperCost: number | null;
}

export interface InboxItem {
  id: string;
  goal: string;
  agent: string;
  kind: 'question' | 'decision' | 'approval' | 'done' | 'stopped' | 'crash' | 'stalled';
  text: string;
  ts: string;
  /** Why it came to you, e.g. what the gatekeeper said. */
  note?: string;
}

export interface Manifest {
  harness: string;
  injectMidTurn: boolean;
  pullsMessages?: boolean;
  resume: boolean;
  interrupt: boolean;
  reportsCost: boolean;
  reportsContext: boolean;
  reportsRateLimits: boolean;
}

export interface Snapshot {
  goals: Goal[];
  inbox: InboxItem[];
  roles: { name: string; harness: string; model: string; goodAt: string; helper: boolean; worktree: boolean }[];
  workflows: { name: string; goodAt: string }[];
  accounts: Account[];
  limitChecks: LimitCheck[];
  harnesses: Record<string, Manifest>;
}

/** One harness login, or one of its quota pools, against its plan's limits. */
export interface Account {
  id: string;
  status: 'ok' | 'warning' | 'limited';
  /** The fullest window. */
  usedPct: number | null;
  resetsAt: number | null;
  window: string | null;
  note?: string | null;
  /** Every window: 5h, 7d, 7d sonnet… */
  windows: { name: string; usedPct: number; resetsAt?: number }[];
  checkedAt: number | null;
}

/** The last time a harness was asked for its limits. */
export interface LimitCheck {
  harness: string;
  at: number | null;
  error: string | null;
  checking: boolean;
}

export interface GoalSummary {
  id: string;
  request: string;
  status: GoalStatus;
  live: boolean;
  createdAt: string;
  dir: string;
  lead: string;
  cost: number | null;
  agents: number;
  working: number;
  branch: string | null;
  workflow: string | null;
  /** The lead's done note: what the goal came to. */
  result: string | null;
  inbox: number;
  needs: number;
}

export type Scope = 'personal' | 'repo';

export interface RoleDef {
  name: string;
  scope: Scope;
  file: string;
  overrides?: Scope;
  harness: string;
  model: string;
  fallback: string[];
  goodAt: string;
  instructions: string;
  helper: boolean;
  worktree: boolean;
  workflow: string;
  mcp: string[];
  autoApprove: 'read-only' | 'none';
  /** Its own approval mode; empty: the settings'. */
  approvals: string;
  permissionMode: string;
  allow: string[];
}

export interface WorkflowDef {
  name: string;
  /** built-in: ships with MetaHarness; saving it writes a copy into a folder. */
  scope: Scope | 'built-in';
  file: string;
  overrides?: Scope | 'built-in';
  goodAt: string;
  body: string;
}

export type RuleWhen = 'start' | 'path' | 'new-file' | 'commit' | 'done';
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** A note MetaHarness hands agents at a moment it can see (design §18). */
export interface RuleDef {
  name: string;
  scope: Scope | 'built-in';
  file: string;
  overrides?: Scope | 'built-in';
  when: RuleWhen;
  description: string;
  body: string;
  roles: string[];
  paths: string[];
  sections?: string;
  include?: string;
  requires?: string;
  missing?: string;
  changes: ChangeKind[];
  unlessChanged?: string;
  edited: boolean;
  /** What agents get: false when its file or the settings turn it off. */
  on: boolean;
  fileOff: boolean;
  /** The folder whose settings.json switches it, if one does. */
  switchedBy?: Scope;
}

export interface GuideDef {
  text: string;
  from: Scope | 'built-in';
  builtIn: string;
  files: Partial<Record<Scope, string>>;
}

export interface McpDef {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ConfigView {
  scopes: { scope: Scope; dir: string }[];
  roles: RoleDef[];
  workflows: WorkflowDef[];
  rules: RuleDef[];
  methodology: GuideDef;
  helperMethodology: GuideDef;
  mcp: { name: string; scope: Scope; def: McpDef }[];
  harnesses: HarnessView[];
  settings: { effective: Settings; files: { scope: Scope; dir: string; values: Partial<Settings> }[] };
  /** Every role runs on this harness instead (the daemon was started with --fake). */
  override: string | null;
}

export interface SharedFileView {
  path: string;
  version: number | null;
  exists: boolean;
  text: string | null;
  binary: boolean;
  size: number;
  versions: { version: number; by: string }[];
}

export interface AgentDetail {
  goal: string;
  name: string;
  role: string;
  harness: string;
  model: string;
  parent: string;
  brief: string;
  systemPrompt: string | null;
  cwd: string;
  worktree: { path: string; branch: string; base: string; deps?: string[] } | null;
  nativeSession: string | null;
  open: { command?: string; note: string } | null;
  roleFile?: string;
  live: boolean;
}

export interface MhEvent {
  seq: number;
  ts: string;
  goal: string;
  agent?: string;
  parent?: string;
  type: string;
  data: Record<string, any>;
}

export interface HarnessView {
  id: string;
  title: string;
  runnable: boolean;
  models: string[];
  transport: string | null;
  manifest: Manifest | null;
  install: string | null;
  login: string | null;
}

export interface Prices {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelSettings {
  prices?: Prices;
  cacheMinutes?: number;
}

export type ApprovalMode = 'ask' | 'gatekeeper' | 'harness';

export interface Settings {
  approvals: ApprovalMode;
  gatekeeper: string;
  assistant: string;
  cacheReminders: boolean;
  cacheRemindSec: number;
  cacheRemindMinTokens: number;
  defaultCacheMinutes: number;
  limitCheckMinutes: number;
  contextHandoffPct: number;
  stallMinutes: number;
  models: Record<string, ModelSettings>;
  rules: Record<string, boolean>;
}

export interface HarnessReport {
  id: string;
  title: string;
  path?: string;
  version?: string;
  login?: { signedIn?: boolean; plan?: string; detail?: string };
  models: string[];
  modelsError?: string;
  install?: string;
  loginCommand?: string;
}
