import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_SERVER_NAME } from '../mcp.ts';
import type { CapabilityManifest, HarnessAdapter, RateLimitInfo, Session, SessionEvents, SessionSpec, StartOptions, ToolRequest } from './types.ts';

/**
 * Antigravity CLI (`agy`) in print mode with stream-json in and out: one process per agent.
 * Checked against agy 1.4.1 (design Appendix A):
 * - Input lines are {"event":"user","message":{"role":"user","content":"..."}}. One written
 *   while a turn runs is queued as the next turn, so mid-turn delivery goes through a
 *   PreInvocation hook instead, which adds waiting messages before each model call.
 * - Approvals: agy can't prompt in print mode, so it runs with --dangerously-skip-permissions
 *   and a PreToolUse hook asks the daemon about every tool. The same hook refuses agy's own
 *   subagent tools.
 * - Our MCP server, the hooks and the role prompt live in the agent's own directory, added with
 *   --add-dir: every workspace is a customization root, so nothing touches the user's own
 *   agy config or the agent's worktree.
 * - No interrupt: the daemon restarts the session from its conversation ID instead.
 * - Usage limits come from `agy -p=/quota`, per pool: Gemini models, Gemini 4 Argon, and
 *   Claude/GPT models each have their own.
 */
export class AgyAdapter implements HarnessAdapter {
  readonly manifest: CapabilityManifest = {
    harness: 'antigravity',
    injectMidTurn: false,
    resume: true,
    interrupt: false,
    reportsCost: false,
    reportsContext: false,
    reportsRateLimits: true,
  };
  private bin: string;
  private sessions = new Set<AgySession>();
  private quotaAt = 0;
  private quotaRunning?: Promise<void>;
  private quotaTimer?: NodeJS.Timeout;
  private hookScript: string;

  constructor(opts: { bin?: string; id?: string; hookScript?: string } = {}) {
    this.bin = opts.bin ?? 'agy';
    if (opts.id) this.manifest.harness = opts.id;
    this.hookScript = opts.hookScript ?? join(import.meta.dirname, 'agy-hook.ts');
  }

  account(model: string): string {
    return `${this.manifest.harness}:${quotaPool(model)}`;
  }

  toolRequest(tool: string, args: Record<string, unknown>): ToolRequest {
    return agyToolRequest(tool, args);
  }

  async start(spec: SessionSpec, events: SessionEvents, opts: StartOptions = {}): Promise<Session> {
    if (!spec.mcpUrl || !spec.hookUrl) throw new Error('the daemon has no address for MCP and hooks yet (is the server running?)');
    writeAgentConfig(spec, this.hookScript);
    const s = new AgySession(this.bin, spec, events, opts.resume, () => this.refreshQuota(true));
    this.sessions.add(s);
    s.closed.then(() => this.sessions.delete(s));
    await s.ready;
    this.refreshQuota();
    this.quotaTimer ??= setInterval(() => this.sessions.size && this.refreshQuota(), 5 * 60_000).unref();
    return s;
  }

  /** Reads the quota (at most once a minute unless forced) and tells every session where its pool stands. */
  private refreshQuota(force = false): void {
    if (this.quotaRunning || (!force && Date.now() - this.quotaAt < 60_000)) return;
    this.quotaAt = Date.now();
    this.quotaRunning = new Promise<void>(resolve => {
      execFile(this.bin, ['-p=/quota', '--output-format', 'json'], { timeout: 60_000 }, (err, stdout) => {
        this.quotaRunning = undefined;
        resolve();
        if (err) return;
        try {
          const groups = JSON.parse(stdout).command?.data?.groups ?? [];
          for (const s of this.sessions) {
            const info = quotaInfo(groups, s.model);
            if (info) s.reportLimit(info);
          }
        } catch {
          /* an older agy, or not JSON: no quota then */
        }
      });
    });
  }
}

/** Which of Antigravity's quota pools a model draws on. */
export function quotaPool(model: string): string {
  if (/argon/i.test(model)) return 'argon';
  if (/^gemini/i.test(model) || !model) return 'gemini';
  return 'claude-gpt';
}

type Bucket = { id?: string; window?: string; remaining_fraction?: number; reset_time?: string };

