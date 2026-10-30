import { randomUUID } from 'node:crypto';
import type { Session, SessionEvents, ToolRequest, Usage } from './adapters/types.ts';
import { readOnlyCommand } from './readonly.ts';

/**
 * The app's assistant (DESIGN.md §14): a session of the assistant role that answers the human's
 * questions about their goals and setup. It reads through its own MetaHarness tools and
 * proposes setup changes for the human to apply; it can't reach the team. The human picks its
 * model and effort from the panel, and may let it write for a task (write mode).
 * Each conversation is a fresh session: nothing carries over.
 */

export interface AssistantHost {
  /** Starts a session of the assistant role with this first message. */
  start(brief: string, events: SessionEvents): Promise<Session>;
  /** Logs to the assistant's own event stream ("assistant"). */
  log(type: string, data: Record<string, unknown>): void;
  usage(u: Usage): void;
  /** Where a pick runs (harness, model, effort), so a pick that lands on the same route keeps the session. */
  route(c: AssistantChoice): string;
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

/** What the human picked in the panel: a model and effort of its own (else the role's), and write mode. */
export interface AssistantChoice {
  harness?: string;
  model?: string;
  effort?: string;
  write: boolean;
}

/**
 * What the assistant may do with its harness's own tools: read files and run commands that only
 * read; in write mode, anything but delegating, messaging or scheduling (it works alone, one turn at
 * a time) and asking (it asks in its answer).
 */
export function assistantDecision(t: ToolRequest, write = false): { allow: boolean; message?: string } {
  if (t.kind === 'delegate' || t.kind === 'ask_user' || t.kind === 'message' || t.kind === 'schedule') return { allow: false, message: 'The assistant works alone, and asks the human in its answer.' };
  if (write || t.kind === 'read' || (t.kind === 'shell' && readOnlyCommand(t.detail).readOnly)) return { allow: true };
  return { allow: false, message: 'The assistant only reads. To suggest a change, use the MetaHarness propose tool; the human can also turn on write mode in the panel.' };
}

const WRITE_ON = "[The human turned on write mode: you may now edit files and run any command in the project you're in to do what they ask. Say what you changed.]";
const WRITE_OFF = '[The human turned write mode off: you only read again.]';
/** How much of the conversation a new session hears when the model changes mid-way. */
const CARRY_MAX = 30_000;

export class Assistant {
  conv = randomUUID().slice(0, 8);
  readonly proposals = new Map<string, Proposal>();
  choice: AssistantChoice = { write: false };
  /** The conversation so far, for a session that takes over from another (a new model, a crash). */
  private history: string[] = [];
  private carried?: string[];
  /** The write mode the session was last told about. */
  private told = false;
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
    this.history.push(`The human: ${text}`);
    this.queue.push(context ? `${text}\n\n[In the app, the human is looking at ${context}.]` : text);
    this.next();
  }

  /** Starts a new conversation: the old session is stopped, nothing is carried over, and write mode goes off. */
  async reset(): Promise<void> {
    const s = this.session;
    this.session = undefined;
    this.starting = false;
    this.queue = [];
    this.history = [];
    this.carried = undefined;
    this.gen++;
    for (const p of this.proposals.values()) if (p.status === 'open') p.status = 'dismissed';
    this.choice = { ...this.choice, write: false };
    this.conv = randomUUID().slice(0, 8);
    this.host.log('assistant.reset', { conv: this.conv });
    await s?.stop().catch(() => {});
  }

  /**
   * The human's pick in the panel; empty values go back to the role's. A new model or effort
   * takes over with the conversation so far; write mode holds from the next tool call.
   */
  set(c: { harness?: string; model?: string; effort?: string; write?: boolean }): void {
    const was = this.choice;
    const pick = 'model' in c ? (c.harness && c.model ? { harness: c.harness, model: c.model } : {}) : { harness: was.harness, model: was.model };
    const effort = 'effort' in c ? c.effort : was.effort;
    const next: AssistantChoice = { ...(pick.model ? pick : {}), ...(effort ? { effort } : {}), write: c.write ?? was.write };
    this.choice = next;
    const rerouted = this.host.route(next) !== this.host.route(was);
    if (!rerouted && next.write === was.write) return;
    this.host.log('assistant.settings', { harness: next.harness ?? null, model: next.model ?? null, effort: next.effort ?? null, write: next.write, ...(rerouted ? { rerouted } : {}) });
    if (!rerouted || (!this.session && !this.starting)) return;
    // The next question starts a session on the new model, which hears the conversation so far.
    const s = this.session;
    const wasBusy = this.starting || !!s?.busy();
    this.session = undefined;
    this.starting = false;
    this.gen++;
    this.carried = this.history.slice();
    void s?.stop().catch(() => {});
    if (wasBusy) this.host.log('assistant.state', { conv: this.conv, busy: false });
    this.next();
  }

  /** The picked model and effort are now its role's own: forgotten here, the session carrying on. */
  adopt(): void {
    this.choice = { write: this.choice.write };
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
    let text = this.queue.splice(0).join('\n\n');
    if (this.session) return void this.session.send(this.modeNote() + text, 'new_turn');
    // A fresh session was told it only reads; one taking over hears what was said so far.
    this.told = false;
    text = this.modeNote() + text;
    if (this.carried?.length) text = `${transcript(this.carried)}\n\n---\n\n${text}`;
    this.carried = undefined;
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

  /** A line telling the session that write mode changed since it last heard, or ''. */
  private modeNote(): string {
    if (this.told === this.choice.write) return '';
    this.told = this.choice.write;
    return `${this.choice.write ? WRITE_ON : WRITE_OFF}\n\n`;
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
      text: text => {
        if (!live()) return;
        this.history.push(`You: ${text}`);
        this.host.log('assistant.text', { conv: conv(), text });
      },
      toolCall: (tool, summary) => live() && this.host.log('assistant.tool', { conv: conv(), tool, summary }),
      toolResult: () => {},
      usage: u => live() && this.host.usage(u),
      exited: (reason, detail) => {
        if (!live()) return;
        this.session = undefined;
        this.carried = this.history.slice();
        if (reason === 'crashed') this.host.log('assistant.text', { conv: conv(), text: `(The assistant stopped: ${detail ?? 'it crashed'}. Ask again to start it.)`, error: true });
        this.host.log('assistant.state', { conv: conv(), busy: false });
      },
      rateLimit: info => {
        if (live() && info.status === 'limited') this.host.log('assistant.text', { conv: conv(), text: "(The assistant's account is at its limit. Give its role a backup on another harness, or try later.)", error: true });
      },
      approval: async () => (this.choice.write ? { allow: true } : { allow: false, message: 'The assistant only reads.' }),
      decide: async t => assistantDecision(t, this.choice.write),
      pull: () => undefined,
    };
  }
}

/** The conversation so far, newest kept, for a session that takes it over. */
function transcript(lines: string[]): string {
  let out = lines.join('\n\n');
  if (out.length > CARRY_MAX) out = `…${out.slice(-CARRY_MAX)}`;
  return `[You're taking over this conversation from another session. What was said so far:]\n\n${out}`;
}
