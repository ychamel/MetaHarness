/** What the daemon's API returns (src/daemon.ts snapshot, listGoals, agentDetail). */

export type AgentState = 'starting' | 'working' | 'waiting' | 'limited' | 'idle' | 'done' | 'ended' | 'crashed' | 'paused';
export type GoalStatus = 'running' | 'done' | 'ended' | 'stopped';

export interface Agent {
  name: string;
  role: string;
  harness: string;
  model: string;
  effort: string | null;
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
  /** Who it's held up by while it waits: the human (an approval, a question, a decision), teammates it started, or whoever it last dealt with. */
  waitingOn: { who: string[]; why: 'approval' | 'question' | 'decision' | 'helpers' | 'partner' } | null;
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
  /** room: a discussion the human leads (no lead agent); its request is the topic. */
  kind: 'goal' | 'room';
  /** A room's branch, where its patches go. */
  roomBranch: string | null;
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
  kind: 'goal' | 'room';
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
  /** built-in: ships with MetaHarness; saving writes a copy into a folder. */
  scope: Scope | 'built-in';
  file: string;
  overrides?: Scope | 'built-in';
  harness: string;
  model: string;
  /** Empty: the harness's default. */
  effort: string;
  fallback: string[];
  goodAt: string;
  instructions: string;
  helper: boolean;
  worktree: boolean;
  workflow: string;
  mcp: string[];
  skills: string[];
  autoApprove: 'read-only' | 'none';
  /** Its own approval mode; empty: the settings'. */
  approvals: string;
  permissionMode: string;
  allow: string[];
  /** Keeps the harness's own skills instead of hiding them. */
  nativeSkills: boolean;
}

