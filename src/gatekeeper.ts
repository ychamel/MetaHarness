import type { Session, SessionEvents, ToolRequest } from './adapters/types.ts';

/**
 * A model that judges approvals for one goal (DESIGN.md §10): a session of the gatekeeper role,
 * started on the first request and reused, one request at a time. It may read, never change
 * anything. A verdict it can't give in time, or can't be parsed, goes to the human.
 */

export type Verdict = 'allow' | 'deny' | 'ask';

export interface GatekeeperRequest {
  agent: string;
  role: string;
  /** Its brief, sent the first time this agent asks in a session. */
  brief: string;
  where: string;
  /** The goal's shared folder, the team's own. */
  shared: string;
  tool: string;
  detail: string;
}

export interface Judgement {
  verdict: Verdict;
  reason: string;
  /** Answered from an earlier identical request, without asking the model. */
  remembered?: boolean;
}

export interface GatekeeperHost {
  /** Starts a session of the gatekeeper role with this first message. */
  start(brief: string, events: SessionEvents): Promise<Session>;
  /** Where its usage goes (session totals, as adapters report them). */
  usage(u: Parameters<SessionEvents['usage']>[0], session: number): void;
  log(type: string, data: Record<string, unknown>): void;
}

export interface GatekeeperLimits {
  /** How long one verdict may take. */
  timeoutMs: number;
  /** Start a fresh session after this many requests, or this much context. */
  maxRequests: number;
  maxContextPct: number;
}

export const DEFAULT_GATEKEEPER_LIMITS: GatekeeperLimits = { timeoutMs: 120_000, maxRequests: 40, maxContextPct: 50 };

/** The first ALLOW, DENY or ASK in the answer, and what follows it. */
export function parseVerdict(text: string): Judgement | undefined {
  const m = /\b(ALLOW|DENY|ASK)\b[\s:.,—–-]*([\s\S]*)/.exec(text);
  if (!m) return undefined;
  const reason = m[2].trim().split('\n')[0].trim().slice(0, 400) || 'no reason given';
  return { verdict: m[1].toLowerCase() as Verdict, reason };
}

interface Pending {
  req: GatekeeperRequest;
  resolve: (j: Judgement) => void;
}

export class Gatekeeper {
  private session?: Session;
  private starting?: Promise<Session | undefined>;
  private queue: Pending[] = [];
  private current?: Pending & { timer: NodeJS.Timeout };
  private lastText = '';
  private requests = 0;
  private contextPct = 0;
  /** Sessions started, so usage from an old one is told apart. */
  private gen = 0;
  /** Agents whose brief this session has seen. */
  private briefed = new Set<string>();
  private remembered = new Map<string, Judgement>();
  private stopped = false;

  private host: GatekeeperHost;
  private limits: GatekeeperLimits;

  constructor(host: GatekeeperHost, limits: GatekeeperLimits = DEFAULT_GATEKEEPER_LIMITS) {
    this.host = host;
    this.limits = limits;
  }

  judge(req: GatekeeperRequest): Promise<Judgement> {
    const known = this.remembered.get(key(req));
    if (known) return Promise.resolve({ ...known, remembered: true });
    if (this.stopped) return Promise.resolve({ verdict: 'ask', reason: 'the gatekeeper has stopped' });
    return new Promise(resolve => {
      this.queue.push({ req, resolve });
      void this.next();
    });
  }

  /** What a tool call by the gatekeeper itself may do: read, nothing else. */
  static decide(t: ToolRequest): { allow: boolean; message?: string } {
    return t.kind === 'read' ? { allow: true } : { allow: false, message: 'The gatekeeper only reads. Answer ALLOW, DENY or ASK.' };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const s = this.session;
    this.session = undefined;
    for (const p of this.queue.splice(0)) p.resolve({ verdict: 'ask', reason: 'the gatekeeper has stopped' });
    this.finish({ verdict: 'ask', reason: 'the gatekeeper has stopped' });
    await s?.stop().catch(() => {});
  }

