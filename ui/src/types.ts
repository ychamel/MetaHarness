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
}

export interface InboxItem {
  id: string;
  goal: string;
  agent: string;
  kind: 'question' | 'decision' | 'approval' | 'done' | 'stopped' | 'crash';
  text: string;
  ts: string;
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
  accounts: { id: string; status: string; usedPct: number | null; resetsAt: number | null; window: string | null }[];
  harnesses: Record<string, Manifest>;
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