export interface WorkflowDef {
  name: string;
  /** built-in: ships with MetaHarness; saving it writes a copy into a folder. */
  scope: Scope | 'built-in';
  file: string;
  overrides?: Scope | 'built-in';
  goodAt: string;
  /** The roles it uses; empty: every role. */
  roles: string[];
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
  /** A skill the note points at. */
  skill?: string;
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

/** Where a skill's folder is: MetaHarness's own, personal, the repository's .metaharness, or another harness's folder in it. */
export type SkillSource = 'built-in' | 'personal' | 'repo' | '.claude' | '.agents';

/** A guide with files that agents read through the skill tool (design §18). */
export interface SkillDef {
  name: string;
  description: string;
  harness: string[];
  body: string;
  dir: string;
  file: string;
  source: SkillSource;
  overrides?: SkillSource;
  on: boolean;
  switchedBy?: Scope;
  files: { path: string; bytes: number }[];
  /** Roles whose skills: name it; empty: every role carries it. */
  carriedBy: string[];
  /** Rules that point at it. */
  pointedBy: string[];
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
  skills: SkillDef[];
  methodology: GuideDef;
  helperMethodology: GuideDef;
  mcp: { name: string; scope: Scope; def: McpDef }[];
  harnesses: HarnessView[];
  settings: { effective: Settings; files: { scope: Scope; dir: string; values: Partial<Settings> }[] };
  /** Every role runs on this harness instead (the daemon was started with --fake). */
  override: string | null;
  /** Saved sets of participants for rooms (casts/<name>.md). */
  casts: Cast[];
  responsibilities: ResponsibilityPreset[];
}

/** One seat in a room: a role, optionally on another harness/model, with a stance. */
export interface Participant {
  /** None: the seat is just a model. */
  role?: string;
  name?: string;
  /** harness/model[@effort] instead of the role's own. */
  on?: string;
  /** What it's for in this room. */
  responsibility?: string;
  stance?: string;
}

/** A responsibility to start a seat from. */
export interface ResponsibilityPreset {
  name: string;
  text: string;
  roles: string[];
}

export interface Cast {
  name: string;
  goodAt: string;
  participants: Participant[];
}

export type AskMode = 'ask' | 'job' | 'views' | 'respond' | 'debate' | 'chain' | 'patch';
export type BoardKind = 'finding' | 'question' | 'decision' | 'file';

export interface BoardItem {
  id: string;
  kind: BoardKind;
  text: string;
  by: string;
  closed?: boolean;
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
  coordinator: string;
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

/* ---------------- Git and Design views (design §14) ---------------- */

export interface GitBranch {
  name: string;
  agent: string;
  base: string;
  tip: string | null;
  /** Commits on it that the goal branch doesn't have, and the other way round. */
  ahead: number;
  behind: number;
  /** Files changed and not committed in its worktree; null once the worktree is gone. */
  uncommitted: number | null;
  worktree: string | null;
}

export interface GitView {
  git: { repo: string; branch: string; base: string; tip: string; commits: number; uncommitted: number } | null;
  note?: string;
  branches?: GitBranch[];
  conflicts?: { dir: string; op: string; branch: string; agent?: string }[];
  mapFile?: string;
  /** The latest design snapshot's areas, to say which parts each commit touched. */
  areas?: { path: string; title: string }[];
}

export interface DiffFile {
  path: string;
  from?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
  binary: boolean;
  patch: string;
  cut?: boolean;
}

export interface DiffView {
  title: string;
  /** Uncommitted work in the human's checkout: anyone's. */
  shared?: boolean;
  files: DiffFile[];
}

export interface DesignSymbol {
  kind: string;
  name: string;
  parent?: string;
  line: number;
  end?: number;
  hash: string;
}

export interface DesignArea {
  path: string;
  title: string;
  summary: string;
  unmapped?: boolean;
}

export interface DesignFile {
  path: string;
  size: number;
  blob: string;
  area: string;
  lang?: string;
  symbols?: DesignSymbol[];
  imports?: string[];
}

export interface DesignSnapshot {
  sha: string;
  at: string;
  map: { file: string | null; overview: string; areas: DesignArea[]; flows?: DesignFlow[] };
  files: DesignFile[];
  edges: { from: string; to: string; n: number }[];
  skipped: number;
  problems: string[];
}

export interface ChangeSummary {
  areas: number;
  edges: number;
  files: number;
  symbols: number;
  highlights: string[];
}

export interface SnapshotInfo {
  sha: string;
  at: string;
  kind: 'start' | 'landed' | 'asked';
  by?: string[];
  summaries?: string[];
  change?: ChangeSummary;
}

export interface DesignView {
  snapshot: DesignSnapshot | null;
  list: SnapshotInfo[];
  tip?: string;
  note?: string;
  languages?: { name: string; extensions: string[]; engine: string; builtIn: boolean }[];
}

export interface DesignFlow {
  name: string;
  steps: { label: string; area?: string }[];
  text: string;
}

export interface SymbolRef {
  file: string;
  kind: string;
  name: string;
  parent?: string;
  area: string;
  line?: number;
  end?: number;
}

export interface DesignChange {
  areas: { added: string[]; removed: string[]; rewritten: string[] };
  edges: { added: { from: string; to: string }[]; removed: { from: string; to: string }[] };
  files: { added: string[]; removed: string[]; changed: string[] };
  symbols: { added: SymbolRef[]; removed: SymbolRef[]; changed: SymbolRef[] };
  overviewChanged: boolean;
}

/** What the Design view looks at: the whole goal, one commit, an agent's branch, or a range (a landing is one). */
export type ScopeSel =
  | { kind: 'goal'; branches?: boolean }
  | { kind: 'commit'; sha: string }
  | { kind: 'branch'; agent: string }
  | { kind: 'range'; from: string; to: string; title: string };

export interface ScopeCommit {
  sha: string;
  at: string;
  summary: string;
  agent?: string;
  merge: boolean;
  added: number;
  removed: number;
  files: number;
  areas: string[];
  paths: string[];
}

export interface AreaChange {
  path: string;
  added: number;
  removed: number;
  files: number;
  commits: number;
  agents: { name: string; commits: number }[];
  symbols: { added: number; changed: number; removed: number };
  hotspot: number;
}

export interface FileChange {
  path: string;
  area: string;
  added: number;
  removed: number;
  churn: number;
  commits: number;
  agents: string[];
  size: number;
  usedBy: number;
  score: number;
  reasons: string[];
}

export interface DesignReport {
  goal: string;
  scope: { kind: string; title: string; from: string; to: string };
  at: string;
  totals: { commits: number; files: number; added: number; removed: number; agents: string[] };
  commits: ScopeCommit[];
  areas: AreaChange[];
  files: FileChange[];
  hotspots: string[];
  cycles: { areas: string[]; new: boolean }[];
  edges: DesignChange['edges'];
  coupling: { area: string; uses: number; usedBy: number }[];
  flows: { name: string; unknown: string[]; unbacked: [string, string][] }[];
}

export interface DesignScopeView {
  scope?: { kind: string; title: string; from: string; to: string; conflicts: string[]; merged: string[] };
  snapshot: DesignSnapshot | null;
  change?: DesignChange;
  report?: DesignReport;
  removedAreas?: DesignArea[];
  list: SnapshotInfo[];
  tip?: string;
  note?: string;
}

/** What a file and its definitions say they're for: their doc comments (src/languages.ts). */
export interface FileDocs {
  doc?: string;
  symbols: { kind: string; name: string; parent?: string; line: number; doc?: string }[];
}

/** A file's code as coloured spans (src/languages.ts): the kinds by name, and per line flat [start, end, kind] triples. */
export interface Highlights {
  kinds: string[];
  lines: number[][];
}

/* ---------------- the Systems lens: the code graph (src/codegraph.ts) ---------------- */

export type CodeEdgeKind = 'call' | 'new' | 'emit' | 'listen' | 'read' | 'write';

export interface CodeClass {
  id: string;
  name: string;
  file: string;
  area: string;
  line: number;
  end: number;
  kind: 'class' | 'autoload' | 'script' | 'inner';
  ext?: string;
  base?: string;
  main?: true;
  doc?: string;
}

export interface CodeFn {
  id: string;
  cls: string;
  name: string;
  file: string;
  line: number;
  end: number;
  static?: true;
  engine?: true;
  mut?: true;
  doc?: string;
}

export interface CodeSignal {
  id: string;
  cls: string;
  name: string;
  line: number;
}

export interface CodeField {
  id: string;
  cls: string;
  name: string;
  line: number;
  const?: true;
}

export interface CodeEdge {
  f: string;
  t: string;
  k: CodeEdgeKind;
  l: number;
  /** The other lines it's on. */
  ls?: number[];
  n?: number;
  via?: string;
  g?: true;
  lam?: true;
}

export interface CodeGraph {
  version: number;
  classes: CodeClass[];
  fns: CodeFn[];
  signals: CodeSignal[];
  fields: CodeField[];
  edges: CodeEdge[];
  entries: string[];
  stats: { files: number; calls: number; resolved: number; guessed: number; unresolved: number; missed: { chain: string; n: number }[] };
  /** Groups of classes the map's Systems section names. */
  systems?: { name: string; classes: string[]; text: string }[];
}
