import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CapabilityManifest, HarnessAdapter, RateLimitInfo, Session, SessionEvents, SessionSpec, StartOptions } from './types.ts';

/**
 * Scripted agents for developing and testing the daemon without calling any model.
 * Each role gets a script; incoming messages reach the script through nextMessage().
 */

export interface FakeCtx {
  spec: SessionSpec;
  tool(name: string, args?: unknown): Promise<string>;
  say(text: string): void;
  sleep(ms: number): Promise<void>;
  /** Resolves with the next message injected into this turn, or null after the timeout. */
  nextMessage(timeoutMs?: number): Promise<string | null>;
  writeShared(relPath: string, content: string): void;
  /** Writes a file in the working folder, reported as a Write tool call before it's written. */
  writeFile(relPath: string, content: string): void;
  /** Reports reading a file or folder in the working folder, as a Read tool call. */
  read(relPath: string): void;
  /** Reports the account's rate-limit state, as a real harness would. */
  rateLimit(info: RateLimitInfo): void;
  /** True once this session has been stopped, e.g. to move the agent elsewhere. */
  stopped(): boolean;
  /** A shell command that takes `ms`, as a tool call; an interrupt cuts it short. Resolves false if interrupted. */
  run(command: string, ms: number): Promise<boolean>;
  /** Reports how full the context window is, as a real harness would after a model call. */
  context(pct: number, tokens?: number): void;
  /** Dies as a harness process can: the session exits as crashed. The script should return after it. */
  crash(detail?: string): void;
}

/** A role's later turns: each message that starts a new turn, after the first script. */
export type FakeTurnScript = (ctx: FakeCtx, text: string) => Promise<void>;

export type FakeScript = (ctx: FakeCtx) => Promise<void>;

const defaultScript: FakeScript = async ctx => {
  ctx.say(`Working on: ${ctx.spec.brief}`);
  await ctx.tool('done', { note: `Finished: ${ctx.spec.brief.slice(0, 100)}` });
};

export class FakeAdapter implements HarnessAdapter {
  readonly manifest: CapabilityManifest;
  private scripts: Record<string, FakeScript>;
  private turns: Record<string, FakeTurnScript>;
  /** Every session started, for tests: its spec and whether it resumed an earlier one. */
  readonly started: { spec: SessionSpec; resume?: string }[] = [];

  /** `manifest` overrides capabilities, e.g. { harness: 'fake2', injectMidTurn: false }. */
  constructor(scripts: Record<string, FakeScript> = {}, manifest: Partial<CapabilityManifest> = {}, turns: Record<string, FakeTurnScript> = {}) {
    this.scripts = scripts;
    this.turns = turns;
    this.manifest = {
      harness: 'fake',
      injectMidTurn: true,
      resume: true,
      interrupt: true,
      reportsCost: true,
      reportsContext: true,
      reportsRateLimits: true,
      ...manifest,
    };
  }

  nativeCommand(sessionId: string): string {
    return `fake --resume ${sessionId}`;
  }

  async start(spec: SessionSpec, events: SessionEvents, opts: StartOptions = {}): Promise<Session> {
    this.started.push({ spec, resume: opts.resume });
    // A resumed session has already run its script; the brief is just its next turn.
    const script = opts.resume ? undefined : (this.scripts[spec.role.name] ?? this.scripts['*'] ?? defaultScript);
    return new FakeSession(spec, events, script, this.manifest.interrupt, opts.resume, this.turns[spec.role.name]);
  }
}

class FakeSession implements Session {
  readonly nativeId: string;
  private spec: SessionSpec;
  private ev: SessionEvents;
  private running = false;
  private stopped = false;
  private queue: string[] = [];
  private onMessage: ((m: string) => void) | null = null;
  private cost = 0;
  /** Set by a script's context(); later calls report it instead of the made-up growth. */
  private contextPct?: number;
  interrupt?: () => Promise<void>;
  private turnScript?: FakeTurnScript;
  private interruptedTurn = false;
  private cancelRun?: () => void;

  constructor(spec: SessionSpec, ev: SessionEvents, script: FakeScript | undefined, canInterrupt: boolean, resume?: string, turnScript?: FakeTurnScript) {
    this.spec = spec;
    this.ev = ev;
    this.turnScript = turnScript;
    this.nativeId = resume ?? 'fake-' + randomUUID().slice(0, 8);
    // Interrupting a scripted turn cuts its command short, or hands it a message it can stop on,
    // or (between steps) makes its next command come back interrupted; the turn then ends.
    if (canInterrupt) {
      this.interrupt = async () => {
        if (this.cancelRun) this.cancelRun();
        else if (this.onMessage) this.onMessage('[interrupted]');
        else this.interruptedTurn = true;
      };
    }
    if (!script) {
      if (spec.brief) setImmediate(() => void this.send(spec.brief, 'new_turn'));
      return;
    }
    // Busy from the start, like the real adapters: early messages join the first turn.
    // The script starts on the next tick so the daemon has the session before the first event.
    this.running = true;
    setImmediate(() => void this.turn(() => script(this.ctx())));
  }

