import type { McpServerRef } from '../mcpservers.ts';
import type { Role } from '../types.ts';

/** What a harness can do. The daemon never assumes a feature the manifest doesn't claim. */
export interface CapabilityManifest {
  harness: string;
  /** A message can be added to a turn that is already running. */
  injectMidTurn: boolean;
  /**
   * The adapter collects waiting messages itself at points in a running turn (a hook before each
   * model call, a command's output) by calling SessionEvents.pull.
   */
  pullsMessages?: boolean;
  /** A finished session can take a new turn later. */
  resume: boolean;
  interrupt: boolean;
  reportsCost: boolean;
  reportsContext: boolean;
  /** Reports how close its account is to a rate limit before it's hit. */
  reportsRateLimits: boolean;
}

/** Where an account stands against its subscription's rate limit. */
export interface RateLimitInfo {
  /** ok: under the limit; warning: close to it; limited: refused until resetsAt. */
  status: 'ok' | 'warning' | 'limited';
  /** Percent of the limiting window used, if known. */
  usedPct?: number;
  /** When the limiting window resets, in ms since the epoch. */
  resetsAt?: number;
  /** Which window, e.g. five_hour or seven_day. */
  window?: string;
}

export type ToolCaller = (tool: string, args: unknown) => Promise<string>;

export interface SessionSpec {
  goal: string;
  agent: string;
  role: Role;
  model: string;
  systemPrompt: string;
  /** The first user message: the brief written by whoever spawned this agent. */
  brief: string;
  cwd: string;
  sharedDir: string;
  /** Git directories a commit in cwd writes to (the shared .git and the worktree's own). Empty without a worktree. */
  gitDirs: string[];
  /** Where a real harness reaches our tools over MCP. Empty until the MCP layer exists. */
  mcpUrl: string;
  /** Where the agent's hooks reach the daemon (POST a HookRequest). Empty without a server. */
  hookUrl: string;
  /** A directory of the agent's own, outside its worktree, for harness config such as hooks. */
  agentDir: string;
  /** MCP servers the role may use besides ours (its `mcp:` names). Without a `def`, the harness's own config must have one by that name. */
  mcpServers: McpServerRef[];
  /** In-process access to the same tools (used by the fake adapter and tests). */
  callTool: ToolCaller;
  /** Environment for the commands the agent runs: the git guard (src/guard.ts). */
  env?: Record<string, string>;
  /** It works in the human's checkout, shared with teammates, rather than its own worktree. */
  sharedCheckout?: boolean;
  /** Command prefixes it may never run, for the harness's own deny list (src/guard.ts). */
  deniedCommands?: string[];
}

/** Callbacks an adapter uses to report what its harness is doing. */
export interface SessionEvents {
  turnStarted(): void;
  turnEnded(): void;
  text(text: string): void;
  toolCall(tool: string, summary: string): void;
  toolResult(summary: string, ok: boolean): void;
  /** Totals so far for this session. */
  usage(u: { tokensIn?: number; tokensOut?: number; costUsd?: number; contextPct?: number }): void;
  exited(reason: 'stopped' | 'crashed', detail?: string): void;
  /** The account's rate-limit state changed, or a turn was refused because of it. */
  rateLimit(info: RateLimitInfo): void;
  /** The harness wants permission for something. Resolves when the human decides. */
  approval(tool: string, detail: string): Promise<ApprovalDecision>;
  /** A tool call for the approval policy: allowed, refused, or the human decides. */
  decide(t: ToolRequest): Promise<ApprovalDecision>;
  /** Messages waiting for the agent, taken for the running turn; undefined if there are none. */
  pull(): string | undefined;
}

export interface ApprovalDecision {
  allow: boolean;
  message?: string;
}

export interface Session {
  /** The harness's own session ID, used to resume or attach to it. */
  nativeId: string;
  /** True while a turn is running. */
  busy(): boolean;
  /** 'inject' adds to the running turn; 'new_turn' starts (or resumes) a turn with this text. */
  send(text: string, how: 'inject' | 'new_turn'): Promise<void>;
  interrupt?(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Resume this native session instead of starting a new one. The brief is then sent as the next turn. */
  resume?: string;
}

export interface HarnessAdapter {
  manifest: CapabilityManifest;
  start(spec: SessionSpec, events: SessionEvents, opts?: StartOptions): Promise<Session>;
  /**
   * The account a model's usage counts against, when one login has several quotas (Antigravity
   * has one for Gemini and one for Claude and GPT models). Default: one account per harness.
   */
  account?(model: string): string;
  /** What a tool call means, for harnesses whose hooks ask MetaHarness before each tool runs. */
  toolRequest?(tool: string, args: Record<string, unknown>): ToolRequest;
}

/**
 * A tool call as the approval policy sees it. read: never needs asking. edit: allowed inside
 * the agent's own directories. shell: allowed when the role allows the command. delegate and
 * ask_user: refused, because MetaHarness provides those (spawn, send to human).
 */
export interface ToolRequest {
  kind: 'read' | 'edit' | 'shell' | 'mcp' | 'delegate' | 'ask_user' | 'other';
  /** Name shown to the human, e.g. Bash or Edit. */
  tool: string;
  detail: string;
  path?: string;
  /** For mcp: the server the tool belongs to. */
  server?: string;
}

/** What a harness hook sends the daemon. */
export type HookRequest = { event: 'before_model' } | { event: 'before_tool'; tool: string; args: Record<string, unknown> };
