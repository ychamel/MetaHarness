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
  /** Its agents can search the web (a room's makers are picked by it). */
  web?: boolean;
  /** Its agents can generate images. */
  images?: boolean;
}

/** Where an account stands against its subscription's rate limit. */
export interface RateLimitInfo {
  /** ok: under the limit; warning: close to it; limited: refused until resetsAt. */
  status: 'ok' | 'warning' | 'limited';
  /** Percent of the limiting window used, if known. */
  usedPct?: number;
  /** When the limiting window resets, in ms since the epoch. */
  resetsAt?: number;
  /** Which window, e.g. 5h or 7d. */
  window?: string;
  /** Anything else the human should know, e.g. that the plan's limit is passed and credits are paying. */
  note?: string;
  /** Every window the plan has (the five-hour one, the weekly one…), when the harness says. */
  windows?: LimitWindow[];
}

/** One window of a plan's limit. */
export interface LimitWindow {
  /** 5h, 7d, or 7d with what it covers (7d sonnet, argon 7d), so updates from a turn match what a check found. */
  name: string;
  usedPct: number;
  resetsAt?: number;
}

/** A session's token totals so far, its cost if the harness reports one, and how full its context is. */
export interface Usage {
  tokensIn?: number;
  tokensOut?: number;
  /** Input read from the provider's prompt cache. */
  cacheRead?: number;
  /** Input written to the prompt cache (Anthropic charges extra for it). */
  cacheWrite?: number;
  costUsd?: number;
  /** The cost split by kind of token, when the harness knows it (Claude Code's per-model costs). */
  costSplit?: CostSplit;
  contextPct?: number;
  /** Tokens in the context at the last model call: what an expired cache makes it pay for again. */
  contextTokens?: number;
  /** How long the provider keeps this session's prompt cache, when the harness says (Claude Code: 5 or 60). */
  cacheMinutes?: number;
}

/** Dollars by kind of token. */
export interface CostSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ToolCaller = (tool: string, args: unknown) => Promise<string>;

export interface SessionSpec {
  goal: string;
  agent: string;
  role: Role;
  model: string;
  /** How hard the model should think (low, medium, high…); the adapter passes the nearest level its harness has. */
  effort?: string;
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
  /** harness: use the harness's own automatic approvals where it has them. */
  approvals?: import('../settings.ts').ApprovalMode;
}

/** Callbacks an adapter uses to report what its harness is doing. */
export interface SessionEvents {
  turnStarted(): void;
  turnEnded(): void;
  text(text: string): void;
  /** Something went wrong in a turn that carried on anyway (a harness's retry): worth showing, not the agent's words. */
  warning?(text: string): void;
  /** info: what kind of call it is (from the adapter's toolRequest), and files it created when the harness says. */
  toolCall(tool: string, summary: string, info?: import('../rules.ts').ToolInfo): void;
  toolResult(summary: string, ok: boolean): void;
  /** Totals so far for this session. tokensIn is input not read from the prompt cache. */
  usage(u: Usage): void;
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
  /**
   * Where each of the harness's accounts stands, read between turns (Claude Code's /usage
   * or a Haiku ping, Codex's account/rateLimits/read, Antigravity's /quota). Keyed by account.
   */
  readLimits?(): Promise<Record<string, RateLimitInfo>>;
  /** What a tool call means, for harnesses whose hooks ask MetaHarness before each tool runs. */
  toolRequest?(tool: string, args: Record<string, unknown>): ToolRequest;
  /** The command a human runs to open a session in the harness itself, e.g. `claude --resume <id>`. */
  nativeCommand?(sessionId: string): string;
}

/**
 * A tool call as the approval policy sees it. read: never needs asking. edit: allowed inside
 * the agent's own directories. shell: allowed when the role allows the command. delegate, ask_user,
 * message and schedule: refused, because MetaHarness provides those (spawn, send, wait).
 */
export interface ToolRequest {
  kind: 'read' | 'edit' | 'shell' | 'mcp' | 'delegate' | 'ask_user' | 'message' | 'schedule' | 'image' | 'other';
  /** Name shown to the human, e.g. Bash or Edit. */
  tool: string;
  detail: string;
  path?: string;
  /** For mcp: the server the tool belongs to. */
  server?: string;
}

/** What a harness hook sends the daemon. */
export type HookRequest = { event: 'before_model' } | { event: 'before_tool'; tool: string; args: Record<string, unknown> };
