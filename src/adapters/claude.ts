import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPROVAL_TOOL, MCP_SERVER_NAME } from '../mcp.ts';
import { claudeMcpDef } from '../mcpservers.ts';
import { run } from '../harnesses.ts';
import { nativeSkillNames } from '../skills.ts';
import type { CapabilityManifest, CostSplit, HarnessAdapter, LimitWindow, RateLimitInfo, Session, SessionEvents, SessionSpec, StartOptions, ToolRequest, Usage } from './types.ts';

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

  nativeCommand(sessionId: string): string {
    return `${this.bin} --resume ${sessionId}`;
  }

  toolRequest(tool: string, args: Record<string, unknown>): ToolRequest {
    return claudeToolRequest(tool, args);
  }

  /** `/usage` runs locally in print mode: no model call, no cost. */
  async readLimits(): Promise<Record<string, RateLimitInfo>> {
    const r = await run(this.bin, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], { ...process.env, ...this.env }, 60_000, tmpdir());
    let text: unknown;
    try {
      text = JSON.parse(r.stdout).result;
    } catch {
      throw new Error(`claude /usage said: ${r.out.slice(0, 200) || `exit ${r.code}`}`);
    }
    const info = claudeUsage(String(text ?? ''));
    return info ? { [this.manifest.harness]: info } : {};
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
  const hiddenSkills = spec.role.nativeSkills ? [] : nativeSkillNames(join(spec.cwd, '.claude', 'skills'));
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
    // Leave out user-level settings (plugins, hooks, permission rules, personal skills); the role
    // decides instead. A role with native_skills keeps them.
    '--setting-sources', spec.role.nativeSkills ? 'user,project,local' : 'project,local',
    '--add-dir', spec.sharedDir,
    // All delegation goes through MetaHarness (design §11).
    // Neither can a role's allow list let agents push or delete branches (src/guard.ts).
    // The repository's .claude/skills come through the skill tool, for every harness (design §18).
    '--disallowedTools', 'Agent', ...(spec.deniedCommands ?? []).map(p => `Bash(${p}:*)`), ...hiddenSkills.map(n => `Skill(${n})`),
    // Claude Code's auto mode lets its own classifier approve what's safe; what it would ask still comes to us.
    '--permission-mode', spec.role.permissionMode ?? (spec.approvals === 'harness' ? 'auto' : 'acceptEdits'),
    '--permission-prompt-tool', `mcp__${MCP_SERVER_NAME}__${APPROVAL_TOOL}`,
    '--allowedTools', ...allowed,
  ];
  if (spec.model) args.push('--model', spec.model);
  return args;
}

