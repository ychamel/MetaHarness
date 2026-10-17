import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { MCP_SERVER_NAME } from '../mcp.ts';
import type { CapabilityManifest, HarnessAdapter, Session, SessionEvents, SessionSpec } from './types.ts';

/** USD per million tokens. Codex reports tokens only, so cost comes from this table (if filled in). */
export type PriceTable = Record<string, { input: number; cachedInput?: number; output: number }>;

/**
 * Codex through its app-server: one shared `codex app-server` process speaking JSON-RPC over
 * stdio, one thread per agent. Messages reach a running turn with turn/steer.
 */
export class CodexAdapter implements HarnessAdapter {
  readonly manifest: CapabilityManifest = {
    harness: 'codex',
    injectMidTurn: true,
    resume: true,
    interrupt: true,
    reportsCost: false,
    reportsContext: true,
  };
  private bin: string;
  private prices: PriceTable;
  private server?: Promise<AppServer>;

  constructor(opts: { bin?: string; prices?: PriceTable } = {}) {
    this.bin = opts.bin ?? 'codex';
    this.prices = opts.prices ?? {};
  }

  async start(spec: SessionSpec, events: SessionEvents): Promise<Session> {
    if (!spec.mcpUrl) throw new Error('the daemon has no MCP address yet (is the server running?)');
    if (!this.server) {
      this.server = AppServer.start(this.bin);
      this.server.catch(() => (this.server = undefined));
    }
    const server = await this.server;
    const session = new CodexSession(server, spec, events, this.prices[spec.model]);
    await session.init();
    return session;
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class AppServer {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  private stderrTail = '';
  readonly threads = new Map<string, CodexSession>();

  static async start(bin: string): Promise<AppServer> {
    const s = new AppServer(bin);
    await s.request('initialize', { clientInfo: { name: 'metaharness', title: 'MetaHarness', version: '0.0.1' }, capabilities: null });
    s.notify('initialized');
    return s;
  }

  private constructor(bin: string) {
    this.proc = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c: string) => this.onData(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c: string) => (this.stderrTail = (this.stderrTail + c).slice(-2000)));
    const fail = (why: string) => {
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
      for (const t of this.threads.values()) t.serverDied(why);
    };
    this.proc.on('error', e => fail(e.message));
    this.proc.on('exit', code => fail(`codex app-server exited with code ${code}. ${this.stderrTail.trim()}`.trim()));
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  }

  respond(id: number | string, result: unknown): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  respondError(id: number | string, message: string): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.id !== undefined && m.method === undefined) {
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
        else p.resolve(m.result);
      } else if (m.method) {
        const thread = this.threads.get(m.params?.threadId);
        if (m.id !== undefined) {
          if (thread) void thread.onServerRequest(m.id, m.method, m.params);
          else this.respondError(m.id, 'MetaHarness has no agent on this thread.');
        } else thread?.onNotification(m.method, m.params);
      }
    }
  }
}

class CodexSession implements Session {
  nativeId = '';
  private server: AppServer;
  private spec: SessionSpec;
  private ev: SessionEvents;
  private price?: PriceTable[string];
  private turnId: string | null = null;
  private running = false;
  private stopped = false;

  constructor(server: AppServer, spec: SessionSpec, ev: SessionEvents, price?: PriceTable[string]) {
    this.server = server;
    this.spec = spec;
    this.ev = ev;
    this.price = price;
  }

  async init(): Promise<void> {
    const r = await this.server.request('thread/start', {
      model: this.spec.model || null,
      cwd: this.spec.cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: this.spec.systemPrompt,
      config: {
        [`mcp_servers.${MCP_SERVER_NAME}.url`]: this.spec.mcpUrl,
        [`mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec`]: 900,
        // All delegation goes through MetaHarness (design §11).
        'features.multi_agent': false,
        'sandbox_workspace_write.writable_roots': [this.spec.sharedDir],
      },
    });
    this.nativeId = r.thread.id;
    this.server.threads.set(this.nativeId, this);
    setImmediate(() => void this.send(this.spec.brief, 'new_turn'));
  }

  busy(): boolean {
    return this.running;
  }

  private input(text: string) {
    return [{ type: 'text', text, text_elements: [] }];
  }

