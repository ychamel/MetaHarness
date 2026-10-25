import type { BoardItem, MhEvent, Participant } from './types.ts';

/** A room, folded from its events (src/daemon.ts, design §21): everything the room view shows. */

/**
 * ask: from you; answer: a participant's; question: a participant asks you; aside: a participant's
 * message for another (moderated: the coordinator has it); route (whole, or split into parts),
 * part, forward, compare, back: the coordinator's decisions; note: from MetaHarness.
 */
export type MsgKind = 'ask' | 'answer' | 'question' | 'aside' | 'route' | 'part' | 'forward' | 'compare' | 'back' | 'note';

export interface RoomMsg {
  seq: number;
  ts: string;
  id: string;
  from: string;
  to: string[];
  text: string;
  kind: MsgKind;
  /** The coordinator's one-line reason, shown before its message. */
  line?: string;
  mode?: string;
  flow?: string;
  /** What it answers or follows: a message id, or a flow's. */
  re?: string;
  round?: number;
  rounds?: number;
  /** A view kept back until everyone asked has answered. */
  held?: boolean;
  replyTo?: string;
  /** A split route's parts; a part's number, of how many, and whose parts it waited for. */
  parts?: { to: string; ask: string; after: string[] }[];
  part?: number;
  of?: number;
  after?: string[];
}

export type ThreadItem =
  | { kind: 'msg'; m: RoomMsg; children: ThreadItem[] }
  | { kind: 'commit'; e: MhEvent }
  | { kind: 'merged'; e: MhEvent }
  | { kind: 'round'; e: MhEvent };

export interface CoordinatorStatus {
  state: 'converging' | 'developing' | 'drifting';
  line: string;
  ending?: 'design' | 'patch' | 'goal';
  ts: string;
}

export interface RoomView {
  open: boolean;
  cast: Participant[];
  board: BoardItem[];
  status?: CoordinatorStatus;
  /** What the coordinator is doing right now. */
  coordinating?: 'route' | 'decide';
  messages: RoomMsg[];
  byId: Map<string, RoomMsg>;
  /** The thread, answers nested under what they answer. */
  thread: ThreadItem[];
  /** Views flows whose answers are all in. */
  revealed: Set<string>;
  writers: Set<string>;
  /** Commits on the room's branch since it was last merged. */
  ahead: number;
  merged?: MhEvent;
  from?: string;
}

export const COORDINATOR = '(coordinator)';
export const isCoordinator = (n?: string) => n === COORDINATOR || n === 'coordinator';

export function roomOf(events: MhEvent[], roomBranch: string | null): RoomView {
  const v: RoomView = { open: false, cast: [], board: [], messages: [], byId: new Map(), thread: [], revealed: new Set(), writers: new Set(), ahead: 0 };
  const items: ThreadItem[] = [];
  const nodes = new Map<string, Extract<ThreadItem, { kind: 'msg' }>>();
  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case 'goal.started':
        v.open = d.open === true;
        v.from = typeof d.from === 'string' ? d.from : undefined;
        break;
      case 'room.cast':
        v.cast = (d.cast as Participant[]) ?? [];
        break;
      case 'room.board':
        v.board = (d.items as BoardItem[]) ?? [];
        break;
      case 'room.open':
        v.open = d.open === true;
        break;
      case 'room.status':
        v.status = { state: d.state as CoordinatorStatus['state'], line: String(d.line ?? ''), ...(d.ending ? { ending: d.ending as CoordinatorStatus['ending'] } : {}), ts: e.ts };
        break;
      case 'room.coordinating':
        v.coordinating = d.on === true ? ((d.kind as 'route' | 'decide') ?? 'decide') : undefined;
        break;
      case 'room.writer':
        if (d.on) v.writers.add(e.agent!);
        else v.writers.delete(e.agent!);
        break;
      case 'room.reveal':
        v.revealed.add(String(d.flow));
        break;
      case 'room.round':
        items.push({ kind: 'round', e });
        break;
      case 'room.message': {
        const m: RoomMsg = {
          seq: e.seq, ts: e.ts, id: String(d.id), from: String(d.from), to: (d.to as string[]) ?? [], text: String(d.text ?? ''), kind: (d.kind as MsgKind) ?? 'answer',
          ...(d.line ? { line: String(d.line) } : {}), ...(d.mode ? { mode: String(d.mode) } : {}), ...(d.flow ? { flow: String(d.flow) } : {}), ...(d.re ? { re: String(d.re) } : {}),
          ...(typeof d.round === 'number' ? { round: d.round } : {}), ...(typeof d.rounds === 'number' ? { rounds: d.rounds } : {}), ...(d.held ? { held: true } : {}),
          ...(d.replyTo ? { replyTo: String(d.replyTo) } : {}), ...(Array.isArray(d.parts) ? { parts: d.parts as RoomMsg['parts'] } : {}),
          ...(typeof d.part === 'number' ? { part: d.part, of: Number(d.of) } : {}), ...(Array.isArray(d.after) ? { after: d.after as string[] } : {}),
        };
        v.messages.push(m);
        v.byId.set(m.id, m);
        const node = { kind: 'msg' as const, m, children: [] as ThreadItem[] };
        // Under what it answers: the message with that id, or the one that started that flow.
        const parent = m.re ? (nodes.get(m.re) ?? [...nodes.values()].find(n => n.m.flow === m.re)) : undefined;
        (parent ? parent.children : items).push(node);
        nodes.set(m.id, node);
        break;
      }
      case 'git.commit':
        if (roomBranch && d.branch === roomBranch) {
          v.ahead++;
          items.push({ kind: 'commit', e });
        }
        break;
      case 'room.merged':
        v.ahead = 0;
        v.merged = e;
        items.push({ kind: 'merged', e });
        break;
    }
  }
  v.thread = items;
  return v;
}

/** Who a seat is: its role, or its model when it has none. */
export const seatWhat = (p: Participant) => p.role ?? p.on?.split('@')[0].split('/').pop() ?? 'model';

/** A responsibility's short label: the preset's name, else its first words. */
export function responsibilityLabel(text: string | undefined, presets: { name: string; text: string }[] = []): string {
  if (!text) return '';
  const preset = presets.find(r => r.text === text);
  if (preset) return preset.name;
  const first = text.split(/[.:\n]/)[0].trim();
  return first.length > 32 ? `${first.slice(0, 31)}…` : first;
}

export const MODES: { mode: 'ask' | 'job' | 'views' | 'debate' | 'chain' | 'patch'; label: string; hint: string }[] = [
  { mode: 'ask', label: 'Ask', hint: 'A short answer. With nobody picked, the coordinator picks who' },
  { mode: 'job', label: 'Job', hint: 'Go and find out with their tools, then report back' },
  { mode: 'views', label: 'Views', hint: 'Each answers on their own; the answers show together once all are in' },
  { mode: 'debate', label: 'Debate', hint: 'Rounds where each sees the others’ last answers and responds' },
  { mode: 'chain', label: 'Chain', hint: 'One after another, in the order picked, each building on the last answer' },
  { mode: 'patch', label: 'Patch', hint: 'One participant changes the code on the room’s branch, tests and commits' },
];

export const BOARD_SECTIONS: { kind: BoardItem['kind']; label: string }[] = [
  { kind: 'question', label: 'Open questions' },
  { kind: 'finding', label: 'Findings' },
  { kind: 'decision', label: 'Decided' },
  { kind: 'file', label: 'Files' },
];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
