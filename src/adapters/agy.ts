import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { endTree, spawnTree } from '../procs.ts';
import { foldEfforts, nearestEffort } from '../effort.ts';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseFrontMatter } from '../config.ts';
import { MCP_SERVER_NAME } from '../mcp.ts';
import { agyMcpDef } from '../mcpservers.ts';
import { modelsFromLines, run } from '../harnesses.ts';
import { nativeSkillNames } from '../skills.ts';
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
 * - agy has no switch for the user's global customizations (~/.gemini/config/: MCP servers,
 *   hooks, plugins, workflows) and reads them from $HOME alone, so it runs with a HOME of ours
 *   that links to everything of the user's but those (agyHome); its commands get the real HOME
 *   back through BASH_ENV. The sign-in isn't in HOME, and conversations stay in the user's own
 *   folder. Skills are linked: a workspace skill wins over a global one of the same name, so each
 *   personal skill gets a stub saying it's off (design §18); so do the repository's
 *   .agents/skills, which come through the skill tool. Its built-in skills stay.
 * - No interrupt: the daemon restarts the session from its conversation ID instead.
 * - Usage limits come from `agy -p=/quota`, per pool: Gemini models, Gemini 4 Argon, and
 *   Claude/GPT models each have their own.
 */
export class AgyAdapter implements HarnessAdapter {
  readonly manifest: CapabilityManifest = {
    harness: 'antigravity',
    injectMidTurn: false,
    // Through its PreInvocation hook, before each model call (Daemon.hook).
    pullsMessages: true,
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
  /** Where agy's own HOME is kept (agyHome); none runs it with the user's. */
  private isolate?: string;
  private userHome: string;
  /** `agy models`, folded into models and their efforts (asked once). */
  private models?: Promise<ReturnType<typeof foldEfforts> | undefined>;
  /** `agy --help` (asked once), for the flags this version has. */
  private help?: Promise<string>;

  constructor(opts: { bin?: string; id?: string; hookScript?: string; isolate?: string; userHome?: string } = {}) {
    this.bin = opts.bin ?? 'agy';
    if (opts.id) this.manifest.harness = opts.id;
    this.hookScript = opts.hookScript ?? join(import.meta.dirname, 'agy-hook.ts');
    this.isolate = opts.isolate;
    this.userHome = opts.userHome ?? homedir();
  }

  /** The environment agy runs in: its own HOME when isolated, the user's for its commands. */
  private env(): NodeJS.ProcessEnv {
    return this.isolate ? { ...process.env, ...agyHome(this.isolate, this.userHome) } : process.env;
  }

  account(model: string): string {
    return `${this.manifest.harness}:${quotaPool(model)}`;
  }

  toolRequest(tool: string, args: Record<string, unknown>): ToolRequest {
    return agyToolRequest(tool, args);
  }

  nativeCommand(sessionId: string): string {
    return `${this.bin} --conversation ${sessionId}`;
  }

  async start(spec: SessionSpec, events: SessionEvents, opts: StartOptions = {}): Promise<Session> {
    if (!spec.mcpUrl || !spec.hookUrl) throw new Error('the daemon has no address for MCP and hooks yet (is the server running?)');
    writeAgentConfig(spec, this.hookScript, undefined, this.userHome);
    spec = { ...spec, model: await this.modelFor(spec.model, spec.effort) };
    const s = new AgySession(this.bin, spec, this.env(), events, opts.resume, () => this.refreshQuota(true), await this.extraArgs());
    this.sessions.add(s);
    s.closed.then(() => this.sessions.delete(s));
    await s.ready;
    this.refreshQuota();
    this.quotaTimer ??= setInterval(() => this.sessions.size && this.refreshQuota(), 5 * 60_000).unref();
    return s;
  }

  /**
   * Antigravity names a model once per effort (gemini-3.8-flash-high) and takes no --effort with
   * a bare name (tried: it hangs). A name with its effort is used as written; a bare one gets the
   * listed variant nearest the effort asked for, medium when none is.
   */
  async modelFor(model: string, effort?: string): Promise<string> {
    if (!model) return model;
    this.models ??= run(this.bin, ['models'], process.env, 30_000).then(r => (r.code === 0 ? foldEfforts(modelsFromLines(r.out)) : undefined));
    const list = await this.models.catch(() => undefined);
    if (list?.variants[model]) return model;
    const efforts = list?.efforts[model];
    if (efforts) return `${model}-${nearestEffort(effort ?? 'medium', efforts) ?? efforts[0]}`;
    return effort && !list ? `${model}-${effort}` : model;
  }

  /**
   * Flags only some versions take. A message starting with `/` is otherwise run as agy's own
   * command, and under stream-json one like /help ends the process (1.4.7).
   */
  private async extraArgs(): Promise<string[]> {
    this.help ??= run(this.bin, ['--help'], process.env, 30_000).then(r => r.out, () => '');
    return (await this.help).includes('--disable-slash-commands') ? ['--disable-slash-commands'] : [];
  }

  /** Reads the quota (at most once a minute unless forced) and tells every session where its pool stands. */
  private refreshQuota(force = false): void {
    if (this.quotaRunning || (!force && Date.now() - this.quotaAt < 60_000)) return;
    this.quotaAt = Date.now();
    this.quotaRunning = this.quotaGroups()
      .then(groups => {
        for (const s of this.sessions) {
          const info = quotaInfo(groups, s.model);
          if (info) s.reportLimit(info);
        }
      })
      .catch(() => {
        /* an older agy, or not JSON: no quota then */
      })
      .finally(() => (this.quotaRunning = undefined));
  }

  /** `agy -p=/quota` answers locally, without a turn. */
  private async quotaGroups(): Promise<{ name?: string; buckets?: Bucket[] }[]> {
    // Isolated too: print mode starts the global MCP servers even for /quota.
    const r = await run(this.bin, ['-p=/quota', '--output-format', 'json'], this.env(), 60_000);
    try {
      return JSON.parse(r.stdout).command?.data?.groups ?? [];
    } catch {
      throw new Error(`agy /quota said: ${r.out.slice(0, 200) || `exit ${r.code}`}`);
    }
  }

  /** Every pool's quota. */
  async readLimits(): Promise<Record<string, RateLimitInfo>> {
    const groups = await this.quotaGroups();
    const out: Record<string, RateLimitInfo> = {};
    for (const pool of POOLS) {
      const info = quotaInfo(groups, pool.model);
      if (info) out[`${this.manifest.harness}:${pool.id}`] = info;
    }
    return out;
  }
}

/** Antigravity's quota pools, each with a model that draws on it. */
const POOLS = [
  { id: 'gemini', model: 'gemini' },
  { id: 'argon', model: 'gemini-argon' },
  { id: 'claude-gpt', model: 'claude' },
];

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
  // Argon draws on the Gemini pool too, so its own windows are named apart.
  const nameOf = (b: Bucket) => `${pool === 'argon' && (b.id ?? '').includes('argon') ? 'argon ' : ''}${b.window === 'weekly' ? '7d' : (b.window ?? b.id ?? 'window')}`;
  const resetOf = (b: Bucket) => (b.reset_time && Number.isFinite(Date.parse(b.reset_time)) ? Date.parse(b.reset_time) : undefined);
  const tight = buckets.slice().sort((a, b) => a.remaining_fraction! - b.remaining_fraction!)[0];
  return {
    status: tight.remaining_fraction! <= 0 ? 'limited' : 'ok',
    usedPct: Math.round((1 - tight.remaining_fraction!) * 100),
    resetsAt: resetOf(tight),
    window: nameOf(tight),
    windows: buckets.map(b => ({
      name: nameOf(b),
      usedPct: Math.round((1 - b.remaining_fraction!) * 100),
      ...(resetOf(b) ? { resetsAt: resetOf(b) } : {}),
    })),
  };
}

