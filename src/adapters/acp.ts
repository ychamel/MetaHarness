import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MCP_SERVER_NAME } from '../mcp.ts';
import type { CapabilityManifest, HarnessAdapter, Session, SessionEvents, SessionSpec, StartOptions, ToolRequest } from './types.ts';

/**
 * Agent Client Protocol (agentclientprotocol.com): JSON-RPC over stdio, spoken by OpenCode,
 * Gemini CLI, Goose, Qwen Code, Kimi and others, so each of those is a profile, not code
 * (design §16). One process per agent, so each gets its own environment (the git guard).
 *
 * ACP has no way to add to a running turn. Waiting messages ride on the output of commands the
 * agent runs through us (terminal/*), when it does; otherwise the daemon pauses the turn between
 * steps with session/cancel and sends them as the next prompt in the same session.
 */

const PROTOCOL_VERSION = 1;

/** Set MH_ACP_LOG to a file to record every ACP message, both ways (for checking a new harness). */
const TRACE = process.env.MH_ACP_LOG;
const trace = (dir: '>' | '<', agent: string, line: string) => TRACE && appendFileSync(TRACE, `${new Date().toISOString().slice(11, 23)} ${agent} ${dir} ${line}\n`);

export interface AcpOptions {
  /** The profile id, e.g. opencode. */
  id: string;
  bin: string;
  /** Arguments that start the harness's ACP mode, e.g. ["acp"]. */
  args: string[];
  env?: Record<string, string>;
  /** How a human opens a session in the harness itself, with {id} for the session, e.g. "opencode --session {id}". */
  openCommand?: string;
}

export class AcpAdapter implements HarnessAdapter {
  readonly manifest: CapabilityManifest;
  private opts: AcpOptions;

  constructor(opts: AcpOptions) {
    this.opts = opts;
    this.manifest = {
      harness: opts.id,
      injectMidTurn: false,
      pullsMessages: true,
      resume: true,
      interrupt: true,
      reportsCost: true,
      reportsContext: true,
      reportsRateLimits: false,
    };
  }

  nativeCommand(sessionId: string): string {
    return this.opts.openCommand ? this.opts.openCommand.replace('{id}', sessionId) : '';
  }

