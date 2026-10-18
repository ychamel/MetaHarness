import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { parseFrontMatter } from './config.ts';
import { claudeMcpNames } from './mcpservers.ts';

/**
 * Harness profiles (design §16): one harness on one transport. Transports are code (the
 * adapters); profiles are data, so a harness that speaks a known transport needs no code.
 */

/** How MetaHarness talks to a harness. Each one is an adapter. */
export const TRANSPORTS = ['claude-stream', 'codex-app-server', 'agy-stream', 'acp'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface LoginStatus {
  /** undefined when the harness has no way to tell. */
  signedIn?: boolean;
  detail: string;
}

export interface HarnessProfile {
  id: string;
  title: string;
  bin: string;
  /** Unset for a harness we can find but can't drive yet. */
  transport?: Transport;
  /** Arguments that start the transport, e.g. ["acp"] for `opencode acp`. */
  args?: string[];
  /** Extra environment for the harness, e.g. ANTHROPIC_BASE_URL for Claude Code on another provider. */
  env?: Record<string, string>;
  /** Where to get it, shown when it isn't installed. */
  install?: string;
  /** The command the user runs to sign in. MetaHarness never handles credentials itself. */
  login?: string;
  versionArgs?: string[];
  loginStatus?: (bin: string, env: NodeJS.ProcessEnv) => Promise<LoginStatus>;
  listModels?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string[]>;
  /** Models known without asking the harness, such as Claude Code's aliases. */
  models?: string[];
  /** A cheap model for `mh test`. */
  probeModel?: string;
  /** The MCP servers the harness itself has configured, by name (for roles' `mcp:` names). */
  listMcp?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string[]>;
  /** The profile file, for user profiles. */
  file?: string;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout = 20_000): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(bin, args, { env, timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** The first word of each line that looks like a model ID, e.g. from `agy models`. */
function modelsFromLines(out: string): string[] {
  return out
    .split('\n')
    .map(l => l.trim().split(/\s+/)[0])
    .filter(w => w && /^[\w][\w.:/-]*$/.test(w) && /\d|-/.test(w));
}

/** Asks a `codex app-server` for its model list, then shuts it down. */
function codexModels(bin: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => finish(new Error('codex app-server did not answer in 20s')), 20_000);
    let buf = '';
    const finish = (err: Error | null, models: string[] = []) => {
      clearTimeout(timer);
      proc.kill();
      if (err) reject(err);
      else resolve(models);
    };
    const send = (m: unknown) => proc.stdin.write(JSON.stringify(m) + '\n');
    proc.on('error', e => finish(e));
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} });
        } else if (m.id === 2) {
          if (m.error) return finish(new Error(m.error.message ?? 'model/list failed'));
          const data = (m.result?.data ?? []) as { id?: string; model?: string; hidden?: boolean }[];
          finish(null, data.filter(x => !x.hidden).map(x => x.id ?? x.model ?? '').filter(Boolean));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'metaharness', title: 'MetaHarness', version: '0.0.1' }, capabilities: null } });
  });
}