  async send(text: string, how: 'inject' | 'new_turn'): Promise<void> {
    if (this.stopped) return;
    if (how === 'inject' && this.running && this.turnId) {
      try {
        await this.server.request('turn/steer', { threadId: this.nativeId, expectedTurnId: this.turnId, input: this.input(text) });
        return;
      } catch {
        // The turn ended between our check and the steer; start a new one instead.
      }
    }
    if (!this.running) {
      this.running = true;
      this.ev.turnStarted();
    }
    try {
      const r = await this.server.request('turn/start', { threadId: this.nativeId, input: this.input(text) });
      this.turnId = r.turn?.id ?? this.turnId;
    } catch (e) {
      this.running = false;
      this.ev.text(`(couldn't start a turn: ${(e as Error).message})`);
      this.ev.turnEnded();
    }
  }

  async interrupt(): Promise<void> {
    if (this.turnId) await this.server.request('turn/interrupt', { threadId: this.nativeId, turnId: this.turnId }).catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.interrupt();
    this.stopped = true;
    this.running = false;
    this.server.threads.delete(this.nativeId);
    this.ev.exited('stopped');
  }

  serverDied(why: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.ev.exited('crashed', why);
  }

  onNotification(method: string, p: any): void {
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn?.id ?? this.turnId;
        if (!this.running) {
          this.running = true;
          this.ev.turnStarted();
        }
        break;
      case 'turn/completed': {
        if (p.turn?.id && this.turnId && p.turn.id !== this.turnId) break;
        if (p.turn?.status === 'failed') this.ev.text(`(turn failed: ${p.turn.error?.message ?? 'unknown error'})`);
        this.turnId = null;
        this.running = false;
        this.ev.turnEnded();
        break;
      }
      case 'item/started':
        if (p.item?.type === 'commandExecution') this.ev.toolCall('Bash', String(p.item.command ?? '').slice(0, 160));
        break;
      case 'item/completed': {
        const it = p.item ?? {};
        if (it.type === 'agentMessage' && it.text?.trim()) this.ev.text(it.text);
        else if (it.type === 'commandExecution') this.ev.toolResult(`exit ${it.exitCode ?? '?'}: ${String(it.aggregatedOutput ?? '').slice(0, 160)}`, it.exitCode === 0);
        else if (it.type === 'fileChange') this.ev.toolCall('Edit', (it.changes ?? []).map((c: { path?: string }) => c.path).join(', ').slice(0, 160));
        else if (it.type === 'mcpToolCall' && it.server !== MCP_SERVER_NAME) this.ev.toolCall(`${it.server}.${it.tool}`, JSON.stringify(it.arguments ?? {}).slice(0, 160));
        break;
      }
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage ?? {};
        const total = u.total ?? {};
        const last = u.last ?? {};
        const window = u.modelContextWindow;
        let costUsd: number | undefined;
        if (this.price) {
          const cached = total.cachedInputTokens ?? 0;
          costUsd = (((total.inputTokens ?? 0) - cached) * this.price.input + cached * (this.price.cachedInput ?? this.price.input) + (total.outputTokens ?? 0) * this.price.output) / 1e6;
        }
        this.ev.usage({
          tokensIn: total.inputTokens,
          tokensOut: total.outputTokens,
          costUsd,
          contextPct: window && last.totalTokens ? Math.round((100 * last.totalTokens) / window) : undefined,
        });
        break;
      }
    }
  }

  async onServerRequest(id: number | string, method: string, p: any): Promise<void> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval': {
        const d = await this.ev.approval('Bash', String(p.command ?? p.reason ?? 'run a command'));
        this.server.respond(id, { decision: d.allow ? 'accept' : 'decline' });
        return;
      }
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval': {
        const d = await this.ev.approval('Edit', String(p.reason ?? p.grantRoot ?? 'change files'));
        this.server.respond(id, { decision: d.allow ? 'accept' : 'decline' });
        return;
      }
      case 'mcpServer/elicitation/request':
        // Our own server never asks for input; decline anything else rather than guess.
        this.server.respond(id, { action: p.serverName === MCP_SERVER_NAME ? 'accept' : 'decline', content: null, _meta: null });
        return;
      default:
        this.server.respondError(id, `MetaHarness doesn't handle ${method} yet.`);
    }
  }
}