  async start(spec: SessionSpec, events: SessionEvents, opts: StartOptions = {}): Promise<Session> {
    const s = new AcpSession(this.opts, spec, events);
    try {
      await s.init(opts.resume);
    } catch (e) {
      void s.stop();
      throw e;
    }
    return s;
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** One tool call as the agent reported it. */
interface ToolState {
  title: string;
  kind?: string;
  name?: string;
  rawInput?: Record<string, unknown>;
  locations?: { path: string }[];
  reported: boolean;
  finished: boolean;
}

interface Terminal {
  proc: ChildProcess;
  output: string;
  limit?: number;
  truncated: boolean;
  exit?: { exitCode: number | null; signal: string | null };
  exited: Promise<void>;
  /** Waiting messages were already added to its output. */
  delivered: boolean;
}

class AcpSession implements Session {
  nativeId = '';
  private proc: ChildProcessWithoutNullStreams;
  private opts: AcpOptions;
  private spec: SessionSpec;
  private ev: SessionEvents;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  private stderrTail = '';
  private running = false;
  private stopped = false;
  /** Updates replayed by session/load describe the past; they're not reported. */
  private replaying = false;
  private caps: any = {};
  private text = '';
  private tools = new Map<string, ToolState>();
  private terminals = new Map<string, Terminal>();
  private nextTerminal = 1;
  private firstPrompt = true;
  private totals: { tokensIn?: number; tokensOut?: number; cacheRead?: number; cacheWrite?: number } = {};
  /** Requests from the agent it has since cancelled: their late answers are dropped. */
  private cancelledRequests = new Set<number | string>();

  constructor(opts: AcpOptions, spec: SessionSpec, ev: SessionEvents) {
    this.opts = opts;
    this.spec = spec;
    this.ev = ev;
    this.proc = spawn(opts.bin, opts.args, { cwd: spec.cwd, env: { ...process.env, ...opts.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c: string) => this.onData(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c: string) => (this.stderrTail = (this.stderrTail + c).slice(-2000)));
    this.proc.on('error', e => this.failAll(e));
    this.proc.on('exit', (code, signal) => {
      const why = `${this.opts.id} exited (${signal ?? code})${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''}`;
      this.failAll(new Error(why));
      if (!this.stopped) this.ev.exited(code === 0 ? 'stopped' : 'crashed', why);
    });
  }

  async init(resume?: string): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'metaharness', title: 'MetaHarness', version: '0.0.1' },
    });
    this.caps = init?.agentCapabilities ?? {};
    const where = { cwd: this.spec.cwd, mcpServers: this.mcpServers(), additionalDirectories: [this.spec.sharedDir] };
    let r: any;
    if (resume) {
      this.nativeId = resume;
      if (this.caps.sessionCapabilities?.resume) r = await this.request('session/resume', { sessionId: resume, ...where });
      else if (this.caps.loadSession) {
        this.replaying = true;
        try {
          r = await this.request('session/load', { sessionId: resume, ...where });
        } finally {
          this.replaying = false;
        }
      } else throw new Error(`${this.opts.id} can't resume a session over ACP`);
      this.firstPrompt = false;
    } else {
      r = await this.request('session/new', where);
      this.nativeId = String(r?.sessionId ?? '');
      if (!this.nativeId) throw new Error(`${this.opts.id} started no session`);
    }
    await this.selectModel(r?.configOptions);
    // Started right away, so the session is busy when the daemon first delivers messages.
    if (this.spec.brief) void this.send(this.spec.brief, 'new_turn');
  }

  busy(): boolean {
    return this.running;
  }

  async send(text: string, how: 'inject' | 'new_turn'): Promise<void> {
    // There's no injecting over ACP; the daemon knows (injectMidTurn: false) and pauses instead.
    if (how === 'inject' && this.running) return;
    this.running = true;
    this.ev.turnStarted();
    const prompt: unknown[] = [];
    // ACP has no system prompt. Text meant for the assistant goes first, marked as such.
    if (this.firstPrompt && this.spec.systemPrompt) prompt.push({ type: 'text', text: this.spec.systemPrompt, annotations: { audience: ['assistant'] } });
    this.firstPrompt = false;
    prompt.push({ type: 'text', text });
    try {
      const r = await this.request('session/prompt', { sessionId: this.nativeId, prompt });
      const u = r?.usage;
      if (u && typeof u === 'object') {
        // A prompt's usage is that turn's; the daemon wants the session's totals.
        const turn = {
          tokensIn: num(u.inputTokens ?? u.input_tokens ?? u.input),
          tokensOut: num(u.outputTokens ?? u.output_tokens ?? u.output),
          cacheRead: num(u.cachedReadTokens ?? u.cache_read_input_tokens),
          cacheWrite: num(u.cachedWriteTokens ?? u.cache_creation_input_tokens),
        };
        if (turn.tokensIn !== undefined || turn.tokensOut !== undefined) {
          for (const k of ['tokensIn', 'tokensOut', 'cacheRead', 'cacheWrite'] as const) if (turn[k] !== undefined) this.totals[k] = (this.totals[k] ?? 0) + turn[k]!;
          this.ev.usage({ ...this.totals });
        }
      }
      if (r?.stopReason === 'refusal') this.ev.text(`(${this.opts.id} refused to continue)`);
      else if (r?.stopReason === 'max_tokens' || r?.stopReason === 'max_turn_requests') this.ev.text(`(${this.opts.id} stopped: ${r.stopReason})`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/rate.?limit|429|quota|usage limit/i.test(msg)) this.ev.rateLimit({ status: 'limited' });
      else if (!this.stopped) this.ev.text(`(${this.opts.id}: ${msg})`);
    }
    this.flushText();
    this.running = false;
    if (!this.stopped) this.ev.turnEnded();
  }

  /** Stops the running turn. Unfinished tool calls fail, which is why the daemon waits for a step boundary. */
  async interrupt(): Promise<void> {
    if (this.running) this.notify('session/cancel', { sessionId: this.nativeId });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.terminals.values()) if (!t.exit) t.proc.kill();
    // ACP agents exit when stdin closes; make sure.
    this.proc.stdin.end();
    setTimeout(() => this.proc.kill(), 2000).unref();
  }

  /* ---------------- JSON-RPC ---------------- */

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: number | string, message: string, code = -32603): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(m: unknown): void {
    if (!this.proc.stdin.writable) return;
    const line = JSON.stringify(m);
    trace('>', this.spec.agent, line);
    this.proc.stdin.write(line + '\n');
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      trace('<', this.spec.agent, line);
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method && m.id !== undefined) void this.onRequest(m.id, m.method, m.params ?? {});
      else if (m.method) this.onNotification(m.method, m.params ?? {});
      else if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    }
  }

  private onNotification(method: string, p: any): void {
    if (method === '$/cancel_request' && p.requestId !== undefined) {
      // Asked to drop one of its requests (a permission request when its turn is cancelled).
      this.cancelledRequests.add(p.requestId);
      this.respondError(p.requestId, 'Cancelled', -32800);
      return;
    }
    if (method !== 'session/update' || this.replaying) return;
    const u = p.update ?? {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') this.text += u.content.text ?? '';
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.flushText();
        this.onToolUpdate(u);
        break;
      case 'usage_update': {
        const size = num(u.size);
        const used = num(u.used);
        const cost = u.cost && u.cost.currency === 'USD' ? num(u.cost.amount) : undefined;
        this.ev.usage({ contextPct: size && used !== undefined ? Math.round((used / size) * 100) : undefined, contextTokens: used, costUsd: cost });
        break;
      }
    }
  }

  private onToolUpdate(u: any): void {
    const id = String(u.toolCallId ?? '');
    const t = this.tools.get(id) ?? { title: '', reported: false, finished: false };
    if (u.title) t.title = u.title;
    if (u.kind) t.kind = u.kind;
    if (u.name) t.name = u.name;
    if (u.rawInput && typeof u.rawInput === 'object') t.rawInput = u.rawInput;
    if (Array.isArray(u.locations)) t.locations = u.locations;
    this.tools.set(id, t);
    // Our own tools are logged by the daemon as they're called.
    if (isOurs(t)) return;
    const req = acpToolRequest(t);
    if (!t.reported && u.status !== 'pending') {
      t.reported = true;
      this.ev.toolCall(req.tool, req.detail.slice(0, 160));
    }
    if (!t.finished && (u.status === 'completed' || u.status === 'failed')) {
      t.finished = true;
      if (!t.reported) {
        t.reported = true;
        this.ev.toolCall(req.tool, req.detail.slice(0, 160));
      }
      this.ev.toolResult(resultSummary(u), u.status === 'completed');
    }
  }

  private flushText(): void {
    const t = this.text.trim();
    this.text = '';
    if (t) this.ev.text(t);
  }

  /* ---------------- requests from the agent ---------------- */

  private async onRequest(id: number | string, method: string, p: any): Promise<void> {
    let result: unknown;
    let error: Error | undefined;
    try {
      result = await this.handle(method, p);
    } catch (e) {
      error = e as Error;
    }
    if (this.cancelledRequests.delete(id)) return;
    if (error) this.respondError(id, error.message);
    else this.respond(id, result);
  }

  private async handle(method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'session/request_permission':
        return this.permission(p);
      case 'fs/read_text_file': {
        const lines = readFileSync(String(p.path), 'utf8').split('\n');
        const from = Math.max(0, (num(p.line) ?? 1) - 1);
        const limit = num(p.limit);
        return { content: lines.slice(from, limit !== undefined ? from + limit : undefined).join('\n') };
      }
      case 'fs/write_text_file': {
        const path = String(p.path);
        const d = await this.ev.decide({ kind: 'edit', tool: 'Write', detail: path, path });
        if (!d.allow) throw new Error(d.message ?? 'The human denied this write.');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(p.content ?? ''));
        return {};
      }
      case 'terminal/create':
        return { terminalId: this.createTerminal(p) };
      case 'terminal/output': {
        const t = this.terminal(p.terminalId);
        let output = t.output;
        // A finished command's output is where waiting messages ride along, once.
        if (t.exit && !t.delivered) {
          t.delivered = true;
          const msgs = this.ev.pull();
          if (msgs) output += `\n\n${msgs}`;
        }
        return { output, truncated: t.truncated, exitStatus: t.exit ?? null };
      }
      case 'terminal/wait_for_exit': {
        const t = this.terminal(p.terminalId);
        await t.exited;
        return t.exit;
      }
      case 'terminal/kill':
        this.terminal(p.terminalId).proc.kill();
        return {};
      case 'terminal/release': {
        const t = this.terminal(p.terminalId);
        if (!t.exit) t.proc.kill();
        this.terminals.delete(String(p.terminalId));
        return {};
      }
      default:
        throw Object.assign(new Error(`MetaHarness doesn't handle ${method}`), { code: -32601 });
    }
  }

  /** The agent asks before a tool runs: the daemon's policy decides, or the human. */
  private async permission(p: any): Promise<unknown> {
    const call = p.toolCall ?? {};
    const known = this.tools.get(String(call.toolCallId ?? ''));
    const t: ToolState = { title: call.title ?? known?.title ?? '', kind: call.kind ?? known?.kind, name: call.name ?? known?.name, rawInput: call.rawInput ?? known?.rawInput, locations: call.locations ?? known?.locations, reported: true, finished: false };
    const options: { optionId: string; kind: string }[] = Array.isArray(p.options) ? p.options : [];
    const pick = (...kinds: string[]) => kinds.map(k => options.find(o => o.kind === k)).find(Boolean);
    const d = isOurs(t) ? { allow: true } : await this.ev.decide(acpToolRequest(t));
    // Once, never always: each call goes past the policy.
    const chosen = d.allow ? pick('allow_once', 'allow_always') : pick('reject_once', 'reject_always');
    return chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : { outcome: { outcome: 'cancelled' } };
  }

  private createTerminal(p: any): string {
    const id = `t${this.nextTerminal++}`;
    const args: string[] = Array.isArray(p.args) ? p.args.map(String) : [];
    const env: Record<string, string> = { ...process.env, ...this.opts.env, ...this.spec.env } as Record<string, string>;
    for (const v of Array.isArray(p.env) ? p.env : []) if (v?.name) env[v.name] = String(v.value ?? '');
    // A command with no args may be a whole shell line.
    const proc = spawn(String(p.command), args, { cwd: p.cwd || this.spec.cwd, env, shell: args.length === 0, stdio: ['ignore', 'pipe', 'pipe'] });
    const t: Terminal = { proc, output: '', limit: num(p.outputByteLimit), truncated: false, exited: Promise.resolve(), delivered: false };
    const add = (c: Buffer) => {
      t.output += c.toString('utf8');
      if (t.limit !== undefined && Buffer.byteLength(t.output) > t.limit) {
        // Keep the end, as the spec says.
        const b = Buffer.from(t.output);
        t.output = b.subarray(b.length - t.limit).toString('utf8').replace(/^�+/, '');
        t.truncated = true;
      }
    };
    proc.stdout?.on('data', add);
    proc.stderr?.on('data', add);
    t.exited = new Promise(resolve => {
      proc.on('error', e => {
        add(Buffer.from(String(e.message)));
        t.exit = { exitCode: 127, signal: null };
        resolve();
      });
      proc.on('close', (code, signal) => {
        t.exit ??= { exitCode: code, signal: signal ?? null };
        resolve();
      });
    });
    this.terminals.set(id, t);
    return id;
  }

  private terminal(id: unknown): Terminal {
    const t = this.terminals.get(String(id));
    if (!t) throw new Error(`There's no terminal ${String(id)}.`);
    return t;
  }

  /* ---------------- setup ---------------- */

  private mcpServers(): unknown[] {
    const http = !!this.caps.mcpCapabilities?.http;
    if (!http) throw new Error(`${this.opts.id} doesn't take MCP servers over HTTP, which MetaHarness's tools need`);
    const out: unknown[] = [{ type: 'http', name: MCP_SERVER_NAME, url: this.spec.mcpUrl, headers: [] }];
    for (const s of this.spec.mcpServers) {
      const d = s.def;
      // Without a definition, the harness's own config has the server under that name.
      if (!d || s.name === MCP_SERVER_NAME) continue;
      if (d.url) out.push({ type: d.type === 'sse' ? 'sse' : 'http', name: s.name, url: d.url, headers: Object.entries(d.headers ?? {}).map(([name, value]) => ({ name, value })) });
      else if (d.command) out.push({ name: s.name, command: d.command, args: d.args ?? [], env: Object.entries(d.env ?? {}).map(([name, value]) => ({ name, value })) });
    }
    return out;
  }

  /** Picks the role's model through the session's model config option, if the harness has one. */
  private async selectModel(configOptions: unknown): Promise<void> {
    if (!this.spec.model) return;
    const opts = Array.isArray(configOptions) ? (configOptions as any[]) : [];
    const model = opts.find(o => o?.category === 'model' || o?.id === 'model');
    if (!model) throw new Error(`${this.opts.id} has no model setting over ACP, so it can't run ${this.spec.model}; leave the role's model empty to use its default`);
    if (model.currentValue === this.spec.model) return;
    try {
      await this.request('session/set_config_option', { sessionId: this.nativeId, configId: model.id, value: this.spec.model });
    } catch (e) {
      const values = flattenValues(model.options).slice(0, 15);
      throw new Error(`${this.opts.id} won't use model ${this.spec.model}: ${(e as Error).message}${values.length ? `. It offers: ${values.join(', ')}` : ''}`);
    }
  }
}