  busy(): boolean {
    return this.running;
  }

  private ctx(): FakeCtx {
    return {
      spec: this.spec,
      tool: async (name, args) => {
        // A real harness process is gone once stopped; a script that keeps going reaches nothing.
        if (this.stopped) throw new Error('this session was stopped');
        // Interrupted between steps, a real model stops making calls; a script that goes on gets nowhere.
        if (this.interruptedTurn) return '[interrupted]';
        this.ev.toolCall(name, JSON.stringify(args ?? {}).slice(0, 160));
        this.bill();
        const r = await this.spec.callTool(name, args ?? {});
        this.ev.toolResult(r.slice(0, 200), true);
        return r;
      },
      say: text => this.ev.text(text),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      nextMessage: (timeoutMs = 30_000) => {
        if (this.queue.length) return Promise.resolve(this.queue.shift()!);
        return new Promise(resolve => {
          const timer = setTimeout(() => {
            this.onMessage = null;
            resolve(null);
          }, timeoutMs);
          this.onMessage = m => {
            clearTimeout(timer);
            this.onMessage = null;
            resolve(m);
          };
        });
      },
      writeShared: (relPath, content) => {
        const p = join(this.spec.sharedDir, relPath);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        this.ev.toolCall('Write', p, { kind: 'edit' });
      },
      writeFile: (relPath, content) => {
        const p = join(this.spec.cwd, relPath);
        this.ev.toolCall('Write', p, { kind: 'edit' });
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
        this.ev.toolResult('written', true);
      },
      read: relPath => {
        this.ev.toolCall('Read', join(this.spec.cwd, relPath), { kind: 'read' });
        this.ev.toolResult('read', true);
      },
      rateLimit: info => this.ev.rateLimit(info),
      context: (pct, tokens) => {
        this.contextPct = pct;
        this.ev.usage({ costUsd: Number(this.cost.toFixed(4)), contextPct: pct, ...(tokens ? { contextTokens: tokens } : {}) });
      },
      stopped: () => this.stopped,
      crash: detail => {
        this.stopped = true;
        this.running = false;
        this.ev.exited('crashed', detail);
      },
      run: (command, ms) => {
        if (this.interruptedTurn) return Promise.resolve(false);
        this.ev.toolCall('Bash', command, { kind: 'shell' });
        return new Promise<boolean>(resolve => {
          const timer = setTimeout(() => finish(true), ms);
          const finish = (completed: boolean) => {
            clearTimeout(timer);
            this.cancelRun = undefined;
            this.ev.toolResult(completed ? 'done' : 'interrupted', completed);
            resolve(completed);
          };
          this.cancelRun = () => finish(false);
        });
      },
    };
  }

  private bill(): void {
    this.cost += 0.001;
    // Grows with each call, but stays clear of the context handoff: scripts that want one call context().
    this.ev.usage({ costUsd: Number(this.cost.toFixed(4)), contextPct: this.contextPct ?? Math.min(60, Math.round(this.cost * 2000)) });
  }

  private async turn(body: () => Promise<void>): Promise<void> {
    if (this.stopped) return;
    this.running = true;
    this.interruptedTurn = false;
    this.ev.turnStarted();
    try {
      await body();
    } catch (e) {
      this.ev.text(`(script error: ${(e as Error).message})`);
    }
    this.running = false;
    if (!this.stopped) this.ev.turnEnded();
  }

  async send(text: string, how: 'inject' | 'new_turn'): Promise<void> {
    if (this.stopped) return;
    if (how === 'inject' && this.running) {
      if (this.onMessage) this.onMessage(text);
      else this.queue.push(text);
      return;
    }
    if (this.turnScript) return void this.turn(() => this.turnScript!(this.ctx(), text));
    // A scripted agent answers follow-ups with a one-line acknowledgement.
    void this.turn(async () => {
      this.ev.text(`Got it: ${text.replace(/\[MetaHarness\]\s*/g, '').slice(0, 160)}`);
    });
  }

  async stop(): Promise<void> {
    this.cancelRun?.();
    this.stopped = true;
    this.running = false;
    this.ev.exited('stopped');
  }
}

/**
 * The milestone-0 scenario: the architect writes a design and spawns an implementer, the
 * implementer asks a quick helper, asks the architect a question mid-task, gets the answer
 * injected, writes notes, and finishes; then the architect finishes.
 */
