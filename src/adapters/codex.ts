import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { MCP_SERVER_NAME } from '../mcp.ts';
import { codexAsk } from '../harnesses.ts';
import type { CapabilityManifest, HarnessAdapter, RateLimitInfo, Session, SessionEvents, SessionSpec, StartOptions } from './types.ts';

/**
 * Config overrides that keep a thread to what MetaHarness gives it: the user's global MCP servers
 * are turned off, and so are plugins and app connectors, which bring their own skills and tools,
 * and the user's personal skills (design §18). Codex's built-in system skills remain; they're
 * part of the harness (imagegen is the manual for its image_gen tool).
 */
export function isolationConfig(userMcpServers: string[], keep: string[] = [], personalSkills: string[] = []): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    'features.plugins': false,
    'features.apps': false,
    'features.remote_plugin': false,
    'features.skill_search': false,
    'features.tool_suggest': false,
  };
  for (const name of userMcpServers) {
    if (name !== MCP_SERVER_NAME && !keep.includes(name) && /^[\w-]+$/.test(name)) cfg[`mcp_servers.${name}.enabled`] = false;
  }
  if (personalSkills.length) cfg['skills.config'] = personalSkills.map(path => ({ path, enabled: false }));
  return cfg;
}

/** The SKILL.md paths of the user's own skills (scope "user") that Codex would load in `cwd`. */
export async function personalSkills(server: { request(method: string, params: unknown): Promise<any> }, cwd: string): Promise<string[]> {
  try {
    const r = await server.request('skills/list', { cwds: [cwd] });
    return ((r?.data ?? []) as { skills?: { scope?: string; path?: string }[] }[]).flatMap(e => e.skills ?? []).filter(k => k.scope === 'user' && k.path).map(k => String(k.path));
  } catch {
    // An older Codex without skills/list: nothing to turn off that we can see.
    return [];
  }
}

async function listUserMcpServers(bin: string): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['mcp', 'list', '--json'], { timeout: 15_000 });
    return (JSON.parse(stdout) as { name: string }[]).map(s => s.name);
  } catch {
    return [];
  }
}

const LIMIT_ERRORS = ['usageLimitExceeded', 'rateLimitExceeded'];

type Window = { usedPercent?: number; resetsAt?: number | null; windowDurationMins?: number | null };

/**
 * A Codex rate-limit snapshot: a primary and a secondary window, each with the percent used and
 * a reset time in seconds. Updates can be sparse, so only what's present is reported.
 * Only rateLimitReachedType means refused: past 100% of the plan's window, Codex carries on with
 * the account's credits (seen live: agents kept working 35 minutes after a 100% snapshot).
 */
export function codexRateLimit(r: any): RateLimitInfo | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const windows = [r.primary, r.secondary].filter((w): w is Window => !!w && typeof w.usedPercent === 'number');
  const top = windows.slice().sort((a, b) => b.usedPercent! - a.usedPercent!)[0];
  if (!top && !r.rateLimitReachedType) return undefined;
  const over = (top?.usedPercent ?? 0) >= 100;
  const credits = r.credits && typeof r.credits === 'object' ? (r.credits as { hasCredits?: boolean; unlimited?: boolean; balance?: string | null }) : undefined;
  const note = r.rateLimitReachedType
    ? `refused: ${String(r.rateLimitReachedType).replace(/_/g, ' ')}`
    : over
      ? credits?.unlimited
        ? "past the plan's limit; credits are unlimited"
        : credits?.hasCredits
          ? `past the plan's limit, running on credits${credits.balance ? ` (balance ${credits.balance})` : ''}`
          : "past the plan's limit"
      : undefined;
  return {
    status: r.rateLimitReachedType ? 'limited' : over ? 'warning' : 'ok',
    ...(note ? { note } : {}),
    usedPct: top?.usedPercent,
    resetsAt: top?.resetsAt ? top.resetsAt * 1000 : undefined,
    window: r.limitName ?? windowName(top?.windowDurationMins),
    ...(windows.length
      ? { windows: windows.map(w => ({ name: windowName(w.windowDurationMins) ?? 'window', usedPct: w.usedPercent!, ...(w.resetsAt ? { resetsAt: w.resetsAt * 1000 } : {}) })) }
      : {}),
  };
}