/** The tightest quota bucket for a model, from `agy -p=/quota --output-format json`. */
export function quotaInfo(groups: { name?: string; buckets?: Bucket[] }[], model: string): RateLimitInfo | undefined {
  const pool = quotaPool(model);
  const wanted = (g: { name?: string }, b: Bucket) => {
    const id = b.id ?? '';
    const name = g.name ?? '';
    if (pool === 'claude-gpt') return id.startsWith('3p-') || /claude|gpt/i.test(name);
    const gemini = id.startsWith('gemini-') || /^gemini models/i.test(name);
    const argon = id.startsWith('gemini-argon') || /argon/i.test(name);
    return pool === 'argon' ? gemini || argon : gemini && !argon;
  };
  const buckets = groups.flatMap(g => (g.buckets ?? []).filter(b => typeof b.remaining_fraction === 'number' && wanted(g, b)));
  if (!buckets.length) return undefined;
  const tight = buckets.sort((a, b) => a.remaining_fraction! - b.remaining_fraction!)[0];
  const resetsAt = tight.reset_time ? Date.parse(tight.reset_time) : NaN;
  return {
    status: tight.remaining_fraction! <= 0 ? 'limited' : 'ok',
    usedPct: Math.round((1 - tight.remaining_fraction!) * 100),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
    window: tight.window,
  };
}

