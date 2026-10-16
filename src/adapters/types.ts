import type { Role } from '../types.ts';

/** What a harness can do. The daemon never assumes a feature the manifest doesn't claim. */
export interface CapabilityManifest {
  harness: string;
  /** A message can be added to a turn that is already running. */
  injectMidTurn: boolean;
  /** A finished session can take a new turn later. */
  resume: boolean;
  interrupt: boolean;
  reportsCost: boolean;
  reportsContext: boolean;
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
  /** Where a real harness reaches our tools over MCP. Empty until the MCP layer exists. */
  mcpUrl: string;
  /** In-process access to the same tools (used by the fake adapter and tests). */
  callTool: ToolCaller;
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

export interface HarnessAdapter {
  manifest: CapabilityManifest;
  start(spec: SessionSpec, events: SessionEvents): Promise<Session>;
}