/** What a Claude Code tool call means, for the approval policy (its permission prompt asks through ours). */
export function claudeToolRequest(tool: string, args: Record<string, unknown>): ToolRequest {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const path = str(args.file_path) ?? str(args.notebook_path) ?? str(args.path);
  switch (tool) {
    case 'Read': case 'Glob': case 'Grep': case 'LS': case 'NotebookRead': case 'WebSearch': case 'TodoWrite':
      return { kind: 'read', tool, detail: path ?? str(args.pattern) ?? str(args.query) ?? JSON.stringify(args).slice(0, 300), path };
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return { kind: 'edit', tool, detail: path ?? JSON.stringify(args).slice(0, 8000), path };
    case 'Bash':
      return { kind: 'shell', tool, detail: str(args.command) ?? JSON.stringify(args).slice(0, 8000) };
    case 'Agent': case 'Task':
      return { kind: 'delegate', tool, detail: JSON.stringify(args).slice(0, 300) };
    case 'AskUserQuestion':
      return { kind: 'ask_user', tool, detail: JSON.stringify(args).slice(0, 300) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return { kind: 'mcp', tool: `${mcp[1]}.${mcp[2]}`, detail: JSON.stringify(args).slice(0, 8000), server: mcp[1] };
  return { kind: 'other', tool, detail: (str(args.url) ?? str(args.command) ?? path ?? JSON.stringify(args)).slice(0, 8000), path };
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
  /** Totals as of the last turn's end, from Claude Code's per-model usage. */
  private settled: Tokens = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
  private split?: CostSplit;
  /** This turn's model calls so far, by message ID (a message repeats per content block). */
  private calls = new Map<string, Tokens>();
  /** Dollars per input token, learned from the last turn's cost, for pricing the running one. */
  private price?: number;
  private cacheMinutes?: number;
  /** Claude Code says how big the window is only when a turn ends; a lead's first turn can last the whole goal, so guess until then. */
  private contextWindow?: number;

  constructor(bin: string, env: Record<string, string>, spec: SessionSpec, ev: SessionEvents, resume?: string) {
    this.ev = ev;
    this.nativeId = resume ?? randomUUID();
    this.contextWindow = /\[1m\]/i.test(spec.model) ? 1_000_000 : 200_000;
    this.proc = spawn(bin, claudeArgs(spec, this.nativeId, !!resume), {
      cwd: spec.cwd,
      env: { ...process.env, ...env, ...spec.env, MCP_TOOL_TIMEOUT: '900000' },
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
      this.onCall(m.message);
      for (const b of (m.message?.content ?? []) as Block[]) {
        if (b.type === 'text' && b.text?.trim()) this.ev.text(b.text);
        if (b.type === 'tool_use' && b.name) {
          const id = (b as { id?: string }).id;
          if (id) this.toolNames.set(id, b.name);
          // Our own tools are already logged by the daemon as they happen.
          if (!b.name.startsWith(`mcp__${MCP_SERVER_NAME}__`)) this.ev.toolCall(b.name, summarize(b.input), { kind: claudeToolRequest(b.name, b.input ?? {}).kind });
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

  /**
   * A model call in the running turn. Its input and cache counts are final; its output count
   * is only what had streamed, so the turn's end corrects it.
   */
  private onCall(msg: any): void {
    const u = msg?.usage;
    if (!u || !msg.id) return;
    const t: Tokens = { tokensIn: u.input_tokens ?? 0, tokensOut: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
    const prev = this.calls.get(msg.id);
    if (prev && prev.tokensOut >= t.tokensOut && prev.cacheWrite === t.cacheWrite) return;
    this.calls.set(msg.id, t);
    const c = u.cache_creation;
    if (c) this.cacheMinutes = c.ephemeral_1h_input_tokens > 0 ? 60 : c.ephemeral_5m_input_tokens > 0 ? 5 : this.cacheMinutes;
    const running = sum([...this.calls.values()]);
    const used = t.tokensIn + t.cacheRead + t.cacheWrite + t.tokensOut;
    this.ev.usage({
      ...add(this.settled, running),
      costUsd: this.costSoFar + (this.price ? weigh(running, this.cacheMinutes) * this.price : 0),
      ...(this.split ? { costSplit: this.split } : {}),
      ...(this.contextWindow ? { contextPct: Math.round((100 * used) / this.contextWindow) } : {}),
      contextTokens: used,
      ...(this.cacheMinutes ? { cacheMinutes: this.cacheMinutes } : {}),
    });
  }

  private reportUsage(m: any): void {
    // total_cost_usd covers this process's turns so far; keep the running maximum to be safe.
    if (typeof m.total_cost_usd === 'number') this.costSoFar = Math.max(this.costSoFar, m.total_cost_usd);
    this.calls.clear();
    // modelUsage: this process's totals by model, each with its cost.
    const models = Object.values(m.modelUsage ?? {}) as { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number; contextWindow?: number }[];
    this.contextWindow = models.find(x => x.contextWindow)?.contextWindow ?? this.contextWindow;
    if (models.length) {
      const per = models.map(x => ({ t: { tokensIn: x.inputTokens ?? 0, tokensOut: x.outputTokens ?? 0, cacheRead: x.cacheReadInputTokens ?? 0, cacheWrite: x.cacheCreationInputTokens ?? 0 }, cost: x.costUSD ?? 0 }));
      this.settled = sum(per.map(p => p.t));
      this.split = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const p of per) {
        const w = weigh(p.t, this.cacheMinutes);
        if (!w || !p.cost) continue;
        const each = p.cost / w;
        const s = splitOf(p.t, each, this.cacheMinutes);
        for (const k of Object.keys(s) as (keyof CostSplit)[]) this.split[k] += s[k];
      }
      // The model that did most of the work prices the next turn while it runs.
      const main = per.sort((a, b) => b.cost - a.cost)[0];
      if (main?.cost) this.price = main.cost / weigh(main.t, this.cacheMinutes);
    }
    const last = (m.usage?.iterations ?? []).at(-1) ?? m.usage ?? {};
    const used = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.output_tokens ?? 0);
    this.ev.usage({
      ...this.settled,
      costUsd: this.costSoFar,
      ...(this.split ? { costSplit: this.split } : {}),
      contextPct: this.contextWindow && used ? Math.round((100 * used) / this.contextWindow) : undefined,
      ...(used ? { contextTokens: used } : {}),
      ...(this.cacheMinutes ? { cacheMinutes: this.cacheMinutes } : {}),
    });
  }
}

type Tokens = Required<Pick<Usage, 'tokensIn' | 'tokensOut' | 'cacheRead' | 'cacheWrite'>>;

const add = (a: Tokens, b: Tokens): Tokens => ({ tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });
const sum = (ts: Tokens[]): Tokens => ts.reduce(add, { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Anthropic's price ratios to input: output 5×, cache reads 0.1×, cache writes 1.25× (5-minute
 * cache) or 2× (1-hour). Claude Code reports each model's cost but not its parts; these split it.
 */
const writeRatio = (cacheMinutes?: number) => (cacheMinutes === 60 ? 2 : 1.25);
const weigh = (t: Tokens, cacheMinutes?: number) => t.tokensIn + 5 * t.tokensOut + 0.1 * t.cacheRead + writeRatio(cacheMinutes) * t.cacheWrite;
const splitOf = (t: Tokens, each: number, cacheMinutes?: number): CostSplit => ({
  input: t.tokensIn * each,
  output: 5 * t.tokensOut * each,
  cacheRead: 0.1 * t.cacheRead * each,
  cacheWrite: writeRatio(cacheMinutes) * t.cacheWrite * each,
});

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
    window: typeof r.rateLimitType === 'string' ? claudeWindow(r.rateLimitType) : undefined,
  };
}

/** five_hour → 5h, seven_day_sonnet → 7d sonnet; /usage's "session" → 5h, "week (Sonnet only)" → 7d sonnet. */
export function claudeWindow(name: string): string {
  const n = name.toLowerCase();
  const span = /five_hour|session/.test(n) ? '5h' : /seven_day|week/.test(n) ? '7d' : n;
  const only = /opus|sonnet|haiku|fable/.exec(n)?.[0];
  return only ? `${span} ${only}` : span;
}

/**
 * The windows in `claude -p /usage`'s text, e.g. "Current session: 37% used · resets Oct 19,
 * 2:20am (Africa/Cairo)" and "Current week (all models): 57% used · resets Oct 23, 7am (…)".
 * Nothing for an API key, which has no plan windows.
 */
export function claudeUsage(text: string, now = Date.now()): RateLimitInfo | undefined {
  const windows: LimitWindow[] = [];
  for (const m of text.matchAll(/^\s*Current ([^:\n]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+([^\n]+))?/gim)) {
    const resetsAt = m[3] ? parseReset(m[3], now) : undefined;
    windows.push({ name: claudeWindow(m[1].trim()), usedPct: Math.round(Number(m[2])), ...(resetsAt ? { resetsAt } : {}) });
  }
  if (!windows.length) return undefined;
  const top = windows.slice().sort((a, b) => b.usedPct - a.usedPct)[0];
  return { status: top.usedPct >= 100 ? 'limited' : 'ok', usedPct: top.usedPct, resetsAt: top.resetsAt, window: top.name, windows };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Oct 19, 2:20am (Africa/Cairo)" or "7am (Africa/Cairo)": the next such moment, in ms. */
export function parseReset(s: string, now = Date.now()): number | undefined {
  const m = /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i.exec(s.trim());
  if (!m) return undefined;
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (m[1] && month < 0) return undefined;
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const minute = Number(m[4] ?? 0);
  const zone = m[6]?.trim();
  const today = zonedParts(now, zone);
  if (!today) return undefined;
  if (month < 0) {
    const t = zonedTime(today.year, today.month, today.day, hour, minute, zone);
    return t < now - 60_000 ? zonedTime(today.year, today.month, today.day + 1, hour, minute, zone) : t;
  }
  const day = Number(m[2]);
  const t = zonedTime(today.year, month, day, hour, minute, zone);
  // No year is given: a date well in the past means next year's.
  return t < now - 2 * 86_400_000 ? zonedTime(today.year + 1, month, day, hour, minute, zone) : t;
}

/** The wall clock in a time zone (the machine's when none or an unknown one is given). */
function zonedParts(t: number, zone?: string): { year: number; month: number; day: number; hour: number; minute: number } | undefined {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const p = Object.fromEntries(f.formatToParts(t).map(x => [x.type, Number(x.value)]));
    return { year: p.year, month: p.month - 1, day: p.day, hour: p.hour, minute: p.minute };
  } catch {
    return zone ? zonedParts(t) : undefined;
  }
}

/** The moment a wall-clock time in a time zone happens. */
function zonedTime(year: number, month: number, day: number, hour: number, minute: number, zone?: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offset = (t: number) => {
    const p = zonedParts(t, zone)!;
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute) - Math.floor(t / 60_000) * 60_000;
  };
  const first = wall - offset(wall);
  // Twice, for a guess that lands across a daylight-saving change.
  return wall - offset(first);
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