/** The agent's own customization root: our MCP server, the hooks, and the role prompt as an always-on rule. */
export function writeAgentConfig(spec: SessionSpec, hookScript: string): void {
  const dir = join(spec.agentDir, '.agents');
  mkdirSync(join(dir, 'rules'), { recursive: true });
  writeFileSync(join(dir, 'mcp_config.json'), JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url: spec.mcpUrl } } }, null, 2));
  // The daemon's own Node, so the hook works whatever is on the agent's PATH.
  const hook = (event: string, timeout: number) => ({ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)} ${event}`, timeout });
  writeFileSync(
    join(dir, 'hooks.json'),
    JSON.stringify(
      {
        metaharness: {
          PreInvocation: [hook('pre-invocation', 15)],
          // Long enough for the human to answer an approval.
          PreToolUse: [{ matcher: '*', hooks: [hook('pre-tool', 1800)] }],
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'rules', 'metaharness.md'), `---\ntrigger: always_on\n---\n${spec.systemPrompt}\n`);
}

export function agyArgs(spec: SessionSpec, resume?: string): string[] {
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    // Every tool is checked by our PreToolUse hook instead; print mode can't ask the human.
    '--dangerously-skip-permissions',
    '--add-dir', spec.sharedDir,
    '--add-dir', spec.agentDir,
  ];
  if (spec.model) args.push('--model', spec.model);
  if (resume) args.push('--conversation', resume);
  // -p takes the prompt as its value; with stream-json input the prompts come on stdin.
  args.push('-p=');
  return args;
}

const pick = (args: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (args[k] !== undefined && args[k] !== null && args[k] !== '') return String(args[k]);
  return undefined;
};

/** What an agy tool call means for the approval policy. */
export function agyToolRequest(tool: string, args: Record<string, unknown>): ToolRequest {
  const path = pick(args, 'TargetFile', 'AbsolutePath', 'FilePath', 'File', 'Path', 'path', 'file_path', 'DirectoryPath');
  switch (tool) {
    case 'view_file': case 'list_dir': case 'grep_search': case 'find_by_name': case 'read_url_content': case 'search_web':
    case 'command_status': case 'list_resources': case 'read_resource': case 'list_permissions': case 'wait': case 'wait_5_seconds':
    case 'finish': case 'list_browser_pages': case 'read_browser_page':
      return { kind: 'read', tool, detail: path ?? JSON.stringify(args).slice(0, 300), path };
    case 'write_to_file': case 'replace_file_content': case 'multi_replace_file_content': case 'sed_file': case 'notebook_edit':
      return { kind: 'edit', tool: 'Edit', detail: path ?? JSON.stringify(args).slice(0, 8000), path };
    case 'run_command':
      return { kind: 'shell', tool: 'Bash', detail: pick(args, 'CommandLine', 'Command', 'command') ?? JSON.stringify(args) };
    case 'send_command_input':
      return { kind: 'shell', tool: 'Bash input', detail: JSON.stringify(args).slice(0, 8000) };
    case 'call_mcp_tool': {
      const server = pick(args, 'ServerName', 'server') ?? '';
      return { kind: 'mcp', tool: `${server}.${pick(args, 'ToolName', 'tool') ?? '?'}`, detail: JSON.stringify(args.Arguments ?? {}).slice(0, 8000), server };
    }
    case 'invoke_subagent': case 'define_subagent': case 'manage_subagents': case 'browser_subagent':
      return { kind: 'delegate', tool, detail: JSON.stringify(args).slice(0, 300) };
    case 'ask_question': case 'ask_permission': case 'ask_custom_permission':
      return { kind: 'ask_user', tool, detail: JSON.stringify(args).slice(0, 300) };
    default:
      return { kind: 'other', tool, detail: JSON.stringify(args).slice(0, 8000), path };
  }
}

/** How a refused turn reads when the quota is spent. */
const LIMIT_ERROR = /quota|rate limit|resource.?exhausted|limit (reached|exceeded)/i;

class AgySession implements Session {
  nativeId = '';
  readonly model: string;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  private proc: ChildProcessWithoutNullStreams;
  private ev: SessionEvents;
  /** Turns written and not yet answered: agy runs each input line as its own turn. */
  private pending = 0;
  private running = false;
  private stopped = false;
  private buf = '';
  private stderrTail = '';
  private texts = new Map<number, string>();
  private toolsSeen = new Set<number>();
  private onError: () => void;

  constructor(bin: string, spec: SessionSpec, ev: SessionEvents, resume: string | undefined, onError: () => void) {
    this.ev = ev;
    this.model = spec.model;
    this.onError = onError;
    if (resume) this.nativeId = resume;
    this.proc = spawn(bin, agyArgs(spec, resume), {
      cwd: spec.cwd,
      env: { ...process.env, MH_HOOK_URL: spec.hookUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let started!: () => void;
    let failed!: (e: Error) => void;
    this.ready = new Promise((res, rej) => ((started = res), (failed = rej)));
    let closed!: () => void;
    this.closed = new Promise(res => (closed = res));
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk, started));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-2000)));
    this.proc.on('error', err => {
      failed(err);
      this.crash(err.message);
    });
    this.proc.on('exit', code => {
      closed();
      const why = `agy exited with code ${code}. ${this.stderrTail.trim()}`.trim();
      failed(new Error(why));
      if (!this.stopped) this.crash(why);
    });
    // Started right away, like the other adapters, so early messages wait for this turn.
    if (spec.brief) void this.send(spec.brief, 'new_turn');
  }

  busy(): boolean {
    return this.running;
  }

  reportLimit(info: RateLimitInfo): void {
    if (!this.stopped) this.ev.rateLimit(info);
  }

  async send(text: string, _how: 'inject' | 'new_turn'): Promise<void> {
    if (this.stopped || !this.proc.stdin.writable) return;
    // There is no injecting into a running agy turn; a line written now becomes the next turn.
    this.pending++;
    if (!this.running) {
      this.running = true;
      this.ev.turnStarted();
    }
    this.proc.stdin.write(JSON.stringify({ event: 'user', message: { role: 'user', content: text } }) + '\n');
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

  private onData(chunk: string, started: () => void): void {
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
      if (m.event === 'init') {
        this.nativeId = m.conversation_id ?? this.nativeId;
        started();
      } else if (m.event === 'step_update') this.step(m.step_update ?? {});
      else if (m.event === 'result') this.result(m.result ?? {});
    }
  }

  private step(s: any): void {
    const idx = Number(s.step_index);
    if (s.step_type === 'agent_response') {
      if (s.text_delta) this.texts.set(idx, (this.texts.get(idx) ?? '') + s.text_delta);
      if (s.state === 'DONE') {
        const text = this.texts.get(idx)?.trim();
        this.texts.delete(idx);
        if (text) this.ev.text(text);
      }
    } else if (s.step_type === 'tool') {
      const info = s.tool_info ?? {};
      const params = info.parameters ?? {};
      // Our own tools are already logged by the daemon as they happen.
      const ours = s.tool_name === 'call_mcp_tool' && params.ServerName === MCP_SERVER_NAME;
      if (ours) return;
      if (!this.toolsSeen.has(idx)) {
        this.toolsSeen.add(idx);
        const t = agyToolRequest(String(s.tool_name ?? info.name ?? 'tool'), params);
        this.ev.toolCall(t.tool, t.detail.slice(0, 160));
      }
      if (s.state === 'DONE') this.ev.toolResult(String(info.output ?? '').slice(0, 200), true);
      else if (s.state === 'ERROR') this.ev.toolResult(String(info.error?.message ?? 'failed').slice(0, 200), false);
    }
  }

  private result(r: any): void {
    if (r.conversation_id) this.nativeId = r.conversation_id;
    const u = r.usage ?? {};
    this.ev.usage({ tokensIn: u.input_tokens, tokensOut: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) });
    if (r.status && r.status !== 'SUCCESS') {
      const why = String(r.error ?? r.status);
      if (LIMIT_ERROR.test(why)) this.ev.rateLimit({ status: 'limited' });
      this.onError();
      this.ev.text(`(turn ended with an error: ${why.slice(0, 300)})`);
    }
    this.toolsSeen.clear();
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending === 0 && this.running) {
      this.running = false;
      this.ev.turnEnded();
    }
  }
}
