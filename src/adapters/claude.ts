import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { APPROVAL_TOOL, MCP_SERVER_NAME } from '../mcp.ts';
import { claudeMcpDef } from '../mcpservers.ts';
import type { CapabilityManifest, HarnessAdapter, RateLimitInfo, Session, SessionEvents, SessionSpec, StartOptions } from './types.ts';

/**
 * Claude Code in streaming mode: one long-lived `claude -p` process per agent, NDJSON in and out.
 * A message written while a turn runs is seen in that same turn (verified, Appendix A).
 */
export class ClaudeAdapter implements HarnessAdapter {
  readonly manifest: CapabilityManifest;
  private bin: string;
  private env: Record<string, string>;

  /** `id` and `env` let one profile run Claude Code against another provider's endpoint. */
  constructor(opts: { id?: string; bin?: string; env?: Record<string, string> } = {}) {
    this.bin = opts.bin ?? 'claude';
    this.env = opts.env ?? {};
    this.manifest = {
      harness: opts.id ?? 'claude-code',
      injectMidTurn: true,
      resume: true,
      interrupt: true,
      reportsCost: true,
      reportsContext: true,
      reportsRateLimits: true,
    };
  }

  async start(spec: SessionSpec, events: SessionEvents, opts: StartOptions = {}): Promise<Session> {
    if (!spec.mcpUrl) throw new Error('the daemon has no MCP address yet (is the server running?)');
    return new ClaudeSession(this.bin, this.env, spec, events, opts.resume);
  }
}

/** With `resume`, the session continues under the same ID instead of starting as `sessionId`. */
export function claudeArgs(spec: SessionSpec, sessionId: string, resume = false): string[] {
  // Ours, plus the servers the role names: from MetaHarness's mcp.json, else Claude Code's own config.
  const servers: Record<string, unknown> = { [MCP_SERVER_NAME]: { type: 'http', url: spec.mcpUrl } };
  for (const s of spec.mcpServers ?? []) {
    const def = s.def ?? claudeMcpDef(s.name, spec.cwd);
    if (def && s.name !== MCP_SERVER_NAME) servers[s.name] = def;
  }
  const allowed = [`mcp__${MCP_SERVER_NAME}`, ...Object.keys(servers).filter(n => n !== MCP_SERVER_NAME).map(n => `mcp__${n}`), ...spec.role.allow];
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    resume ? '--resume' : '--session-id', sessionId,
    '--append-system-prompt', spec.systemPrompt,
    '--mcp-config', JSON.stringify({ mcpServers: servers }),
    '--strict-mcp-config',
    // Leave out user-level settings (plugins, hooks, permission rules); the role decides instead.
    '--setting-sources', 'project,local',
    '--add-dir', spec.sharedDir,
    // All delegation goes through MetaHarness (design §11).
    '--disallowedTools', 'Agent',
    '--permission-mode', spec.role.permissionMode ?? 'acceptEdits',
    '--permission-prompt-tool', `mcp__${MCP_SERVER_NAME}__${APPROVAL_TOOL}`,
    '--allowedTools', ...allowed,
  ];
  if (spec.model) args.push('--model', spec.model);
  return args;
}

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean };

class ClaudeSession implements Session {
  readonly nativeId: string;
  private proc: ChildProcessWithoutNullStreams;
  private ev: SessionEvents;
  private running = false;
  private stopped = false;
  private buf = '';
  private stderrTail = '';
  private costSoFar = 0;
  private toolNames = new Map<string, string>();

