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
  /** The harness's own permission mode, e.g. acceptEdits for Claude Code. */
  permissionMode?: string;
  file: string;
}
