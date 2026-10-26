import type { CanvasCard, CanvasLink, Lens, MhEvent } from './types.ts';

/** A room, folded from its events (src/daemon.ts, design §21): everything the room view shows. */

/**
 * ask: from you; reply: the lead's; dispatch: the lead sends a lens; lens: a lens's answer to
 * the lead; note: from MetaHarness.
 */
export type MsgKind = 'ask' | 'reply' | 'dispatch' | 'lens' | 'note';

export interface RoomMsg {
  seq: number;
  ts: string;
  id: string;
  from: string;
  to: string[];
  text: string;
  kind: MsgKind;
  /** The card a message of yours was about. */
  card?: string;
  /** A patch job: the lens may change files. */
  patch?: boolean;
  /** Stopped by you mid-way: what it had said by then. */
  stopped?: boolean;
}

export type ChatItem = { kind: 'msg'; m: RoomMsg } | { kind: 'commit'; e: MhEvent } | { kind: 'merged'; e: MhEvent };

export interface RoomView {
  lenses: Lens[];
  cards: CanvasCard[];
  links: CanvasLink[];
  /** When each card first showed, and when it last changed: new and changed cards stand out for a while. */
  seen: Map<string, { added: number; changed: number }>;
  messages: RoomMsg[];
  chat: ChatItem[];
  writers: Set<string>;
  /** Commits on the room's branch since it was last merged. */
  ahead: number;
  merged?: MhEvent;
  from?: string;
}

export function roomOf(events: MhEvent[], roomBranch: string | null): RoomView {
  const v: RoomView = { lenses: [], cards: [], links: [], seen: new Map(), messages: [], chat: [], writers: new Set(), ahead: 0 };
  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    switch (e.type) {
      case 'goal.started':
        v.from = typeof d.from === 'string' ? d.from : undefined;
        break;
      case 'room.lenses':
        v.lenses = (d.lenses as Lens[]) ?? [];
        break;
      case 'room.canvas': {
        const cards = (d.cards as CanvasCard[]) ?? [];
        const t = Date.parse(e.ts);
        const before = new Map(v.cards.map(c => [c.id, JSON.stringify(c)]));
        for (const c of cards) {
          const was = v.seen.get(c.id);
          if (!was) v.seen.set(c.id, { added: t, changed: t });
          else if (before.get(c.id) !== JSON.stringify(c)) was.changed = t;
        }
        v.cards = cards;
        v.links = (d.links as CanvasLink[]) ?? [];
        break;
      }
      case 'room.writer':
        if (d.on) v.writers.add(e.agent!);
        else v.writers.delete(e.agent!);
        break;
      case 'room.message': {
        const m: RoomMsg = {
          seq: e.seq, ts: e.ts, id: String(d.id), from: String(d.from), to: (d.to as string[]) ?? [], text: String(d.text ?? ''), kind: (d.kind as MsgKind) ?? 'reply',
          ...(d.card ? { card: String(d.card) } : {}), ...(d.patch ? { patch: true } : {}), ...(d.stopped ? { stopped: true } : {}),
        };
        v.messages.push(m);
        v.chat.push({ kind: 'msg', m });
        break;
      }
      case 'git.commit':
        if (roomBranch && d.branch === roomBranch) {
          v.ahead++;
          v.chat.push({ kind: 'commit', e });
        }
        break;
      case 'room.merged':
        v.ahead = 0;
        v.merged = e;
        v.chat.push({ kind: 'merged', e });
        break;
    }
  }
  return v;
}

/** Who a lens is: its role, or its model when it has none. */
export const lensWhat = (p: Lens) => p.role ?? p.on?.split('@')[0].split('/').pop() ?? 'model';

/** A responsibility's short label: the preset's name, else its first words. */
export function responsibilityLabel(text: string | undefined, presets: { name: string; text: string }[] = []): string {
  if (!text) return '';
  const preset = presets.find(r => r.text === text);
  if (preset) return preset.name;
  const first = text.split(/[.:\n]/)[0].trim();
  return first.length > 32 ? `${first.slice(0, 31)}…` : first;
}

export const CARD_KINDS: { kind: CanvasCard['kind']; label: string; hint: string }[] = [
  { kind: 'question', label: 'Questions', hint: 'Still open to the room' },
  { kind: 'idea', label: 'Ideas', hint: 'Options and approaches' },
  { kind: 'finding', label: 'Findings', hint: 'Facts from the code, with where' },
  { kind: 'risk', label: 'Risks', hint: 'What could go wrong' },
  { kind: 'decision', label: 'Decided', hint: 'What you settled' },
];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