export const demoScripts: Record<string, FakeScript> = {
  architect: async ctx => {
    ctx.say('Planning the change.');
    await ctx.tool('status', { text: 'Writing the design' });
    ctx.writeShared('design.md', `# Design\n\nGoal: ${ctx.spec.brief}\n\n## Part B\nUpload middleware.\n`);
    const spawned = await ctx.tool('spawn', { role: 'implementer', brief: 'Implement part B of shared/design.md. Ping me with questions.' });
    const impl = /Started (\S+)/.exec(spawned)?.[1] ?? 'implementer-1';
    await ctx.tool('status', { text: `Waiting on ${impl}` });
    for (let i = 0; i < 20; i++) {
      const w = await ctx.tool('wait', { timeout: 30 });
      if (w.includes(`from ${impl}:`)) {
        ctx.writeShared('design.md', `# Design\n\nGoal: ${ctx.spec.brief}\n\n## Part B\nUpload middleware.\n\n## 3. Client\nAsync.\n`);
        await ctx.tool('send', { to: impl, text: 'Async. I updated design.md §3.' });
      }
      if (w.includes(`- ${impl}:`)) break;
    }
    await ctx.tool('done', { note: `Design is in shared/design.md and ${impl} finished part B.` });
  },

  implementer: async ctx => {
    await ctx.tool('status', { text: 'Reading the design' });
    const answer = await ctx.tool('spawn', { role: 'scout', brief: 'How do routes in src/api apply middleware?', quick: true });
    ctx.say(`Scout says: ${answer.split('\n').pop()}`);
    await ctx.tool('send', { to: 'architect', text: 'Part B: should the client be sync or async?' });
    const reply = await ctx.nextMessage(20_000);
    ctx.say(`Answer from the architect: ${reply ?? '(none yet)'}`);
    await ctx.tool('status', { text: 'Writing part B' });
    ctx.writeShared(`notes/${ctx.spec.agent}.md`, 'Part B is done. The client is async, per the architect.\n');
    await ctx.tool('done', { note: `Part B is done. Notes in shared/notes/${ctx.spec.agent}.md` });
  },

  /** For trying the human's side (`mh spawn designer …` on a fake daemon): it asks you to decide, then waits. */
  designer: async ctx => {
    await ctx.tool('status', { text: 'Comparing two layouts' });
    ctx.writeShared('layouts.md', '# Two layouts\n\n## A: sidebar\nSettings in a left sidebar, sections stacked.\n\n## B: tabs\nOne tab per section.\n\n| | A | B |\n|---|---|---|\n| Discoverable | yes | partly |\n| Mobile | needs a drawer | fine |\n');
    await ctx.tool('send', { to: 'human', decision: true, text: 'I compared two layouts in **shared/layouts.md**. I recommend **A (sidebar)**: everything is visible at once. Approve A, or tell me what to change.' });
    const answer = await ctx.tool('wait', { timeout: 3600 });
    await ctx.tool('done', { note: `Settled the layout. Your answer: ${answer.split('\n').pop()}` });
  },

  scout: async ctx => {
    ctx.say('Searching the codebase.');
    await ctx.sleep(20);
    await ctx.tool('done', { note: 'auth.ts, cors.ts and log.ts all use router.use(fn) before the handlers.' });
  },
};

/** A room's coordinator, scripted: routes to the first seat, then hands the answers back with a note on the board. */
const demoCoordinator: FakeTurnScript = async (ctx, text) => {
  const seat = /\nSeats:\n- ([\w.-]+)/.exec(text)?.[1];
  const seats = [...(text.split('\nSeats:\n')[1]?.split('\n\n')[0] ?? '').matchAll(/^- ([\w.-]+)/gm)].map(m => m[1]);
  // A question in two halves ("…, and …") is split: the first seat finds, the second builds on it.
  const asked = /without picking anyone[^\n]*:\n([\s\S]*?)\n\n/.exec(text)?.[1] ?? '';
  const halves = asked.split(/,? and (?=\w+ )/);
  if (/without picking anyone/.test(text) && seats.length > 1 && halves.length > 1) {
    ctx.say(JSON.stringify({ route: { mode: 'ask', line: `${seats[0]} looks into it, then ${seats[1]} builds on that`, parts: [{ to: seats[0], ask: halves[0].trim() }, { to: seats[1], ask: halves.slice(1).join(' and ').trim(), after: [seats[0]] }] }, status: 'developing', line: 'split in two' }));
    return;
  }
  if (/without picking anyone/.test(text) && seat) {
    ctx.say(JSON.stringify({ route: { to: [seat], mode: 'ask', line: `${seat} takes it first` }, status: 'developing', line: 'a first question is out' }));
    return;
  }
  const said = /New, to decide on:\n\[[^\]]*\][^\n]*\n([^\n]+)/.exec(text)?.[1] ?? '';
  ctx.say(JSON.stringify({ next: { action: 'back', text: `That answers it: ${said.slice(0, 160)}`, line: 'answered' }, status: 'converging', line: 'the question has an answer', board: said ? [{ op: 'add', kind: 'finding', text: said.slice(0, 160) }] : [] }));
};

/** Later turns of the demo roles (a room's coordinator is asked again and again). */
export const demoTurns: Record<string, FakeTurnScript> = { coordinator: demoCoordinator };
demoScripts.coordinator = ctx => demoCoordinator(ctx, ctx.spec.brief);