  constructor(bin: string, env: Record<string, string>, spec: SessionSpec, ev: SessionEvents, resume?: string) {
    this.ev = ev;
    this.nativeId = resume ?? randomUUID();
    this.proc = spawn(bin, claudeArgs(spec, this.nativeId, !!resume), {
      cwd: spec.cwd,
      env: { ...process.env, ...env, MCP_TOOL_TIMEOUT: '900000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-2000)));
    this.proc.on('error', err => this.crash(err.message));
    this.proc.on('exit', code => {
      if (!this.stopped) this.crash(`claude exited with code ${code}. ${this.stderrTail.trim()}`.trim());
    });
    // The brief starts the first turn right away, so messages the daemon delivers next join it
    // instead of arriving ahead of the brief.
    if (spec.brief) void this.send(spec.brief, 'new_turn');
  }

  busy(): boolean {
    return this.running;
  }

  private write(obj: unknown): void {
    if (!this.stopped && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  async send(text: string, how: 'inject' | 'new_turn'): Promise<void> {
    if (how === 'new_turn' && !this.running) {
      this.running = true;
      this.ev.turnStarted();
    }
    // Written mid-turn, Claude Code folds it into the running turn; otherwise it starts the next one.
    this.write({ type: 'user', message: { role: 'user', content: text } });
  }

  async interrupt(): Promise<void> {
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.proc.stdin.end();
    const kill = setTimeout(() => this.proc.kill('SIGTERM'), 3000);
    this.proc.once('exit', () => clearTimeout(kill));
    this.ev.exited('stopped');
  }

  private crash(detail: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.ev.exited('crashed', detail);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line));
      } catch {
        /* not JSON: ignore */
      }
    }
  }

  private handle(m: any): void {
    if (m.type === 'assistant') {
      if (!this.running) {
        // A message injected right at the end of a turn can start another one by itself.
        this.running = true;
        this.ev.turnStarted();
      }
      for (const b of (m.message?.content ?? []) as Block[]) {
        if (b.type === 'text' && b.text?.trim()) this.ev.text(b.text);
        if (b.type === 'tool_use' && b.name) {
          const id = (b as { id?: string }).id;
          if (id) this.toolNames.set(id, b.name);
          // Our own tools are already logged by the daemon as they happen.
          if (!b.name.startsWith(`mcp__${MCP_SERVER_NAME}__`)) this.ev.toolCall(b.name, summarize(b.input));
        }
      }
    } else if (m.type === 'user') {
      for (const b of (Array.isArray(m.message?.content) ? m.message.content : []) as (Block & { tool_use_id?: string })[]) {
        if (b.type !== 'tool_result') continue;
        const name = b.tool_use_id ? this.toolNames.get(b.tool_use_id) : undefined;
        if (name?.startsWith(`mcp__${MCP_SERVER_NAME}__`)) continue;
        this.ev.toolResult(resultText(b.content).slice(0, 200), !b.is_error);
      }
    } else if (m.type === 'rate_limit_event') {
      const info = rateLimitInfo(m.rate_limit_info);
      if (info) this.ev.rateLimit(info);
    } else if (m.type === 'result') {
      this.reportUsage(m);
      if (m.is_error && m.result) {
        if (LIMIT_ERROR.test(String(m.result))) this.ev.rateLimit({ status: 'limited' });
        this.ev.text(`(turn ended with an error: ${String(m.result).slice(0, 300)})`);
      }
      this.running = false;
      this.ev.turnEnded();
    }
  }

  private reportUsage(m: any): void {
    // total_cost_usd covers this process's turns so far; keep the running maximum to be safe.
    if (typeof m.total_cost_usd === 'number') this.costSoFar = Math.max(this.costSoFar, m.total_cost_usd);
    const models = Object.values(m.modelUsage ?? {}) as { contextWindow?: number }[];
    const window = models.find(x => x.contextWindow)?.contextWindow;
    const last = (m.usage?.iterations ?? []).at(-1) ?? m.usage ?? {};
    const used = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.output_tokens ?? 0);
    this.ev.usage({
      costUsd: this.costSoFar,
      tokensIn: m.usage?.input_tokens,
      tokensOut: m.usage?.output_tokens,
      contextPct: window && used ? Math.round((100 * used) / window) : undefined,
    });
  }
}

/** How a refused turn reads when Claude Code has no rate_limit_event for it. */
const LIMIT_ERROR = /usage limit|rate limit|limit reached|out of (extra )?usage/i;

/** Claude Code's rate_limit_info: status allowed | allowed_warning | rejected, utilization 0–1, resetsAt in seconds. */
export function rateLimitInfo(r: any): RateLimitInfo | undefined {
  if (!r || typeof r !== 'object' || typeof r.status !== 'string') return undefined;
  const status = r.status === 'rejected' ? 'limited' : r.status === 'allowed_warning' ? 'warning' : 'ok';
  return {
    status,
    usedPct: typeof r.utilization === 'number' ? Math.round(r.utilization * 100) : undefined,
    resetsAt: typeof r.resetsAt === 'number' ? r.resetsAt * 1000 : undefined,
    window: typeof r.rateLimitType === 'string' ? r.rateLimitType : undefined,
  };
}

function summarize(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const main = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description;
  return (main !== undefined ? String(main) : JSON.stringify(input)).slice(0, 160);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join(' ');
  return '';
}
