import type { BoardFrame, CanvasCard, CanvasLink, CardKind, Knob, Lens, MhEvent, Output } from './types.ts';

/** A room, folded from its events (src/daemon.ts, design §21): everything the room view shows. */

/**
 * ask: from you to the lead; reply: the lead's; dispatch: an ask sent to a maker, by the lead or
 * by you; lens: a maker's answer; note: from MetaHarness.
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
  /** Stopped by you mid-way: what it had said by then. */
  stopped?: boolean;
}

export interface RoomView {
  lenses: Lens[];
  cards: CanvasCard[];
  links: CanvasLink[];
  frames: BoardFrame[];
  /** When each card first showed, and when it last changed: new and changed cards stand out for a while. */
  seen: Map<string, { added: number; changed: number }>;
  messages: RoomMsg[];
  from?: string;
}

export function roomOf(events: MhEvent[]): RoomView {
  const v: RoomView = { lenses: [], cards: [], links: [], frames: [], seen: new Map(), messages: [] };
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
        const before = new Map(v.cards.map(c => [c.id, JSON.stringify({ ...c, at: undefined, frame: undefined })]));
        for (const c of cards) {
          const was = v.seen.get(c.id);
          if (!was) v.seen.set(c.id, { added: t, changed: t });
          // Moving a card isn't changing it.
          else if (before.get(c.id) !== JSON.stringify({ ...c, at: undefined, frame: undefined })) was.changed = t;
        }
        v.cards = cards;
        v.links = (d.links as CanvasLink[]) ?? [];
        v.frames = (d.frames as BoardFrame[]) ?? [];
        break;
      }
      case 'room.message':
        v.messages.push({
          seq: e.seq, ts: e.ts, id: String(d.id), from: String(d.from), to: (d.to as string[]) ?? [], text: String(d.text ?? ''), kind: (d.kind as MsgKind) ?? 'reply',
          ...(d.card ? { card: String(d.card) } : {}), ...(d.stopped ? { stopped: true } : {}),
        });
        break;
    }
  }
  return v;
}

/** Who a maker is: its role, or its model when it has none. */
export const lensWhat = (p: Lens) => p.role ?? p.on?.split('@')[0].split('/').pop() ?? 'model';

/** A responsibility's short label: the preset's name, else its first words. */
export function responsibilityLabel(text: string | undefined, presets: { name: string; text: string }[] = []): string {
  if (!text) return '';
  const preset = presets.find(r => r.text === text);
  if (preset) return preset.name;
  const first = text.split(/[.:\n]/)[0].trim();
  return first.length > 32 ? `${first.slice(0, 31)}…` : first;
}

export const CARD_KINDS: { kind: CardKind; label: string; icon: string; hint: string }[] = [
  { kind: 'question', label: 'Question', icon: '?', hint: 'Still open' },
  { kind: 'idea', label: 'Idea', icon: '✦', hint: 'An option or a direction' },
  { kind: 'source', label: 'Source', icon: '↗', hint: 'From outside: a link, a reference' },
  { kind: 'image', label: 'Image', icon: '▣', hint: 'A picture of an idea' },
  { kind: 'demo', label: 'Demo', icon: '▶', hint: 'A playable page with knobs' },
  { kind: 'text', label: 'Write-up', icon: '¶', hint: 'An idea written out' },
  { kind: 'finding', label: 'Finding', icon: '◉', hint: 'A fact from the code, with where' },
  { kind: 'risk', label: 'Risk', icon: '!', hint: 'What could go wrong' },
  { kind: 'decision', label: 'Decision', icon: '✓', hint: 'What you settled' },
  { kind: 'concept', label: 'Concept', icon: '◆', hint: 'The idea as it stands, pillar by pillar' },
];
export const kindOf = (k: CardKind) => CARD_KINDS.find(x => x.kind === k) ?? CARD_KINDS[0];

/** What a mix can make, and the kind of maker that makes it. */
export const MIX_MAKES: { make: string; label: string; output: Output }[] = [
  { make: 'image', label: 'Image', output: 'image' },
  { make: 'demo', label: 'Demo', output: 'demo' },
  { make: 'text', label: 'Write-up', output: 'text' },
  { make: 'ideas', label: 'Ideas', output: 'text' },
  { make: 'source', label: 'References', output: 'source' },
];

/** What a mix usually takes from a card of each kind. */
export const TAKES: Partial<Record<CardKind, string[]>> = {
  image: ['its style', 'its palette', 'its mood', 'its characters', 'its composition'],
  source: ['its mechanics', 'its combat', 'its structure', 'its tone'],
  demo: ['its feel', 'its controls', 'its values'],
  text: ['its story', 'its characters', 'its world', 'its rules'],
  idea: ['the idea', 'its twist'],
  concept: ['the whole concept'],
};

/** A demo page's knobs: the JSON in its <script type="application/json" id="knobs"> tag (as src/rooms.ts reads it). */
export function demoKnobs(html: string): Knob[] {
  const m = /<script[^>]*\bid=["']knobs["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return [];
  try {
    const list = JSON.parse(m[1]);
    if (!Array.isArray(list)) return [];
    return list
      .filter(k => k && typeof k.name === 'string' && [k.min, k.max, k.value].every(v => Number.isFinite(Number(v))))
      .map(k => ({ name: k.name, label: k.label ? String(k.label) : undefined, min: Number(k.min), max: Number(k.max), value: Number(k.value), step: Number(k.step) > 0 ? Number(k.step) : undefined, unit: k.unit ? String(k.unit) : undefined }));
  } catch {
    return [];
  }
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
