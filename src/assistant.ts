import { randomUUID } from 'node:crypto';
import type { Session, SessionEvents, ToolRequest, Usage } from './adapters/types.ts';
import { readOnlyCommand } from './readonly.ts';

/**
 * The app's assistant (DESIGN.md §14): a session of the assistant role that answers the human's
 * questions about their goals and setup. It reads through its own MetaHarness tools and
 * proposes setup changes for the human to apply; it can't change anything or reach the team.
 * Each conversation is a fresh session: nothing carries over.
 */

export interface AssistantHost {
  /** Starts a session of the assistant role with this first message. */
  start(brief: string, events: SessionEvents): Promise<Session>;
  /** Logs to the assistant's own event stream ("assistant"). */
  log(type: string, data: Record<string, unknown>): void;
  usage(u: Usage): void;
}

/** A setup change the assistant suggests; the human applies it from the app. */
export interface Proposal {
  id: string;
  conv: string;
  summary: string;
  /** The command it runs when applied, as the app would send it. */
  command: Record<string, unknown>;
  status: 'open' | 'applied' | 'dismissed';
}

/** What the assistant may do with its harness's own tools: read files and run commands that only read. */
export function assistantDecision(t: ToolRequest): { allow: boolean; message?: string } {
  if (t.kind === 'read' || (t.kind === 'shell' && readOnlyCommand(t.detail).readOnly)) return { allow: true };
  return { allow: false, message: 'The assistant only reads. To suggest a change, use the MetaHarness propose tool.' };
}

export class Assistant {
  conv = randomUUID().slice(0, 8);
  readonly proposals = new Map<string, Proposal>();
  private session?: Session;
  private starting = false;
  private queue: string[] = [];
  private gen = 0;
  private host: AssistantHost;

  constructor(host: AssistantHost) {
    this.host = host;
  }

  busy(): boolean {
    return this.starting || !!this.session?.busy() || this.queue.length > 0;
  }

  /** A question from the human; `context` says what they're looking at in the app. */
  ask(text: string, context?: string): void {
    this.host.log('assistant.asked', { conv: this.conv, text });
    this.queue.push(context ? `${text}\n\n[In the app, the human is looking at ${context}.]` : text);
    this.next();
  }

  /** Starts a new conversation: the old session is stopped, nothing is carried over. */
  async reset(): Promise<void> {
    const s = this.session;
    this.session = undefined;
    this.starting = false;
    this.queue = [];
    this.gen++;
    for (const p of this.proposals.values()) if (p.status === 'open') p.status = 'dismissed';
    this.conv = randomUUID().slice(0, 8);
    this.host.log('assistant.reset', { conv: this.conv });
    await s?.stop().catch(() => {});
  }

  async stop(): Promise<void> {
    this.gen++;
    const s = this.session;
    this.session = undefined;
    await s?.stop().catch(() => {});
  }

  propose(summary: string, command: Record<string, unknown>): Proposal {
    const p: Proposal = { id: randomUUID().slice(0, 8), conv: this.conv, summary, command, status: 'open' };
    this.proposals.set(p.id, p);
    this.host.log('assistant.proposal', { conv: this.conv, id: p.id, summary, command });
    return p;
  }

  /** Sends what's waiting, one turn at a time. */
  private next(): void {
    if (this.starting || this.session?.busy() || !this.queue.length) return;
    const text = this.queue.splice(0).join('\n\n');
    if (this.session) return void this.session.send(text, 'new_turn');
    this.starting = true;
    const gen = ++this.gen;
    this.host.log('assistant.state', { conv: this.conv, busy: true });
    this.host
      .start(text, this.events(gen))
      .then(s => {
        if (gen !== this.gen) return void s.stop().catch(() => {});
        this.session = s;
        this.starting = false;
        this.next();
      })
      .catch((e: Error) => {
        if (gen !== this.gen) return;
        this.starting = false;
        this.host.log('assistant.text', { conv: this.conv, text: `(The assistant couldn't start: ${e.message})`, error: true });
        this.host.log('assistant.state', { conv: this.conv, busy: false });
      });
  }

  private events(gen: number): SessionEvents {
    const live = () => gen === this.gen;
    const conv = () => this.conv;
    return {
      turnStarted: () => live() && this.host.log('assistant.state', { conv: conv(), busy: true }),
      turnEnded: () => {
        if (!live()) return;
        this.host.log('assistant.state', { conv: conv(), busy: false });
        // Questions asked while it answered start the next turn.
        setImmediate(() => this.next());
      },
      text: text => live() && this.host.log('assistant.text', { conv: conv(), text }),
      toolCall: (tool, summary) => live() && this.host.log('assistant.tool', { conv: conv(), tool, summary }),
      toolResult: () => {},
      usage: u => live() && this.host.usage(u),
      exited: (reason, detail) => {
        if (!live()) return;
        this.session = undefined;
        if (reason === 'crashed') this.host.log('assistant.text', { conv: conv(), text: `(The assistant stopped: ${detail ?? 'it crashed'}. Ask again to start it.)`, error: true });
        this.host.log('assistant.state', { conv: conv(), busy: false });
      },
      rateLimit: info => {
        if (live() && info.status === 'limited') this.host.log('assistant.text', { conv: conv(), text: "(The assistant's account is at its limit. Give its role a backup on another harness, or try later.)", error: true });
      },
      approval: async () => ({ allow: false, message: 'The assistant only reads.' }),
      decide: async t => assistantDecision(t),
      pull: () => undefined,
    };
  }
}