/** The harnesses MetaHarness knows. Ones without a transport are found and reported, not driven. */
export const BUILTIN_PROFILES: HarnessProfile[] = [
  {
    id: 'claude-code',
    title: 'Claude Code',
    bin: 'claude',
    transport: 'claude-stream',
    install: 'https://claude.com/claude-code',
    login: 'claude auth login',
    loginStatus: async (bin, env) => {
      const r = await run(bin, ['auth', 'status'], env);
      try {
        const s = JSON.parse(r.out);
        return { signedIn: s.loggedIn === true, detail: [s.authMethod, s.subscriptionType].filter(Boolean).join(', ') || (s.loggedIn ? 'signed in' : 'signed out') };
      } catch {
        return { signedIn: r.code === 0 ? undefined : false, detail: r.out.split('\n')[0] ?? '' };
      }
    },
    probeModel: 'haiku',
    listMcp: async () => claudeMcpNames(process.cwd()),
    models: ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  },
  {
    id: 'codex',
    title: 'Codex',
    bin: 'codex',
    transport: 'codex-app-server',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    loginStatus: async (bin, env) => {
      const r = await run(bin, ['login', 'status'], env);
      return { signedIn: r.code === 0, detail: r.out.split('\n')[0] ?? '' };
    },
    listModels: codexModels,
    probeModel: 'gpt-6-luna',
    listMcp: async (bin, env) => {
      const r = await run(bin, ['mcp', 'list', '--json'], env);
      return r.code === 0 ? (JSON.parse(r.out) as { name: string }[]).map(x => x.name) : [];
    },
  },
  {
    id: 'antigravity',
    title: 'Antigravity CLI',
    bin: 'agy',
    transport: 'agy-stream',
    install: 'https://antigravity.google',
    login: 'agy (sign in when it starts)',
    probeModel: 'gemini-3.8-flash-low',
    listMcp: async (bin, env) => {
      const r = await run(bin, ['mcp', 'list'], env);
      return r.code === 0 && !/no mcp servers/i.test(r.out) ? r.out.split('\n').map(l => l.trim().split(/[\s:]+/)[0]).filter(w => /^[\w-]+$/.test(w)) : [];
    },
    // agy has no status command; its model list only loads when it's signed in.
    listModels: async (bin, env) => {
      const r = await run(bin, ['models'], env, 30_000);
      if (r.code !== 0) throw new Error(r.out.split('\n').pop() || `agy models exited with ${r.code}`);
      return modelsFromLines(r.out);
    },
  },
  // Found and reported so the user knows where they stand; MetaHarness can't drive them yet.
  { id: 'cursor', title: 'Cursor CLI', bin: 'cursor-agent' },
  { id: 'gemini-cli', title: 'Gemini CLI', bin: 'gemini' },
  {
    id: 'opencode',
    title: 'OpenCode',
    bin: 'opencode',
    transport: 'acp',
    args: ['acp'],
    install: 'npm install -g opencode-ai',
    login: 'opencode auth login',
    // Its inline config, which outranks the user's: ask MetaHarness before edits and commands
    // (so the approval policy and the git guard's refusals apply), and leave delegation and
    // questions to MetaHarness (spawn, send to human).
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: {
          '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', lsp: 'allow', todowrite: 'allow', todoread: 'allow',
          'metaharness_*': 'allow', task: 'deny', question: 'deny',
        },
      }),
    },
    loginStatus: async (bin, env) => {
      const r = await run(bin, ['auth', 'list'], env);
      const n = /(\d+)\s+credentials?/i.exec(r.out)?.[1];
      return { signedIn: r.code === 0 ? (n ? Number(n) > 0 : undefined) : false, detail: r.out.split('\n').filter(Boolean).slice(-1)[0] ?? '' };
    },
    listModels: async (bin, env) => {
      const r = await run(bin, ['models'], env, 30_000);
      if (r.code !== 0) throw new Error(r.out.split('\n').pop() || `opencode models exited with ${r.code}`);
      return modelsFromLines(r.out);
    },
  },
  { id: 'copilot', title: 'GitHub Copilot CLI', bin: 'copilot' },
  { id: 'qwen-code', title: 'Qwen Code', bin: 'qwen' },
  { id: 'goose', title: 'Goose', bin: 'goose' },
];

/**
 * A user profile: .metaharness/harnesses/<id>.md. Front matter keys: title, bin, transport,
 * args (what starts the transport, e.g. "--experimental-acp"), env (KEY=value, comma separated), install, login, status_cmd (exit 0 means signed in),
 * models_cmd (one model per line) or models (comma separated), probe_model. It replaces a built-in
 * profile with the same id, keeping whatever it doesn't set.
 */