/**
 * What agy sees of ~/.gemini/config: its state, and the skills (stubbed per role). Anything else
 * there is a customization (mcp_config.json, hooks.json, plugins, workflows, sidecars), or a kind
 * a newer agy adds, so it stays out.
 */
const AGY_CONFIG_KEPT = ['config.json', 'projects', '.migrated', 'skills', 'skills.json'];
/** Kept out of ~/.gemini: the config (rebuilt above), global rules, and automations. */
const AGY_GEMINI_HIDDEN = ['config', 'GEMINI.md', 'AGENTS.md', 'jetski'];

/**
 * agy's own HOME under `dir`, made of links to the user's: everything in their home but .gemini,
 * everything in .gemini but the config, and the config's AGY_CONFIG_KEPT. Brought up to date on
 * each start. Returns the variables to run agy with; a BASH_ENV file gives its commands the
 * user's HOME back (agy runs them with `bash -c`), and still reads the user's own BASH_ENV.
 */
export function agyHome(dir: string, userHome = homedir()): { HOME: string; BASH_ENV: string } {
  const home = join(dir, 'home');
  const gemini = join(userHome, '.gemini');
  linkEntries(userHome, home, name => name !== '.gemini');
  linkEntries(gemini, join(home, '.gemini'), name => !AGY_GEMINI_HIDDEN.includes(name));
  linkEntries(join(gemini, 'config'), join(home, '.gemini', 'config'), name => AGY_CONFIG_KEPT.includes(name));
  const bashEnv = join(dir, 'bash-env.sh');
  const userBashEnv = process.env.BASH_ENV;
  writeFileSync(
    bashEnv,
    `# Written by MetaHarness: agy runs with a HOME of its own, its commands with the user's.\nexport HOME=${shq(userHome)}\n${userBashEnv ? `. ${shq(userBashEnv)}\n` : ''}`,
  );
  return { HOME: home, BASH_ENV: bashEnv };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Links in `dst` to each entry of `src` that `keep` takes; links that no longer fit go, agy's own files stay. */
function linkEntries(src: string, dst: string, keep: (name: string) => boolean): void {
  mkdirSync(dst, { recursive: true });
  const want = new Set(existsSync(src) ? readdirSync(src).filter(name => keep(name) && join(src, name) !== dst) : []);
  for (const name of readdirSync(dst)) {
    const p = join(dst, name);
    if (lstatSync(p).isSymbolicLink() && (!want.has(name) || readlinkSync(p) !== join(src, name))) rmSync(p, { force: true });
  }
  for (const name of want) {
    try {
      symlinkSync(join(src, name), join(dst, name));
    } catch (e) {
      // Another agent starting at the same time made it, or agy keeps a file of its own there.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** Where agy finds the user's own skills, one folder each. */
export const AGY_PERSONAL_SKILLS = join(homedir(), '.gemini', 'config', 'skills');

/** The names of the user's own agy skills: each folder's SKILL.md name, else the folder's. */
export function agyPersonalSkills(dir = AGY_PERSONAL_SKILLS): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, e.name, 'SKILL.md');
    if (!e.isDirectory() || !existsSync(file)) continue;
    const name = parseFrontMatter(readFileSync(file, 'utf8')).meta.name || e.name;
    if (/^[\w.:-]+$/.test(name)) out.push(name);
  }
  return out;
}

/**
 * The skills agy would load that MetaHarness hides: the user's own, and the repository's
 * .agents/skills, which reach every harness through the skill tool instead. None for a role with
 * native_skills.
 */
export function agyHiddenSkills(spec: SessionSpec, personal = agyPersonalSkills()): string[] {
  return spec.role.nativeSkills ? [] : [...new Set([...personal, ...nativeSkillNames(join(spec.cwd, '.agents', 'skills'))])];
}

/**
 * The agent's own customization root: our MCP server, the hooks, the role prompt as an always-on
 * rule, and a stub for each hidden skill.
 */
export function writeAgentConfig(spec: SessionSpec, hookScript: string, hidden = agyHiddenSkills(spec), userHome = homedir()): void {
  const dir = join(spec.agentDir, '.agents');
  mkdirSync(join(dir, 'rules'), { recursive: true });
  rmSync(join(dir, 'skills'), { recursive: true, force: true });
  for (const name of hidden) {
    mkdirSync(join(dir, 'skills', name.replace(/:/g, '-')), { recursive: true });
    writeFileSync(
      join(dir, 'skills', name.replace(/:/g, '-'), 'SKILL.md'),
      `---\nname: ${name}\ndescription: Turned off for this team by MetaHarness. Don't use it.\n---\nThis skill is turned off for MetaHarness agents, so every harness on the team has the same skills. Carry on without it.\n`,
    );
  }
  // Ours, plus the role's servers: MetaHarness's definition, else the user's own agy config, which
  // agy itself doesn't see. One it starts gets the user's HOME, as commands do.
  const servers: Record<string, unknown> = { [MCP_SERVER_NAME]: { url: spec.mcpUrl } };
  for (const s of spec.mcpServers ?? []) {
    const def = s.name === MCP_SERVER_NAME ? undefined : (s.def ?? agyMcpDef(s.name, userHome));
    if (def) servers[s.name] = def.command ? { ...def, env: { HOME: userHome, ...def.env } } : def;
  }
  writeFileSync(join(dir, 'mcp_config.json'), JSON.stringify({ mcpServers: servers }, null, 2));
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

export function agyArgs(spec: SessionSpec, resume?: string, extra: string[] = []): string[] {
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    // Every tool is checked by our PreToolUse hook instead; print mode can't ask the human.
    '--dangerously-skip-permissions',
    '--add-dir', spec.sharedDir,
    '--add-dir', spec.agentDir,
    ...extra,
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
    // The browser's own state (agy's browser profile is the user's), its inbox (list and read),
    // and the plugin marketplace and accounts, which only list.
    case 'browser_get_dom': case 'capture_browser_screenshot': case 'capture_browser_console_logs':
    case 'browser_list_network_requests': case 'browser_get_network_request':
    case 'manage_inbox': case 'search_marketplace': case 'list_plugin_accounts':
      return { kind: 'read', tool, detail: path ?? JSON.stringify(args).slice(0, 300), path };
    case 'manage_task': {
      // Its own background commands and timers: listing, reading and stopping them stay inside the session.
      const action = pick(args, 'Action') ?? '';
      if (action === 'send_input') return { kind: 'shell', tool: 'Bash input', detail: JSON.stringify(args).slice(0, 8000) };
      return { kind: 'read', tool, detail: `${action} ${pick(args, 'TaskId') ?? ''}`.trim() };
    }
    case 'notebook_execution':
      return { kind: 'shell', tool: 'Notebook', detail: JSON.stringify(args).slice(0, 8000), path };
    case 'delete_knowledge':
      // Knowledge is the user's, shared by every agy session (the isolated HOME links to it).
      return { kind: 'edit', tool: 'Delete knowledge', detail: JSON.stringify(args).slice(0, 8000) };
    case 'send_message':
      return { kind: 'message', tool, detail: `${pick(args, 'Recipient') ?? '?'}: ${pick(args, 'Message') ?? ''}`.slice(0, 300) };
    case 'schedule':
      return { kind: 'schedule', tool, detail: JSON.stringify(args).slice(0, 300) };
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
    // run_workflow: a Python script that starts agents (and calls tools) of its own.
    case 'invoke_subagent': case 'define_subagent': case 'manage_subagents': case 'browser_subagent': case 'run_workflow':
      return { kind: 'delegate', tool, detail: JSON.stringify(args).slice(0, 300) };
    case 'ask_question': case 'ask_permission': case 'ask_custom_permission':
      return { kind: 'ask_user', tool, detail: JSON.stringify(args).slice(0, 300) };
    default:
      // The human decides: browser actions (open_browser_url, clicks, typing, scripts), which act
      // as the user on their signed-in sites, generate_image, which spends quota, and new tools.
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
  /** It answered after its last tool call: a turn that then reports an error has recovered from it. */
  private answered = false;
  private onError: () => void;

  constructor(bin: string, spec: SessionSpec, env: NodeJS.ProcessEnv, ev: SessionEvents, resume: string | undefined, onError: () => void, extra: string[] = []) {
    this.ev = ev;
    this.model = spec.model;
    this.onError = onError;
    if (resume) this.nativeId = resume;
    this.proc = spawnTree(bin, agyArgs(spec, resume, extra), {
      cwd: spec.cwd,
      env: { ...env, ...spec.env, MH_HOOK_URL: spec.hookUrl },
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
    endTree(this.proc);
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
        if (text) {
          this.ev.text(text);
          this.answered = true;
        }
      }
    } else if (s.step_type === 'tool') {
      this.answered = false;
      const info = s.tool_info ?? {};
      const params = info.parameters ?? {};
      // Our own tools are already logged by the daemon as they happen.
      const ours = s.tool_name === 'call_mcp_tool' && params.ServerName === MCP_SERVER_NAME;
      if (ours) return;
      if (!this.toolsSeen.has(idx)) {
        this.toolsSeen.add(idx);
        const t = agyToolRequest(String(s.tool_name ?? info.name ?? 'tool'), params);
        this.ev.toolCall(t.tool, t.detail.slice(0, 160), { kind: t.kind });
      }
      if (s.state === 'DONE') this.ev.toolResult(String(info.output ?? '').slice(0, 200), true);
      else if (s.state === 'ERROR') this.ev.toolResult(String(info.error?.message ?? 'failed').slice(0, 200), false);
    }
  }

  private result(r: any): void {
    if (r.conversation_id) this.nativeId = r.conversation_id;
    const u = r.usage ?? {};
    const cached = u.cache_read_tokens ?? u.cached_input_tokens ?? u.cache_read_input_tokens;
    this.ev.usage({
      tokensIn: u.input_tokens !== undefined && cached !== undefined ? Math.max(0, u.input_tokens - cached) : u.input_tokens,
      cacheRead: cached,
      tokensOut: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0),
    });
    if (r.status && r.status !== 'SUCCESS') {
      const why = String(r.error ?? r.status);
      this.onError();
      // Seen: an attempt timed out, agy retried, and the turn went on to answer. The answer stays
      // the turn's last words, and the error is a warning beside it.
      if (this.answered) this.ev.warning?.(`Antigravity reported an error it recovered from: ${why.slice(0, 300)}`);
      else {
        if (LIMIT_ERROR.test(why)) this.ev.rateLimit({ status: 'limited' });
        this.ev.text(`(turn ended with an error: ${why.slice(0, 300)})`);
      }
    }
    this.answered = false;
    this.toolsSeen.clear();
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending === 0 && this.running) {
      this.running = false;
      this.ev.turnEnded();
    }
  }
}
