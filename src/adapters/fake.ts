import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CapabilityManifest, HarnessAdapter, Session, SessionEvents, SessionSpec } from './types.ts';

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
}

export type FakeScript = (ctx: FakeCtx) => Promise<void>;

const defaultScript: FakeScript = async ctx => {
  ctx.say(`Working on: ${ctx.spec.brief}`);
  await ctx.tool('done', { note: `Finished: ${ctx.spec.brief.slice(0, 100)}` });
};

export class FakeAdapter implements HarnessAdapter {
  readonly manifest: CapabilityManifest = {
    harness: 'fake',
    injectMidTurn: true,
    resume: true,
    interrupt: true,
    reportsCost: true,
    reportsContext: true,
  };
  private scripts: Record<string, FakeScript>;

  constructor(scripts: Record<string, FakeScript> = {}) {
    this.scripts = scripts;
  }

  async start(spec: SessionSpec, events: SessionEvents): Promise<Session> {
    return new FakeSession(spec, events, this.scripts[spec.role.name] ?? this.scripts['*'] ?? defaultScript);
  }
}

class FakeSession implements Session {
  readonly nativeId = 'fake-' + randomUUID().slice(0, 8);
  private spec: SessionSpec;
  private ev: SessionEvents;
  private running = false;
  private stopped = false;
  private queue: string[] = [];
  private onMessage: ((m: string) => void) | null = null;
  private cost = 0;

  constructor(spec: SessionSpec, ev: SessionEvents, script: FakeScript) {
    this.spec = spec;
    this.ev = ev;
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
        this.ev.toolCall('Write', `shared/${relPath}`);
      },
    };
  }

  private bill(): void {
    this.cost += 0.001;
    this.ev.usage({ costUsd: Number(this.cost.toFixed(4)), contextPct: Math.min(95, Math.round(this.cost * 2000)) });
  }

  private async turn(body: () => Promise<void>): Promise<void> {
    if (this.stopped) return;
    this.running = true;
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
    // A scripted agent answers follow-ups with a one-line acknowledgement.
    void this.turn(async () => {
      this.ev.text(`Got it: ${text.replace(/\[MetaHarness\]\s*/g, '').slice(0, 160)}`);
    });
  }

  async interrupt(): Promise<void> {}

  async stop(): Promise<void> {
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

  scout: async ctx => {
    ctx.say('Searching the codebase.');
    await ctx.sleep(20);
    await ctx.tool('done', { note: 'auth.ts, cors.ts and log.ts all use router.use(fn) before the handlers.' });
  },
};