export function profileFromFile(file: string, text: string, base?: HarnessProfile): HarnessProfile {
  const { meta } = parseFrontMatter(text);
  const id = basename(file, '.md');
  const list = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const words = (v: string) => v.split(/\s+/).filter(Boolean);
  const transport = meta.transport ? (TRANSPORTS as readonly string[]).includes(meta.transport) ? (meta.transport as Transport) : undefined : base?.transport;
  const p: HarnessProfile = { ...base, id, title: meta.title || base?.title || id, bin: meta.bin || base?.bin || id, transport, file };
  if (meta.env) {
    p.env = { ...base?.env };
    for (const pair of list(meta.env)) {
      const eq = pair.indexOf('=');
      if (eq > 0) p.env[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  if (meta.args) p.args = words(meta.args);
  if (meta.install) p.install = meta.install;
  if (meta.login) p.login = meta.login;
  if (meta.status_cmd) {
    const [cmd, ...args] = words(meta.status_cmd);
    p.loginStatus = async (_bin, env) => {
      const r = await run(cmd, args, env);
      return { signedIn: r.code === 0, detail: r.out.split('\n')[0] ?? '' };
    };
  }
  if (meta.models_cmd) {
    const [cmd, ...args] = words(meta.models_cmd);
    p.listModels = async (_bin, env) => {
      const r = await run(cmd, args, env, 30_000);
      if (r.code !== 0) throw new Error(r.out.split('\n').pop() || `${meta.models_cmd} exited with ${r.code}`);
      return modelsFromLines(r.out);
    };
  }
  if (meta.models) p.models = list(meta.models);
  if (meta.probe_model) p.probeModel = meta.probe_model;
  return p;
}

/** Built-in profiles, overridden or extended by harnesses/*.md in each config directory. */
export function loadProfiles(dirs: string[]): Map<string, HarnessProfile> {
  const out = new Map(BUILTIN_PROFILES.map(p => [p.id, p]));
  for (const dir of dirs) {
    const d = join(dir, 'harnesses');
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter(f => f.endsWith('.md'))) {
      const file = join(d, f);
      const id = basename(f, '.md');
      out.set(id, profileFromFile(file, readFileSync(file, 'utf8'), out.get(id)));
    }
  }
  return out;
}

/** Where a binary is on PATH, if it's there. */
export function findBin(bin: string, path = process.env.PATH ?? ''): string | undefined {
  const candidates = bin.includes('/') ? [bin] : path.split(delimiter).filter(Boolean).map(dir => join(dir, bin));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* not here */
    }
  }
}

export interface HarnessReport {
  id: string;
  title: string;
  transport?: Transport;
  path?: string;
  version?: string;
  login?: LoginStatus;
  models: string[];
  modelsError?: string;
  install?: string;
  loginCommand?: string;
  /** MCP servers the harness has configured itself. */
  mcpNames: string[];
}

/** Checks one harness: installed, version, signed in, models. Runs only the CLI's own commands. */
export async function inspect(p: HarnessProfile): Promise<HarnessReport> {
  const rep: HarnessReport = { id: p.id, title: p.title, transport: p.transport, models: [...(p.models ?? [])], install: p.install, loginCommand: p.login, mcpNames: [] };
  rep.path = findBin(p.bin);
  if (!rep.path) return rep;
  const env = { ...process.env, ...p.env };
  const [version, login, models, mcp] = await Promise.all([
    run(rep.path, p.versionArgs ?? ['--version'], env, 10_000),
    p.loginStatus?.(rep.path, env).catch((e: Error) => ({ detail: e.message })),
    p.listModels?.(rep.path, env).then(
      m => ({ m }),
      (e: Error) => ({ e: e.message }),
    ),
    p.listMcp?.(rep.path, env).catch(() => []),
  ]);
  rep.mcpNames = mcp ?? [];
  if (version.code === 0) rep.version = /\d+\.\d+[\w.+-]*/.exec(version.out)?.[0] ?? version.out.split('\n')[0].trim();
  rep.login = login;
  if (models && 'm' in models) rep.models = [...new Set([...rep.models, ...models.m])];
  else if (models) rep.modelsError = models.e;
  // A harness with no status command is signed in if its model list loads.
  if (!rep.login && p.listModels) rep.login = models && 'm' in models ? { signedIn: true, detail: 'its model list loads' } : { signedIn: undefined, detail: 'its model list did not load' };
  return rep;
}