/** MetaHarness's own MCP tools, however the harness names them, including code that only calls them. */
function isOurs(t: Pick<ToolState, 'title' | 'name' | 'rawInput'>): boolean {
  const n = `${t.name ?? ''} ${t.title ?? ''}`;
  if (new RegExp(`(^|\\s|__)${MCP_SERVER_NAME}[_./:]`).test(n)) return true;
  const calls = codeModeCalls(t.rawInput);
  return !!calls?.length && calls.every(c => c.server === MCP_SERVER_NAME);
}

/** Read-only tools OpenCode offers in its code mode. */
const CODE_MODE_READS = new Set(['list_mcp_resources', 'read_mcp_resource', 'models', 'worktree_list']);

/**
 * Tool calls inside a "code mode" call (OpenCode v2): MCP tools are reached by code like
 * `await tools.metaharness.status({...})` run by one `execute` tool. Undefined if it isn't one.
 */
export function codeModeCalls(input: Record<string, unknown> | undefined): { server: string; tool: string }[] | undefined {
  const code = input?.code;
  if (typeof code !== 'string') return undefined;
  return [...code.matchAll(/\btools\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g)].map(m => ({ server: m[1], tool: m[2] }));
}

/** What an ACP tool call means for the approval policy. */
export function acpToolRequest(t: Pick<ToolState, 'title' | 'kind' | 'name' | 'rawInput' | 'locations'>): ToolRequest {
  const input = t.rawInput ?? {};
  const name = String(t.name ?? '').toLowerCase();
  const title = t.title || t.name || t.kind || 'tool';
  const path = t.locations?.[0]?.path ?? str(input.filePath ?? input.file_path ?? input.path);
  if (name === 'task' || /subagent/.test(name)) return { kind: 'delegate', tool: title, detail: JSON.stringify(input).slice(0, 2000) };
  if (name === 'question' || name === 'ask_user') return { kind: 'ask_user', tool: title, detail: JSON.stringify(input).slice(0, 2000) };
  const calls = codeModeCalls(input);
  if (calls) {
    // Code that calls MCP tools: allowed when they're all ours, one of the role's servers, or reads.
    const servers = [...new Set(calls.filter(c => !(c.server === 'opencode' && CODE_MODE_READS.has(c.tool))).map(c => c.server))];
    const detail = String(input.code).slice(0, 2000);
    if (!servers.length) return { kind: calls.length ? 'read' : 'other', tool: title, detail };
    const others = servers.filter(s => s !== MCP_SERVER_NAME);
    if (others.length <= 1) return { kind: 'mcp', tool: title, detail, server: others[0] ?? MCP_SERVER_NAME };
    return { kind: 'other', tool: title, detail };
  }
  const server = /^(?:mcp__)?([\w-]+?)(?:__|_|\/)/.exec(t.name ?? '')?.[1];
  switch (t.kind) {
    case 'read':
    case 'search':
    case 'think':
      return { kind: 'read', tool: title, detail: path ?? title };
    case 'edit':
    case 'delete':
    case 'move':
      return { kind: 'edit', tool: title, detail: path ?? title, path };
    case 'execute': {
      const cmd = str(input.command ?? input.cmd) ?? (Array.isArray(input.command) ? input.command.join(' ') : undefined);
      return { kind: 'shell', tool: 'Bash', detail: cmd ?? title };
    }
  }
  if (t.name && /__|^[\w-]+_[\w-]+$/.test(t.name) && server) return { kind: 'mcp', tool: title, detail: JSON.stringify(input).slice(0, 2000), server };
  return { kind: 'other', tool: title, detail: JSON.stringify(input).slice(0, 2000) || title };
}

function resultSummary(u: any): string {
  const parts: string[] = [];
  for (const c of Array.isArray(u.content) ? u.content : []) {
    if (c?.type === 'content' && c.content?.type === 'text') parts.push(c.content.text);
    else if (c?.type === 'diff') parts.push(`edited ${c.path}`);
  }
  if (!parts.length && u.rawOutput) parts.push(typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput));
  return parts.join(' ').slice(0, 200) || String(u.status ?? '');
}

function flattenValues(options: unknown): string[] {
  const out: string[] = [];
  for (const o of Array.isArray(options) ? options : []) {
    if (o && Array.isArray(o.options)) out.push(...flattenValues(o.options));
    else if (o && (o.value !== undefined || o.id !== undefined)) out.push(String(o.value ?? o.id));
  }
  return out;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
