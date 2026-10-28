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
      web: true,
      images: true,
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
    if (this.stopped) return;
    this.ev.turnEnded();
    // Messages that came in during the turn and the script never read are the next turn, as
    // with a real harness (a line written mid-turn that the model didn't take up).
    if (this.queue.length && this.turnScript && !this.running) void this.send(this.queue.splice(0).join('\n'), 'new_turn');
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

/**
 * A room's lead, scripted: it opens with the question on the board, sends the first maker with
 * whatever the human asks, and puts each maker's answer on the board as a finding.
 */
const demoRoomLead: FakeTurnScript = async (ctx, text) => {
  const lenses = [...(ctx.spec.systemPrompt.split('each makes one kind of card:\n')[1] ?? '').matchAll(/^- ([\w.-]+) \(/gm)].map(m => m[1]);
  const finished = [...text.matchAll(/\[MetaHarness\] ([\w.-]+) finished: ([^\n]+)/g)];
  if (finished.length) {
    for (const [, , note] of finished) await ctx.tool('canvas', { ops: [{ op: 'add', kind: 'finding', title: note.slice(0, 80), text: note, links: [{ to: 'c1', label: 'answers' }] }] });
    ctx.say(`${finished.map(([, who]) => who).join(' and ')} came back: ${finished.map(([, , note]) => note.slice(0, 120)).join(' ')} It's on the board. Want to see it another way, or settle it?`);
    return;
  }
  const asked = /\[MetaHarness\] Message from human: ([\s\S]+)/.exec(text)?.[1]?.trim();
  if (!asked) {
    const topic = text.split('\n[Room]')[0].trim();
    await ctx.tool('canvas', { ops: [{ op: 'add', kind: 'question', title: topic.split('\n')[0].slice(0, 100), frame: 'The question' }] });
    ctx.say(`I read it as: ${topic.split('\n')[0].slice(0, 120)}. Two ways in: start from how it should feel, or from what it should look like. Which matters more to you?`);
    return;
  }
  if (!lenses.length) {
    ctx.say('Noted. There are no makers to send yet: add one and I can have it make something.');
    return;
  }
  // A demo for anything about feel, else the first maker.
  const to = /feel|jump|move|play/i.test(asked) ? (lenses.find(l => /proto/.test(l)) ?? lenses[0]) : lenses[0];
  await ctx.tool('spawn', { role: to, brief: asked });
  ctx.say(`Sending ${to} on that; I'll be back when it has something.`);
};

/** The placeholders an ask says to fill ("Fill cards c4, c5"), else none. */
const toFill = (text: string) => /Fill cards? ([c\d, ]+)/.exec(text)?.[1].split(/,\s*/).map(s => s.trim()).filter(Boolean) ?? [];
const asked = (text: string) => text.replace(/^\[MetaHarness\] Message from [^:]+:\s*/, '').split('\n').find(l => l.trim() && !l.startsWith('[')) ?? 'the ask';

/** Puts a maker's cards on the board: filling the placeholders it was given, else adding new ones. */
async function makeCards(ctx: FakeCtx, text: string, cards: (n: number) => Record<string, unknown>): Promise<string[]> {
  const fill = toFill(text);
  const ops = fill.length ? fill.map((id, n) => ({ op: 'edit', id, ...cards(n) })) : [{ op: 'add', ...cards(0) }];
  await ctx.tool('canvas', { ops });
  return fill.length ? fill : ['a new card'];
}

const HUES = ['#d96c4f', '#4f8fd9', '#6cbf6a', '#c9a23f'];

/** A small jump to tune: gravity, jump speed and coyote time as knobs. */
const JUMP_DEMO = `<!doctype html><html><head><meta charset="utf-8"><title>Jump</title>
<script type="application/json" id="knobs">[{"name":"gravity","label":"Gravity","min":400,"max":4000,"step":50,"value":1800,"unit":"px/s²"},{"name":"jump","label":"Jump speed","min":200,"max":1400,"step":10,"value":720,"unit":"px/s"},{"name":"coyote","label":"Coyote time","min":0,"max":0.3,"step":0.01,"value":0.1,"unit":"s"}]</script>
<style>html,body{margin:0;background:#15181d;color:#ccd;font:13px sans-serif;overflow:hidden}canvas{display:block}</style></head>
<body><canvas id="c"></canvas><script>
const c=document.getElementById('c'),g=c.getContext('2d');let W,H;function size(){W=c.width=innerWidth;H=c.height=innerHeight}size();addEventListener('resize',size);
const p={x:60,y:0,vy:0,ground:true,since:0};let keys={};addEventListener('keydown',e=>{keys[e.code]=true;if(e.code==='Space')e.preventDefault()});addEventListener('keyup',e=>keys[e.code]=false);
let last=performance.now(),acc=0;const DT=1/120;
function step(){const k=window.knobs;const floor=H-40;p.since+=DT;
if((keys.Space||keys.ArrowUp)&&(p.ground||p.since<k.coyote)){p.vy=-k.jump;p.ground=false;p.since=1}
p.vy+=k.gravity*DT;p.y+=p.vy*DT;p.x+=((keys.ArrowRight?1:0)-(keys.ArrowLeft?1:0))*260*DT;if(p.x>W)p.x=0;if(p.x<0)p.x=W;
if(p.y>=floor-24){if(!p.ground)p.since=0;p.y=floor-24;p.vy=0;p.ground=true}else if(p.ground){p.ground=false;p.since=0}}
function frame(t){acc+=Math.min(0.1,(t-last)/1000);last=t;while(acc>=DT){step();acc-=DT}
g.fillStyle='#15181d';g.fillRect(0,0,W,H);g.fillStyle='#2b3038';g.fillRect(0,H-40,W,40);g.fillStyle='#d96c4f';g.fillRect(p.x-12,p.y,24,24);
g.fillStyle='#889';g.fillText('Space to jump, arrows to move',12,18);requestAnimationFrame(frame)}requestAnimationFrame(frame);
</script></body></html>
`;

/** Room makers, scripted: each answers an ask with the kind of card it makes. */
const demoMaker = (make: 'source' | 'image' | 'demo' | 'text'): FakeTurnScript => async (ctx, text) => {
  const what = asked(text).slice(0, 60);
  const made = await makeCards(ctx, text, n => {
    if (make === 'image') {
      const file = `room/media/${ctx.spec.agent}-${Date.now().toString(36)}-${n}.svg`;
      ctx.writeShared(file, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#1d2129"/><circle cx="${110 + n * 40}" cy="110" r="60" fill="${HUES[n % 4]}"/><rect x="190" y="60" width="80" height="100" rx="12" fill="${HUES[(n + 1) % 4]}" opacity="0.8"/><text x="16" y="28" fill="#ccd" font-family="sans-serif" font-size="14">${what.replace(/[<&]/g, '')}</text></svg>`);
      return { kind: 'image', title: `Take ${n + 1}: ${what}`, text: `Prompt: ${what}, flat shapes, warm palette.`, file };
    }
    if (make === 'demo') {
      const file = `room/demos/jump-${Date.now().toString(36)}.html`;
      ctx.writeShared(file, JUMP_DEMO);
      return { kind: 'demo', title: `Jump feel: ${what}`.slice(0, 80), text: 'Try short hops and running jumps off the ledge; tune gravity against jump speed.', file };
    }
    if (make === 'source') return { kind: 'source', title: `How others do it: ${what}`.slice(0, 80), url: 'https://example.com/reference', text: '"Keep the jump arc short and the fall fast." — a talk on platformer feel' };
    return { kind: 'text', title: `${what}`.slice(0, 80), text: `The gist: ${what}. It plays fast and readable; the twist is that every action leaves something behind.` };
  });
  await ctx.tool('done', { note: `Made ${made.join(', ')} for: ${what}` });
};

/** Later turns of the demo roles (a room's lead and its makers hear asks again and again). */
export const demoTurns: Record<string, FakeTurnScript> = {
  'room-lead': demoRoomLead, researcher: demoMaker('source'), illustrator: demoMaker('image'), prototyper: demoMaker('demo'), writer: demoMaker('text'),
};
for (const [role, turn] of Object.entries(demoTurns)) demoScripts[role] = ctx => turn(ctx, ctx.spec.brief);
