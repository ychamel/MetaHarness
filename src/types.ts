export type AgentState =
  | 'starting'
  | 'working'
  | 'waiting'
  | 'limited'
  | 'idle'
  | 'done'
  | 'ended'
  | 'crashed'
  | 'paused';

/** One entry in the append-only event log. Everything the UI and CLI show comes from these. */
export interface MhEvent {
  seq: number;
  ts: string;
  goal: string;
  agent?: string;
  parent?: string;
  type: string;
  data: Record<string, unknown>;
}

export type NewEvent = Omit<MhEvent, 'seq' | 'ts' | 'data'> & { data?: Record<string, unknown> };

/** A teammate type, loaded from .metaharness/roles/<name>.md */
export interface Role {
  name: string;
  harness: string;
  model: string;
  /** Backups, best first, for when the model is unavailable or its account is at its limit: "harness/model", or just "model" on the same harness. */
  fallback: string[];
  goodAt: string;
  instructions: string;
  /** Quick-helper roles get the short helper methodology instead of the team one. */
  helper: boolean;
  /** Harness tool patterns allowed without asking, e.g. "Bash(npm test*)" for Claude Code. */
  allow: string[];
  /** read-only (default): shell commands that only read are approved without asking. none: always ask. */
  autoApprove: 'read-only' | 'none';
  /** The harness's own permission mode, e.g. acceptEdits for Claude Code. */
  permissionMode?: string;
  /** MCP servers this role may use besides MetaHarness's own, by name (resolved on each machine). */
  mcp: string[];
  /** A workflow this role follows; it goes into the agent's prompt. */
  workflow?: string;
  /** Give agents in this role their own git worktree by default, instead of the shared folder. */
  worktree: boolean;
  /** How this role's approvals are decided, instead of the settings' default. */
  approvals?: import('./settings.ts').ApprovalMode;
  file: string;
}

/** A guide for running one kind of task: .metaharness/workflows/<name>.md */
export interface Workflow {
  name: string;
  goodAt: string;
  body: string;
  file: string;
  /** Ships with MetaHarness (defaults/workflows/); a folder's file of the same name replaces it. */
  builtIn?: boolean;
}