const windowName = (mins?: number | null) => (mins ? (mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`) : undefined);

/** Config overrides adding the role's servers that MetaHarness has definitions for. */
export function mcpServerConfig(servers: SessionSpec['mcpServers']): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  for (const { name, def } of servers) {
    if (!def || name === MCP_SERVER_NAME || !/^[\w-]+$/.test(name)) continue;
    for (const key of ['command', 'args', 'env', 'url'] as const) if (def[key] !== undefined) cfg[`mcp_servers.${name}.${key}`] = def[key];
  }
  return cfg;
}

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
    reportsRateLimits: true,
  };
  private bin: string;
  private server?: Promise<AppServer>;
  private userServers?: Promise<string[]>;

  constructor(opts: { bin?: string } = {}) {
    this.bin = opts.bin ?? 'codex';
  }

  /** account/rateLimits/read: from the running app-server, or a short-lived one when no agent runs. */
  async readLimits(): Promise<Record<string, RateLimitInfo>> {
    const server = this.server && (await this.server.catch(() => undefined));
    const r = server ? await server.request('account/rateLimits/read', null) : await codexAsk(this.bin, process.env, 'account/rateLimits/read', null, 30_000);
    const info = codexRateLimit(r?.rateLimits);
    return info ? { [this.manifest.harness]: info } : {};
  }

  nativeCommand(sessionId: string): string {
    return `${this.bin} resume ${sessionId}`;
  }

  async start(spec: SessionSpec, events: SessionEvents, opts: StartOptions = {}): Promise<Session> {
    if (!spec.mcpUrl) throw new Error('the daemon has no MCP address yet (is the server running?)');
    if (!this.server) {
      this.server = AppServer.start(this.bin);
      this.server.catch(() => (this.server = undefined));
    }
    const server = await this.server;
    this.userServers ??= listUserMcpServers(this.bin);
    const skills = await personalSkills(server, spec.cwd);
    const config = { ...isolationConfig(await this.userServers, spec.mcpServers.map(s => s.name), skills), ...mcpServerConfig(spec.mcpServers) };
    const session = new CodexSession(server, spec, events, config);
    await session.init(opts.resume);
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
        } else if (thread) thread.onNotification(m.method, m.params);
        // Account notifications (rate limits) carry no thread: they concern every agent on it.
        else if (m.params?.threadId === undefined) for (const t of this.threads.values()) t.onNotification(m.method, m.params);
      }
    }
  }
}

class CodexSession implements Session {
  nativeId = '';
  private server: AppServer;
  private spec: SessionSpec;
  private ev: SessionEvents;
  private isolation: Record<string, unknown>;
  private turnId: string | null = null;
  /** Settles once the latest turn/start has answered, so a message sent meanwhile can steer that turn. */
  private turnStarting: Promise<unknown> = Promise.resolve();
  private running = false;
  private stopped = false;
  private fileChanges = new Map<string, string[]>();

  constructor(server: AppServer, spec: SessionSpec, ev: SessionEvents, isolation: Record<string, unknown>) {
    this.server = server;
    this.spec = spec;
    this.ev = ev;
    this.isolation = isolation;
  }

  async init(resume?: string): Promise<void> {
    const r = await this.server.request(resume ? 'thread/resume' : 'thread/start', {
      ...(resume ? { threadId: resume } : {}),
      model: this.spec.model || null,
      cwd: this.spec.cwd,
      // In the human's shared checkout, every command that isn't plainly safe comes to
      // MetaHarness's policy first; elsewhere the sandbox is enough.
      approvalPolicy: this.spec.sharedCheckout ? 'untrusted' : 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: this.spec.systemPrompt,
      config: {
        ...this.isolation,
        [`mcp_servers.${MCP_SERVER_NAME}.url`]: this.spec.mcpUrl,
        [`mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec`]: 900,
        // All delegation goes through MetaHarness (design §11).
        'features.multi_agent': false,
        // Committing from a worktree writes outside it, into the shared .git. Codex keeps the
        // worktree's own git directory read-only unless it's named here too.
        'sandbox_workspace_write.writable_roots': [this.spec.sharedDir, ...this.spec.gitDirs],
        // One app-server runs every agent, so each thread's commands get the git guard here.
        ...(this.spec.env ? { 'shell_environment_policy.set': this.spec.env } : {}),
      },
    });
    this.nativeId = r.thread.id;
    this.server.threads.set(this.nativeId, this);
    // Started right away, so the session is already busy when the daemon first delivers messages:
    // they then join this turn instead of starting a turn ahead of the brief.
    if (this.spec.brief) void this.send(this.spec.brief, 'new_turn');
  }

  busy(): boolean {
    return this.running;
  }

  private input(text: string) {
    return [{ type: 'text', text, text_elements: [] }];
  }

  async send(text: string, how: 'inject' | 'new_turn'): Promise<void> {
    if (this.stopped) return;
    if (how === 'inject' && this.running) await this.turnStarting;
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
      const started = this.server.request('turn/start', { threadId: this.nativeId, input: this.input(text) });
      this.turnStarting = started.catch(() => {});
      const r = await started;
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
        if (p.turn?.status === 'failed') {
          if (LIMIT_ERRORS.includes(p.turn.error?.codexErrorInfo)) this.ev.rateLimit({ status: 'limited' });
          this.ev.text(`(turn failed: ${p.turn.error?.message ?? 'unknown error'})`);
        }
        this.turnId = null;
        this.running = false;
        this.ev.turnEnded();
        break;
      }
      case 'item/started':
        if (p.item?.type === 'commandExecution') this.ev.toolCall('Bash', String(p.item.command ?? '').slice(0, 160), { kind: 'shell' });
        // Its paths, for when the change asks for approval.
        else if (p.item?.type === 'fileChange') this.fileChanges.set(String(p.item.id), (p.item.changes ?? []).map((c: { path?: string }) => String(c.path ?? '')).filter(Boolean));
        break;
      case 'item/completed': {
        const it = p.item ?? {};
        if (it.type === 'agentMessage' && it.text?.trim()) this.ev.text(it.text);
        else if (it.type === 'commandExecution') this.ev.toolResult(`exit ${it.exitCode ?? '?'}: ${String(it.aggregatedOutput ?? '').slice(0, 160)}`, it.exitCode === 0);
        else if (it.type === 'fileChange') {
          // Reported once it's applied, so it starts and finishes here.
          const changes = (it.changes ?? []) as { path?: string; kind?: { type?: string } }[];
          this.ev.toolCall('Edit', changes.map(c => c.path).join(', ').slice(0, 160), {
            kind: 'edit',
            created: changes.filter(c => c.kind?.type === 'add' && c.path).map(c => String(c.path)),
          });
          this.ev.toolResult(String(it.status ?? 'applied'), it.status !== 'failed');
        }
        else if (it.type === 'mcpToolCall' && it.server !== MCP_SERVER_NAME) this.ev.toolCall(`${it.server}.${it.tool}`, JSON.stringify(it.arguments ?? {}).slice(0, 160));
        break;
      }
      case 'account/rateLimits/updated': {
        const info = codexRateLimit(p.rateLimits);
        if (info) this.ev.rateLimit(info);
        break;
      }
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage ?? {};
        const total = u.total ?? {};
        const last = u.last ?? {};
        const window = u.modelContextWindow;
        // Codex counts cached input inside inputTokens; MetaHarness keeps them apart. No cost: the
        // daemon prices tokens from the settings.
        const cached = total.cachedInputTokens ?? 0;
        this.ev.usage({
          tokensIn: total.inputTokens !== undefined ? total.inputTokens - cached : undefined,
          cacheRead: total.cachedInputTokens,
          tokensOut: total.outputTokens,
          contextPct: window && last.totalTokens ? Math.round((100 * last.totalTokens) / window) : undefined,
          contextTokens: last.totalTokens,
        });
        break;
      }
    }
  }

  async onServerRequest(id: number | string, method: string, p: any): Promise<void> {
    // The v1 requests (execCommandApproval, applyPatchApproval) take a ReviewDecision instead.
    const v1 = method === 'execCommandApproval' || method === 'applyPatchApproval';
    const answer = (d: { allow: boolean; message?: string }) =>
      this.server.respond(id, { decision: v1 ? (d.allow ? 'approved' : { denied: { rejection: d.message ?? 'Denied.' } }) : d.allow ? 'accept' : 'decline' });
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval': {
        const command = Array.isArray(p.command) ? p.command.join(' ') : String(p.command ?? p.reason ?? 'run a command');
        answer(await this.ev.decide({ kind: 'shell', tool: 'Bash', detail: command }));
        return;
      }
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval': {
        // Writing outside its roots goes to the human; edits to known files go through the edit policy.
        const paths = p.grantRoot ? [] : (this.fileChanges.get(String(p.itemId ?? '')) ?? []);
        let d: { allow: boolean; message?: string } = { allow: true };
        for (const path of paths) if (d.allow) d = await this.ev.decide({ kind: 'edit', tool: 'Edit', detail: path, path });
        if (!paths.length) d = await this.ev.approval('Edit', String(p.reason ?? p.grantRoot ?? 'change files'));
        answer(d);
        return;
      }
      case 'mcpServer/elicitation/request':
        // Ours and the role's own servers are accepted (Codex asks before their tool calls); anything else is declined.
        this.server.respond(id, { action: p.serverName === MCP_SERVER_NAME || this.spec.role.mcp.includes(p.serverName) ? 'accept' : 'decline', content: null, _meta: null });
        return;
      default:
        this.server.respondError(id, `MetaHarness doesn't handle ${method} yet.`);
    }
  }
}