  private async next(): Promise<void> {
    if (this.current || this.starting || !this.queue.length || this.stopped) return;
    const p = this.queue.shift()!;
    const text = this.prompt(p.req);
    this.current = { ...p, timer: setTimeout(() => this.timedOut(), this.limits.timeoutMs) };
    this.lastText = '';
    if (this.session && (this.requests >= this.limits.maxRequests || this.contextPct >= this.limits.maxContextPct)) this.retire();
    if (this.session) {
      this.requests++;
      void this.session.send(text, 'new_turn');
      return;
    }
    this.starting = this.open(text);
    await this.starting;
    this.starting = undefined;
  }

  private async open(brief: string): Promise<Session | undefined> {
    const gen = ++this.gen;
    this.requests = 1;
    this.contextPct = 0;
    try {
      const s = await this.host.start(brief, this.events(gen));
      if (gen !== this.gen || this.stopped) {
        void s.stop().catch(() => {});
        return undefined;
      }
      this.session = s;
      this.host.log('gatekeeper.session', { nativeSession: s.nativeId });
      return s;
    } catch (e) {
      this.host.log('gatekeeper.failed', { reason: (e as Error).message });
      this.finish({ verdict: 'ask', reason: `the gatekeeper couldn't start (${(e as Error).message})` });
      return undefined;
    }
  }

  /** Starts over with a fresh session next time: this one's context has grown. */
  private retire(): void {
    const s = this.session;
    this.session = undefined;
    this.briefed.clear();
    this.gen++;
    void s?.stop().catch(() => {});
  }

  private events(gen: number): SessionEvents {
    const live = () => gen === this.gen;
    return {
      turnStarted: () => {},
      turnEnded: () => {
        if (!live() || !this.current) return;
        this.finish(parseVerdict(this.lastText) ?? { verdict: 'ask', reason: `the gatekeeper's answer had no verdict: ${this.lastText.slice(0, 200) || '(nothing)'}` });
      },
      text: t => {
        if (live()) this.lastText = t;
      },
      toolCall: () => {},
      toolResult: () => {},
      usage: u => {
        if (u.contextPct !== undefined && live()) this.contextPct = u.contextPct;
        this.host.usage(u, gen);
      },
      exited: (_reason, detail) => {
        if (!live()) return;
        this.session = undefined;
        this.briefed.clear();
        this.gen++;
        this.finish({ verdict: 'ask', reason: `the gatekeeper's session ended${detail ? ` (${detail.slice(0, 200)})` : ''}` });
      },
      rateLimit: info => {
        if (live() && info.status === 'limited') this.finish({ verdict: 'ask', reason: "the gatekeeper's account is at its limit" });
      },
      approval: async () => ({ allow: false, message: 'The gatekeeper only reads. Answer ALLOW, DENY or ASK.' }),
      decide: async t => Gatekeeper.decide(t),
      pull: () => undefined,
    };
  }

  private timedOut(): void {
    this.finish({ verdict: 'ask', reason: `the gatekeeper didn't answer within ${Math.round(this.limits.timeoutMs / 1000)}s` });
    // A turn still running would answer the next request with this one's verdict.
    this.retire();
  }

  private finish(j: Judgement): void {
    const c = this.current;
    if (!c) return;
    clearTimeout(c.timer);
    this.current = undefined;
    if (j.verdict !== 'ask') this.remembered.set(key(c.req), j);
    c.resolve(j);
    void this.next();
  }

  private prompt(r: GatekeeperRequest): string {
    const first = !this.briefed.has(r.agent);
    this.briefed.add(r.agent);
    return [
      `Request from ${r.agent} (${r.role}), working in ${r.where}. The team's shared folder: ${r.shared}`,
      ...(first && r.brief ? [`Its task: ${r.brief.replace(/\s+/g, ' ').slice(0, 800)}`] : []),
      `It wants to run ${r.tool}:`,
      '```',
      r.detail.slice(0, SHOWN),
      ...(r.detail.length > SHOWN ? [`[… ${r.detail.length - SHOWN} more characters not shown]`] : []),
      '```',
      'Answer ALLOW, DENY or ASK as the first word, then one short reason.',
    ].join('\n');
  }
}

/** How much of a command the gatekeeper is shown. */
const SHOWN = 6000;

const key = (r: GatekeeperRequest) => `${r.agent}\n${r.tool}\n${r.detail}`;
