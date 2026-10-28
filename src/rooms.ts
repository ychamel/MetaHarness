import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { parseFrontMatter } from './config.ts';
import type { Role } from './types.ts';

/**
 * Brainstorm rooms (design §21): a place to get clarity and reach a decision. The human talks
 * with one lead agent, a facilitator that keeps a board of cards (ideas, sources, images,
 * playable demos, write-ups, decisions) and sends makers to produce them; the human can also
 * ask a maker directly or mix cards into something new. A room is a goal underneath (the same
 * agents, events, costs and views). This file holds the plain parts: makers and casts, the
 * board, and what the lead and the makers are told.
 *
 * Makers are called lenses in the protocol and the code (room.lens, room.lenses), the name
 * they had in the first rooms.
 */

/** A maker the lead may send, or the human ask: a role (or just a model), what it makes in this room, and how it should look at things. */
export interface Lens {
  /** A role from the configuration; none: the maker is just a model (`on` is then required). */
  role?: string;
  /** Its name in the room; default the role's, or the model's. */
  name?: string;
  /** "harness/model" or "harness/model@effort", instead of the role's own. */
  on?: string;
  /** What it's for here: the lead picks makers by it. Default: the role's usual one. */
  responsibility?: string;
  /** How it should look at the question, e.g. "argue for the simplest fix". */
  stance?: string;
  /** Put away by the human: nobody can send it until it's back. */
  off?: boolean;
}

/** A saved set of makers: casts/<name>.md. */
export interface Cast {
  name: string;
  goodAt: string;
  participants: Lens[];
  file: string;
}

/** What a maker puts on the board: a card kind. */
export type Output = 'source' | 'image' | 'demo' | 'text';

/** Responsibilities to start from, each with what it makes; a maker keeps its own text, edited or not. */
export const RESPONSIBILITIES: { name: string; text: string; roles: string[]; makes: Output }[] = [
  { name: 'Research', makes: 'source', roles: ['researcher', 'scout', 'explorer'], text: 'Find things out, on the web and in the code: how others did it, references, facts. Each on the board with where it came from: a source card (link, short quote) or a finding (file:line).' },
  { name: 'Illustrate', makes: 'image', roles: ['illustrator', 'artist'], text: 'Make images: concepts, mood and style frames, characters, places, UI mockups. Each on the board as an image card, the prompt you used in its text.' },
  { name: 'Prototype', makes: 'demo', roles: ['prototyper'], text: 'Make small throwaway demos that give a feel for how something works: one playable page each, with knobs for the values that matter, ported from the real code when there is one.' },
  { name: 'Write', makes: 'text', roles: ['writer', 'creative'], text: 'Write it out: a mechanic, a story, characters, a world, a flow; or a handful of distinct ideas. Short and vivid, on the board as text or idea cards.' },
  { name: 'Big picture', makes: 'text', roles: ['designer', 'architect'], text: 'Explain the bigger picture: how the parts fit, what a direction means for the design, the trade-offs, and where things should live.' },
  { name: 'Review', makes: 'text', roles: ['reviewer'], text: 'Review a direction: the risks, gaps and edge cases, and what would break. Say what you would change and why.' },
];

/** The preset a maker's responsibility (or its role) comes from. */
function presetOf(p: Lens) {
  if (p.responsibility?.trim()) return RESPONSIBILITIES.find(r => r.text === p.responsibility!.trim());
  const role = p.role?.toLowerCase() ?? '';
  return RESPONSIBILITIES.find(r => r.roles.some(x => role === x || role.includes(x)));
}

/** A maker's responsibility: its own, else its role's usual one, else none. */
export function responsibilityOf(p: Lens): string {
  if (p.responsibility?.trim()) return p.responsibility.trim();
  return presetOf(p)?.text ?? '';
}

/** What a maker makes: its preset's output; a responsibility of its own makes text. */
export function makesOf(p: Lens): Output {
  return presetOf(p)?.makes ?? 'text';
}

/** A short label: the preset's name when the text is one, else its first words. */
export function responsibilityLabel(text: string): string {
  const preset = RESPONSIBILITIES.find(r => r.text === text);
  if (preset) return preset.name;
  const first = text.split(/[.:\n]/)[0].trim();
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}

/** A maker that's just a model: a role made from it, its instructions being the responsibility. */
export function modelRole(p: Lens): Role {
  const on = p.on ?? '';
  const at = on.lastIndexOf('@');
  const route = at > 0 ? on.slice(0, at) : on;
  const slash = route.indexOf('/');
  return {
    name: 'model', harness: slash > 0 ? route.slice(0, slash) : route, model: slash > 0 ? route.slice(slash + 1) : '', ...(at > 0 ? { effort: on.slice(at + 1).toLowerCase() } : {}),
    fallback: [], goodAt: responsibilityOf(p), instructions: '', helper: false, allow: [], autoApprove: 'read-only', mcp: [], worktree: false, file: '(room lens)',
  };
}

/** The makers a room starts with when nobody picked any: the built-in four, those that exist. */
export const DEFAULT_MAKERS = ['researcher', 'illustrator', 'prototyper', 'writer'];

/* ---------------- the board ---------------- */

/**
 * question: still open; idea: an option or direction; finding: a fact from the code; risk: what
 * could go wrong; decision: what the human settled; source: something from outside (a link, a
 * reference); image: a picture; demo: a playable page; text: a write-up; concept: the idea as it
 * stands, pillar by pillar.
 */
export type CardKind = 'question' | 'idea' | 'finding' | 'risk' | 'decision' | 'source' | 'image' | 'demo' | 'text' | 'concept';
export const CARD_KINDS: CardKind[] = ['question', 'idea', 'finding', 'risk', 'decision', 'source', 'image', 'demo', 'text', 'concept'];
const KIND_WORDS: Record<string, CardKind> = {
  option: 'idea', approach: 'idea', proposal: 'idea', direction: 'idea', fact: 'finding', evidence: 'finding', concern: 'risk', issue: 'risk', problem: 'risk', decided: 'decision',
  reference: 'source', link: 'source', web: 'source', picture: 'image', art: 'image', illustration: 'image', prototype: 'demo', playable: 'demo', sketch: 'demo',
  writeup: 'text', 'write-up': 'text', description: 'text', pillar: 'concept',
};

/** One knob of a demo, as its page declares it. */
export interface Knob {
  name: string;
  label?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
}

/** A pillar of a concept: one aspect of the idea and the cards it comes from. */
export interface Pillar {
  name: string;
  text: string;
  cards?: string[];
}

/** An ingredient of a mix: a card, and what to take from it. */
export interface Ingredient {
  id: string;
  take?: string;
}

export interface Card {
  id: string;
  kind: CardKind;
  /** A few words: what the card says at a glance. */
  title: string;
  /** More, when the title isn't enough (markdown). */
  text?: string;
  /** Files (path or path:line) it rests on. */
  refs?: string[];
  /** An image or a demo: its file, relative to the room's shared folder. */
  file?: string;
  /** A source's link. */
  url?: string;
  /** Kept knob values, e.g. from a demo the human tuned. */
  values?: Record<string, number>;
  /** A concept's pillars. */
  pillars?: Pillar[];
  /** What it was made from. */
  from?: Ingredient[];
  /** The frame it's in. */
  frame?: string;
  /** Where the human put it, outside a frame; unplaced cards are laid out for them. */
  at?: { x: number; y: number };
  /** Being made by this maker: a placeholder until it's filled. */
  pending?: string;
  /** open (default); settled: answered or done; dropped: an idea turned down, a finding that proved wrong. */
  status?: 'settled' | 'dropped';
  /** The human, the lead, a maker, or where it was carried over from. */
  by: string;
  /** What makers (or the human) added to someone else's card. */
  notes?: { by: string; text: string }[];
  /** Rooms branched off from it. */
  branches?: string[];
}

export interface CardLink {
  from: string;
  to: string;
  /** e.g. "answers", "rules out", "depends on". */
  label?: string;
}

/** A named group of cards on the board. */
export interface Frame {
  id: string;
  title: string;
  at?: { x: number; y: number };
}

export interface Canvas {
  cards: Card[];
  links: CardLink[];
  frames: Frame[];
  seq: number;
}

/** What a card may be given when it's added or edited, besides its kind and title. */
interface CardFields {
  text?: string;
  refs?: string[];
  file?: string;
  url?: string;
  values?: Record<string, number>;
  pillars?: Pillar[];
  from?: Ingredient[];
  /** A frame's id or title (a new title makes the frame); '' takes it out. */
  frame?: string;
}

export type CanvasOp =
  | ({ op: 'add'; kind: CardKind; title: string; links?: { to: string; label?: string }[]; ref?: string } & CardFields)
  | ({ op: 'edit'; id: string; title?: string; kind?: CardKind } & CardFields)
  | { op: 'settle' | 'drop' | 'reopen'; id: string }
  | { op: 'note'; id: string; text: string }
  | { op: 'link'; from: string; to: string; label?: string }
  | { op: 'unlink'; from: string; to: string }
  | { op: 'remove'; id: string }
  /** Makes a frame (or names one again, by id), and puts cards in it. */
  | { op: 'frame'; id?: string; title?: string; cards?: string[] }
  /** Puts a card in a frame, or (frame '') where the human dropped it; or moves a frame. */
  | { op: 'move'; id: string; frame?: string; x?: number; y?: number }
  /** Lets cards (or every free card and frame: no ids) be laid out again. */
  | { op: 'tidy'; ids?: string[] };

export interface CanvasResult {
  changed: boolean;
  /** One line per change, for whoever made it and for the lead. */
  done: string[];
  /** Ops that were skipped, and why. */
  skipped: string[];
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A card kind from what a model may write ("option", "Finding"). */
export function cardKind(v: unknown): CardKind | undefined {
  const k = String(v ?? '').toLowerCase().trim().replace(/s$/, '');
  return CARD_KINDS.includes(k as CardKind) ? (k as CardKind) : KIND_WORDS[k];
}

/** A file in the shared folder, relative to it, from what an agent wrote (an absolute path, shared/…, or relative). Undefined: outside it. */
export function sharedPath(shared: string, p: string): string | undefined {
  const raw = p.trim().replace(/^file:\/\//, '');
  if (!raw) return undefined;
  const rel = isAbsolute(raw) ? relative(shared, raw) : normalize(raw.replace(/^shared\//, ''));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * Applies changes to the board. A card added with `ref` can be linked to by that ref later in
 * the same call. Unknown ids, empty titles and repeats are skipped and said so. `shared` is the
 * room's shared folder: a card's file must be in it.
 */
export function applyCanvas(c: Canvas, ops: CanvasOp[], by: string, shared?: string): CanvasResult {
  const out: CanvasResult = { changed: false, done: [], skipped: [] };
  const refs = new Map<string, string>();
  const idOf = (x: string) => {
    const k = String(x ?? '').trim().replace(/^#/, '');
    return refs.get(k) ?? c.cards.find(card => card.id.toLowerCase() === k.toLowerCase())?.id;
  };
  const frameOf = (x: string) => {
    const k = String(x ?? '').trim().toLowerCase();
    return c.frames.find(f => f.id.toLowerCase() === k) ?? c.frames.find(f => f.title.toLowerCase() === k);
  };
  /** A frame by id or title, made when the title is new. */
  const frameFor = (x: string): Frame | undefined => {
    const found = frameOf(x);
    if (found || !x.trim()) return found;
    const f: Frame = { id: `f${c.frames.length ? Math.max(...c.frames.map(f => Number(f.id.slice(1)) || 0)) + 1 : 1}`, title: cut(x.trim(), 60) };
    c.frames.push(f);
    out.done.push(`made frame ${f.id}: ${f.title}`);
    return f;
  };
  const link = (from: string, to: string, label?: string) => {
    if (from === to || c.links.some(l => l.from === from && l.to === to)) return false;
    c.links.push({ from, to, ...(label?.trim() ? { label: cut(label.trim(), 40) } : {}) });
    return true;
  };
  /** Sets the fields an add or edit carries; what it couldn't take goes to skipped. */
  const fill = (card: Card, f: CardFields) => {
    if (f.text !== undefined) {
      if (f.text.trim()) card.text = cut(f.text.trim(), 4000);
      else delete card.text;
    }
    if (f.refs) card.refs = f.refs.map(r => r.trim()).filter(Boolean).slice(0, 8);
    if (f.file !== undefined) {
      const rel = f.file.trim() ? (shared ? sharedPath(shared, f.file) : f.file.trim()) : '';
      if (rel) card.file = rel;
      else if (!f.file.trim()) delete card.file;
      else out.skipped.push(`${card.id}'s file ${f.file} isn't in the room's shared folder: save it there`);
    }
    if (f.url !== undefined) {
      if (/^https?:\/\/\S+$/i.test(f.url.trim())) card.url = f.url.trim();
      else if (!f.url.trim()) delete card.url;
    }
    if (f.values) {
      const values = Object.fromEntries(Object.entries(f.values).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v)));
      if (Object.keys(values).length) card.values = values;
    }
    if (f.pillars) {
      card.pillars = f.pillars
        .filter(p => p && String(p.name ?? '').trim())
        .slice(0, 12)
        .map(p => ({ name: cut(String(p.name).trim(), 40), text: cut(String(p.text ?? '').trim(), 600), ...(p.cards?.length ? { cards: p.cards.map(x => idOf(x) ?? x).slice(0, 8) } : {}) }));
    }
    if (f.from) {
      const from = f.from.map(i => ({ id: idOf(i.id), take: i.take?.trim() })).filter((i): i is { id: string; take: string | undefined } => !!i.id && i.id !== card.id);
      card.from = from.map(i => ({ id: i.id, ...(i.take ? { take: cut(i.take, 60) } : {}) }));
      if (!card.from.length) delete card.from;
    }
    if (f.frame !== undefined) {
      const fr = frameFor(f.frame);
      if (fr) {
        card.frame = fr.id;
        delete card.at;
      } else delete card.frame;
    }
  };
  for (const op of ops) {
    if (op.op === 'add') {
      const title = op.title?.trim();
      if (!title || !CARD_KINDS.includes(op.kind)) {
        out.skipped.push(`a card needs a kind (${CARD_KINDS.join(', ')}) and a title`);
        continue;
      }
      const same = c.cards.find(x => x.kind === op.kind && x.title.toLowerCase() === title.toLowerCase());
      if (same) {
        if (op.ref) refs.set(op.ref, same.id);
        out.skipped.push(`"${cut(title, 60)}" is already on the board as ${same.id}`);
        continue;
      }
      const card: Card = { id: `c${++c.seq}`, kind: op.kind, title: cut(title, 160), by };
      fill(card, op);
      c.cards.push(card);
      if (op.ref) refs.set(op.ref, card.id);
      const linked = (op.links ?? []).map(l => ({ to: idOf(l.to), label: l.label })).filter(l => !!l.to && link(card.id, l.to, l.label));
      out.done.push(`added ${card.id} (${card.kind}): ${cut(card.title, 80)}${linked.length ? `, linked to ${linked.map(l => l.to).join(', ')}` : ''}`);
      out.changed = true;
      continue;
    }
    if (op.op === 'link' || op.op === 'unlink') {
      const from = idOf(op.from);
      const to = idOf(op.to);
      if (!from || !to) {
        out.skipped.push(`there's no card ${!from ? op.from : op.to}`);
        continue;
      }
      if (op.op === 'link') {
        if (!link(from, to, op.label)) continue;
        out.done.push(`linked ${from} → ${to}${op.label ? ` (${op.label})` : ''}`);
      } else {
        const before = c.links.length;
        c.links = c.links.filter(l => !((l.from === from && l.to === to) || (l.from === to && l.to === from)));
        if (c.links.length === before) continue;
        out.done.push(`unlinked ${from} and ${to}`);
      }
      out.changed = true;
      continue;
    }
    if (op.op === 'frame') {
      const before = out.done.length;
      const fr = op.id ? frameOf(op.id) : frameFor(op.title ?? '');
      if (!fr) {
        out.skipped.push(op.id ? `there's no frame ${op.id}` : 'a frame needs a title');
        continue;
      }
      if (op.id && op.title?.trim() && op.title.trim() !== fr.title) {
        fr.title = cut(op.title.trim(), 60);
        out.done.push(`named frame ${fr.id} ${fr.title}`);
      }
      const moved = (op.cards ?? []).map(idOf).filter((id): id is string => !!id);
      for (const id of moved) {
        const card = c.cards.find(x => x.id === id)!;
        card.frame = fr.id;
        delete card.at;
      }
      if (moved.length) out.done.push(`put ${moved.join(', ')} in frame ${fr.id} (${fr.title})`);
      if (out.done.length > before) out.changed = true;
      continue;
    }
    if (op.op === 'tidy') {
      const ids = new Set((op.ids ?? []).map(x => String(x).toLowerCase()));
      const all = !ids.size;
      for (const card of c.cards) if (!card.frame && (all || ids.has(card.id.toLowerCase()))) delete card.at;
      for (const f of c.frames) if (all || ids.has(f.id.toLowerCase())) delete f.at;
      out.done.push(all ? 'tidied the board' : `tidied ${[...ids].join(', ')}`);
      out.changed = true;
      continue;
    }
    const fr = op.op === 'move' || op.op === 'remove' ? c.frames.find(f => f.id.toLowerCase() === String(op.id ?? '').trim().toLowerCase()) : undefined;
    if (fr) {
      if (op.op === 'remove') {
        // Its cards stay, free again.
        for (const card of c.cards) if (card.frame === fr.id) delete card.frame;
        c.frames.splice(c.frames.indexOf(fr), 1);
        out.done.push(`removed frame ${fr.id} (${fr.title}), keeping its cards`);
      } else if (op.op === 'move' && Number.isFinite(op.x) && Number.isFinite(op.y)) {
        fr.at = { x: Math.round(op.x!), y: Math.round(op.y!) };
        out.done.push(`moved frame ${fr.id}`);
      } else continue;
      out.changed = true;
      continue;
    }
    const id = idOf(op.id);
    const card = id ? c.cards.find(x => x.id === id) : undefined;
    if (!card) {
      out.skipped.push(`there's no card ${op.id}`);
      continue;
    }
    if (op.op === 'edit') {
      if (op.title?.trim()) card.title = cut(op.title.trim(), 160);
      if (op.kind && CARD_KINDS.includes(op.kind)) card.kind = op.kind;
      fill(card, op);
      // Filled in: no longer a placeholder.
      if (card.pending && (op.title?.trim() || op.file || op.text)) delete card.pending;
      out.done.push(`edited ${card.id}`);
    } else if (op.op === 'move') {
      if (op.frame !== undefined && op.frame.trim()) {
        const f = frameOf(op.frame);
        if (!f) {
          out.skipped.push(`there's no frame ${op.frame}`);
          continue;
        }
        card.frame = f.id;
        delete card.at;
        out.done.push(`put ${card.id} in frame ${f.id} (${f.title})`);
      } else {
        delete card.frame;
        if (Number.isFinite(op.x) && Number.isFinite(op.y)) card.at = { x: Math.round(op.x!), y: Math.round(op.y!) };
        out.done.push(`moved ${card.id}`);
      }
    } else if (op.op === 'settle' || op.op === 'drop') {
      card.status = op.op === 'settle' ? 'settled' : 'dropped';
      out.done.push(`${op.op === 'settle' ? 'settled' : 'dropped'} ${card.id}`);
    } else if (op.op === 'reopen') {
      if (!card.status) continue;
      delete card.status;
      out.done.push(`reopened ${card.id}`);
    } else if (op.op === 'note') {
      if (!op.text?.trim()) continue;
      (card.notes ??= []).push({ by, text: cut(op.text.trim(), 600) });
      out.done.push(`noted on ${card.id}`);
    } else if (op.op === 'remove') {
      c.cards.splice(c.cards.indexOf(card), 1);
      c.links = c.links.filter(l => l.from !== card.id && l.to !== card.id);
      for (const x of c.cards) if (x.from?.some(i => i.id === card.id)) x.from = x.from.filter(i => i.id !== card.id);
      out.done.push(`removed ${card.id}`);
    } else continue;
    out.changed = true;
  }
  return out;
}

/** Board ops from whatever shape a model sends: `ops` (or `changes`) as a list or JSON, or one op at the top level. */
export function parseCanvasOps(raw: Record<string, unknown>): CanvasOp[] {
  let list: unknown = raw.ops ?? raw.changes ?? raw.operations ?? raw.cards;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = undefined;
    }
  }
  const items = Array.isArray(list) ? list : list && typeof list === 'object' ? [list] : raw.op || raw.title ? [raw] : [];
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? undefined : String(v));
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/,\s*/) : undefined);
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const obj = (v: unknown) => {
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        return undefined;
      }
    }
    return v && typeof v === 'object' ? v : undefined;
  };
  /** Ingredients: ids, or {id, take}, or "c3: its style" lines. */
  const ingredients = (v: unknown): Ingredient[] | undefined => {
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/,\s*/) : undefined;
    return list?.map(x => {
      if (x && typeof x === 'object') return { id: String((x as Record<string, unknown>).id ?? (x as Record<string, unknown>).card ?? ''), take: str((x as Record<string, unknown>).take) };
      const m = /^\s*([\w-]+)\s*(?::\s*(.*))?$/.exec(String(x));
      return { id: m?.[1] ?? String(x), take: m?.[2] };
    });
  };
  const fields = (o: Record<string, unknown>, add: boolean): CardFields => ({
    ...(add && o.title && o.text ? { text: str(o.text) } : !add && (o.text ?? o.detail) !== undefined ? { text: str(o.text ?? o.detail) } : add && o.detail ? { text: str(o.detail) } : {}),
    ...(strs(o.refs ?? o.files) ? { refs: strs(o.refs ?? o.files) } : {}),
    ...(o.file ?? o.path ?? o.image ?? o.demo ? { file: str(o.file ?? o.path ?? o.image ?? o.demo) } : {}),
    ...(o.url ?? o.link ? { url: str(o.url ?? o.link) } : {}),
    ...(obj(o.values) ? { values: obj(o.values) as Record<string, number> } : {}),
    ...(Array.isArray(obj(o.pillars)) ? { pillars: obj(o.pillars) as Pillar[] } : {}),
    ...(ingredients(o.from ?? o.ingredients) ? { from: ingredients(o.from ?? o.ingredients) } : {}),
    ...(o.frame !== undefined ? { frame: str(o.frame) ?? '' } : {}),
  });
  const out: CanvasOp[] = [];
  for (const x of items) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const op = String(o.op ?? o.action ?? (o.title ? 'add' : '')).toLowerCase();
    const id = str(o.id ?? o.card) ?? '';
    if (op === 'add' || op === 'create') {
      const links = (Array.isArray(o.links) ? o.links : strs(o.links ?? o.link_to ?? o.to) ?? [])
        .map(l => (l && typeof l === 'object' ? { to: String((l as Record<string, unknown>).to ?? ''), label: str((l as Record<string, unknown>).label) } : { to: String(l) }))
        .filter(l => l.to);
      out.push({ op: 'add', kind: cardKind(o.kind ?? o.type) as CardKind, title: str(o.title ?? o.text) ?? '', ...fields(o, true), ...(links.length ? { links } : {}), ...(o.ref ? { ref: str(o.ref) } : {}) });
    } else if (op === 'edit' || op === 'update' || op === 'fill') out.push({ op: 'edit', id, title: str(o.title), kind: cardKind(o.kind ?? o.type), ...fields(o, false) });
    else if (['settle', 'drop', 'reopen', 'remove'].includes(op)) out.push({ op: op as 'settle' | 'drop' | 'reopen' | 'remove', id });
    else if (op === 'close' || op === 'resolve' || op === 'answer') out.push({ op: 'settle', id });
    else if (op === 'delete') out.push({ op: 'remove', id });
    else if (op === 'note' || op === 'comment') out.push({ op: 'note', id, text: str(o.text ?? o.note) ?? '' });
    else if (op === 'link' || op === 'unlink') out.push({ op, from: str(o.from) ?? id, to: str(o.to) ?? '', ...(op === 'link' && o.label ? { label: str(o.label) } : {}) } as CanvasOp);
    else if (op === 'frame' || op === 'group') out.push({ op: 'frame', ...(o.id ? { id: str(o.id) } : {}), title: str(o.title ?? o.name), cards: strs(o.cards ?? o.ids) });
    else if (op === 'move' || op === 'place') out.push({ op: 'move', id, ...(o.frame !== undefined ? { frame: str(o.frame) ?? '' } : {}), x: num(o.x), y: num(o.y) });
    else if (op === 'tidy') out.push({ op: 'tidy', ids: strs(o.ids ?? o.cards) });
  }
  return out;
}

const HEADINGS: Record<CardKind, string> = {
  question: 'Questions', idea: 'Ideas', finding: 'Findings', risk: 'Risks', decision: 'Decided', source: 'Sources', image: 'Images', demo: 'Demos', text: 'Write-ups', concept: 'Concepts',
};

/** The board as the agents read it: frame by frame, then the cards outside frames by kind, with ids, files, links and notes. */
export function canvasMarkdown(topic: string, c: Canvas, shared?: string): string {
  const title = (id: string) => c.cards.find(x => x.id === id)?.title;
  const card = (x: Card) => {
    const out = c.links.filter(l => l.from === x.id).map(l => `→ ${l.to}${l.label ? ` (${l.label})` : ''}`);
    return [
      `- [${x.id}] (${x.kind}${x.status ? `, ${x.status}` : ''}${x.pending ? `, being made by ${x.pending}` : ''}) ${x.title}${out.length ? `  ${out.join(', ')}` : ''}  — ${x.by}`,
      ...(x.text ? [`  ${x.text.replace(/\n/g, '\n  ')}`] : []),
      ...(x.file ? [`  file: ${shared ? join(shared, x.file) : x.file}`] : []),
      ...(x.url ? [`  link: ${x.url}`] : []),
      ...(x.values ? [`  values: ${Object.entries(x.values).map(([k, v]) => `${k} = ${v}`).join(', ')}`] : []),
      ...(x.from?.length ? [`  made from: ${x.from.map(i => `${i.id}${title(i.id) ? ` "${cut(title(i.id)!, 40)}"` : ''}${i.take ? ` (${i.take})` : ''}`).join(', ')}`] : []),
      ...(x.pillars ?? []).map(p => `  ◆ ${p.name}: ${p.text}${p.cards?.length ? ` [${p.cards.join(', ')}]` : ''}`),
      ...(x.refs?.length ? [`  files: ${x.refs.join(', ')}`] : []),
      ...(x.notes ?? []).map(n => `  · ${n.by}: ${n.text}`),
    ].join('\n');
  };
  const parts = [`# Board: ${topic.split('\n')[0]}`];
  for (const f of c.frames) {
    const cards = c.cards.filter(x => x.frame === f.id);
    parts.push(`## Frame ${f.id}: ${f.title}\n\n${cards.length ? cards.map(card).join('\n') : '(empty)'}`);
  }
  for (const k of CARD_KINDS) {
    const cards = c.cards.filter(x => x.kind === k && !x.frame);
    if (cards.length) parts.push(`## ${HEADINGS[k]}${c.frames.length ? ' (outside frames)' : ''}\n\n${cards.map(card).join('\n')}`);
  }
  if (parts.length === 1) parts.push('(empty so far)');
  return parts.join('\n\n') + '\n';
}

/** The cards a branch takes along: the ones picked, the ones linked to them, and the links between them all. */
export function branchCards(c: Canvas, ids: string[]): { cards: Card[]; links: CardLink[] } {
  const picked = new Set(ids.filter(id => c.cards.some(x => x.id === id)));
  const keep = new Set(picked);
  for (const l of c.links) {
    if (picked.has(l.from)) keep.add(l.to);
    if (picked.has(l.to)) keep.add(l.from);
  }
  return { cards: c.cards.filter(x => keep.has(x.id)), links: c.links.filter(l => keep.has(l.from) && keep.has(l.to)) };
}

/** Cards carried onto a new board under new ids, with the links between them; out of their frames, to be laid out afresh. */
export function seedCanvas(c: Canvas, from: { cards: Card[]; links: CardLink[] }, by: string): void {
  const ids = new Map<string, string>();
  for (const x of from.cards) ids.set(x.id, `c${++c.seq}`);
  for (const x of from.cards) {
    const { branches: _branches, frame: _frame, at: _at, pending: _pending, ...rest } = x;
    const card: Card = { ...rest, id: ids.get(x.id)!, by: x.by === 'human' || x.by.startsWith('room ') || x.by.startsWith('goal ') ? x.by : by };
    const kept = rest.from?.filter(i => ids.has(i.id)).map(i => ({ ...i, id: ids.get(i.id)! }));
    if (kept?.length) card.from = kept;
    else delete card.from;
    if (rest.pillars) card.pillars = rest.pillars.map(p => ({ ...p, cards: p.cards?.filter(id => ids.has(id)).map(id => ids.get(id)!) }));
    c.cards.push(card);
  }
  for (const l of from.links) if (ids.has(l.from) && ids.has(l.to)) c.links.push({ ...l, from: ids.get(l.from)!, to: ids.get(l.to)! });
}

/* ---------------- demos ---------------- */

/** A demo page's knobs: the JSON in its <script type="application/json" id="knobs"> tag. */
export function demoKnobs(html: string): Knob[] {
  const m = /<script[^>]*\bid=["']knobs["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return [];
  try {
    const list = JSON.parse(m[1]);
    if (!Array.isArray(list)) return [];
    return list
      .filter(k => k && typeof k.name === 'string' && [k.min, k.max, k.value].every(v => Number.isFinite(Number(v))))
      .map(k => ({ name: k.name, ...(k.label ? { label: String(k.label) } : {}), min: Number(k.min), max: Number(k.max), value: Number(k.value), ...(Number(k.step) > 0 ? { step: Number(k.step) } : {}), ...(k.unit ? { unit: String(k.unit) } : {}) }));
  } catch {
    return [];
  }
}

/**
 * A demo page as the room plays it: `window.knobs` holds its knobs' values before its own
 * scripts run, and changes as the human moves the sliders the room draws (a message from the
 * page around it); a `knobs` event says when. Values may start from a kept set.
 */
export function demoPage(html: string, values: Record<string, number> = {}): string {
  const knobs = Object.fromEntries(demoKnobs(html).map(k => [k.name, values[k.name] ?? k.value]));
  const shim = `<script>(function(){var k=window.knobs=${JSON.stringify(knobs).replace(/</g, '\\u003c')};addEventListener('message',function(e){var d=e.data;if(!d||d.type!=='mh-knobs')return;for(var n in d.values)k[n]=d.values[n];dispatchEvent(new CustomEvent('knobs',{detail:k}))})})();</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + shim + html.slice(head.index + head[0].length);
  return shim + html;
}

/* ---------------- the room ---------------- */

export interface RoomState {
  topic: string;
  /** The makers the human set up; the lead sends them, the human asks them. A maker's agent starts the first time it's asked. */
  lenses: Lens[];
  canvas: Canvas;
}

/* ---------------- casts ---------------- */

/**
 * casts/<name>.md: one `## <role, or "model"> [as <name>]` heading per maker, then `on:`,
 * `responsibility:` and `stance:` lines as needed.
 */
export function parseCast(file: string): Cast {
  const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'));
  const participants: Lens[] = [];
  let lens: Lens | undefined;
  for (const line of body.split('\n')) {
    const h = /^##\s+([\w.-]+)(?:\s+as\s+([\w.-]+))?\s*$/.exec(line);
    if (h) {
      lens = { ...(h[1] === 'model' ? {} : { role: h[1] }), ...(h[2] ? { name: h[2] } : {}) };
      participants.push(lens);
      continue;
    }
    const kv = /^(on|responsibility|stance):\s*(.*\S)\s*$/.exec(line);
    if (lens && kv) lens[kv[1] as 'on' | 'responsibility' | 'stance'] = kv[2];
  }
  return { name: basename(file, '.md'), goodAt: meta.good_at ?? '', participants: participants.filter(p => p.role || p.on), file };
}

export function castText(c: { goodAt?: string; participants: Lens[] }): string {
  const lenses = c.participants.map(p =>
    [
      `## ${p.role || 'model'}${p.name ? ` as ${p.name}` : ''}`,
      ...(p.on ? [`on: ${p.on}`] : []),
      ...(p.responsibility ? [`responsibility: ${p.responsibility.replace(/\s+/g, ' ')}`] : []),
      ...(p.stance ? [`stance: ${p.stance.replace(/\s+/g, ' ')}`] : []),
    ].join('\n'),
  );
  return `---\ngood_at: ${(c.goodAt ?? '').replace(/\n/g, ' ')}\n---\n${lenses.join('\n\n')}\n`;
}

/** casts/*.md from each folder; later folders win. */
export function loadCasts(dirs: string[]): Map<string, Cast> {
  const out = new Map<string, Cast>();
  for (const dir of dirs) {
    const d = join(dir, 'casts');
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter(f => f.endsWith('.md'))) out.set(basename(f, '.md'), parseCast(join(d, f)));
  }
  return out;
}

/** The model's short name: gpt-6.1-sol → sol, claude-opus-5-5 → opus. */
export function modelWord(on?: string): string | undefined {
  const model = on?.split('@')[0].split('/').pop();
  if (!model) return undefined;
  const words = model.split(/[-._]/).filter(w => w && !/^\d+$/.test(w) && !/^(gpt|claude|gemini|high|low|medium)$/i.test(w));
  return words.at(-1) ?? model;
}

/** Names safe for branches and messages. */
export function lensName(p: Lens, taken: Iterable<string>): string {
  const used = new Set([...taken].map(n => n.toLowerCase()));
  const clean = (s: string) => s.trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const model = modelWord(p.on);
  const role = p.role ? clean(p.role) : '';
  let name = clean(p.name ?? '') || (!role ? clean(model ?? 'model') : used.has(role.toLowerCase()) && model ? `${role}-${clean(model)}` : role);
  const base = name;
  for (let n = 2; used.has(name.toLowerCase()) || ['main', 'room', 'lead', 'human', 'all'].includes(name.toLowerCase()); n++) name = `${base}-${n}`;
  return name;
}

/* ---------------- what the lead and the makers are told ---------------- */

export interface RoomPaths {
  /** The board, as markdown. */
  canvas: string;
  chat: string;
  reports: string;
  /** Where images go, and demos. */
  media: string;
  demos: string;
}

/** What a harness can do for a maker, when it says. */
export interface MakerCan {
  web?: boolean;
  images?: boolean;
}

/** One line per maker: its name, what it is, what it makes and is for, what its harness can do, and whether it's started or put away. */
export function lensLines(lenses: Lens[], started: (name: string) => boolean, can: (p: Lens) => MakerCan = () => ({})): string[] {
  return lenses.map(p => {
    const what = p.role ?? modelWord(p.on) ?? 'model';
    const r = responsibilityOf(p);
    const c = can(p);
    const abilities = [c.web ? 'searches the web' : '', c.images ? 'makes images' : ''].filter(Boolean);
    return `- ${p.name} (${what}${p.on ? ` on ${p.on}` : ''}; makes ${makesOf(p)} cards${abilities.length ? `; ${abilities.join(', ')}` : ''}): ${r || 'no responsibility given'}${p.stance ? ` Stance: ${p.stance}` : ''}${p.off ? ' [put away by the human: not available]' : started(p.name!) ? ' [started: it remembers what it did here]' : ''}`;
  });
}

export const CANVAS_HOW = [
  'The board holds cards with links, grouped in frames; the human watches it instead of reading the chat back. Change it with the `canvas` tool: `ops` is a list of',
  '  {"op": "add", "kind": "question" | "idea" | "finding" | "risk" | "decision" | "source" | "image" | "demo" | "text" | "concept", "title": "a few words", "text": "optional detail",',
  '    "refs": ["src/x.ts:40"], "file": "room/media/x.png", "url": "https://…", "from": [{"id": "c2", "take": "its palette"}], "frame": "Art direction", "links": [{"to": "c2", "label": "answers"}], "ref": "a"}',
  '  {"op": "edit", "id": "c3", "title": "…", "file": "…"}, {"op": "settle" | "drop" | "reopen" | "remove", "id": "c3"}, {"op": "note", "id": "c3", "text": "…"}, {"op": "link", "from": "c4", "to": "c2", "label": "rules out"}',
  '  {"op": "frame", "title": "Combat", "cards": ["c3", "c5"]} (makes the frame if it is new; with "id": "f1", names it again)',
  '  A card added with "ref" can be linked to by that ref later in the same call; "frame" on a card puts it in that frame (a new title makes one). `canvas` without ops shows the whole board.',
].join('\n');

/** How each kind of maker does its work. */
const MAKER_HOW: Record<Output, (paths: RoomPaths) => string[]> = {
  source: () => [
    '- Search the web (and the code, when the question is about it). Each thing worth keeping is a source card: url, a short quote or summary in text, the title saying what it shows. Facts from the code are findings with file:line refs.',
  ],
  image: p => [
    `- Make images with your harness's own image generation (on Antigravity, its image-generator subagent: the one subagent allowed here). Never draw them by hand or with code instead: if it fails, say so. Save each as a file in ${p.media}/ (png, jpg, webp or svg) and put it on the board as an image card with "file", the prompt you used in its text.`,
    "- When the ask is a mix, take from each ingredient exactly what it says to take, and nothing else from it.",
  ],
  demo: p => [
    `- A demo is one self-contained HTML page in ${p.demos}/<name>.html: plain canvas or DOM, everything inline, nothing to install. It gives a feel for how something works, not the whole thing: one mechanic, one screen, placeholder shapes. Keep it small and quick to make; it's thrown away.`,
    '- Knobs: the values that matter are declared in the page as',
    '    <script type="application/json" id="knobs">[{"name": "gravity", "label": "Gravity", "min": 200, "max": 3000, "step": 10, "value": 1400, "unit": "px/s²"}]</script>',
    '  The room draws a slider for each and sets `window.knobs` before your scripts run (`knobs.gravity`); it changes live as the human moves them (a `knobs` event fires). Read the values every frame; never draw sliders of your own.',
    "- When the project has the real thing (the engine's movement code, a shader, a formula), port it: the same formulas, units, timestep and order of updates, knobs named after the real parameters and starting at their real values. Name the files you ported from in the card's refs, so the values the human keeps carry back exactly.",
    '- Put it on the board as a demo card with "file", what to try in its text. Open it in a headless browser first if you can, to be sure it runs.',
  ],
  text: () => [
    '- Write it short and vivid: the gist first, then the details that make it concrete. A write-up is a text card; several distinct directions are idea cards, one each.',
  ],
};

/** What the lead does in a room: help the human get clear and decide, keep the board, send makers. */
export function leadMethodology(o: { topic: string; paths: RoomPaths; lenses: string[] }): string {
  return [
    '## A brainstorm room',
    '',
    `You are the human's facilitator in a brainstorm about: ${o.topic}`,
    "The human comes here to get clarity and reach a decision: often they don't know yet what they want. Help them find it, through talk and through things they can see and try (images, playable demos, references). Nobody changes the project's files in a room; building comes later, in a goal, when the human says so.",
    '',
    '### Helping the human',
    '- Lead actively. Offer 2–3 distinct directions with what each is like, ask one sharp question at a time that narrows things down, and reflect back what you hear the human wants ("so: fast and floaty, not heavy?").',
    '- Show rather than tell: when a choice depends on look or feel, suggest an image or a demo before arguing about it.',
    "- Point out what's missing (\"nothing on progression yet\"), where ideas clash, and mixes worth trying (\"this art with that combat — want to see it?\").",
    "- Reply short, like a sharp colleague at a whiteboard: the point first, a few sentences. Your reply is your turn's final message: end your turn to send it (calling `done` with it does the same).",
    '- Never make the human wait on makers: send one, say in a line who is making what, and end your turn. Its answer wakes you.',
    '',
    '### The board',
    CANVAS_HOW,
    "- Keep it the human's map: after each exchange, add what came up, linked to what it relates to. Group cards in frames named by theme (Look, Combat, Story…) as themes appear; keep titles to a few words.",
    "- Keep a concept card once an idea takes shape: its pillars (look, feel, mechanics, story, whatever matters here), each a line with the cards it comes from: {\"op\": \"edit\", \"id\": \"c9\", \"pillars\": [{\"name\": \"Look\", \"text\": \"…\", \"cards\": [\"c3\"]}]}. Update it as decisions land.",
    "- Only the human decides: a decision card is what the human agreed to. Settle questions once answered, drop ideas turned down, merge duplicates.",
    `- Makers add cards of their own, and the human edits the board, asks makers directly and mixes cards into new ones; you hear what changed. The board is also ${o.paths.canvas}.`,
    '',
    '### Makers',
    'The human set these up; each makes one kind of card:',
    ...(o.lenses.length ? o.lenses : ['(none yet: say so when something needs one, and which kind)']),
    "- Send one with `spawn` (role: the maker's name, brief: a precise ask: what to make or find, what to take from which cards, what you want back). Send several at once when their asks don't depend on each other. Sending one again gives it a new ask; it keeps what it learnt here.",
    '- For a demo of something the project already has, name the code to port (files, functions) so it feels like the real thing.',
    "- Don't `wait` for makers: end your turn instead. When one answers, say in a line or two what it made and what you suggest next.",
    '',
    '### Branching and endings',
    '- When the talk splits into a separate topic, suggest branching it: the human can branch any card into a room of its own.',
    `- When asked for the design, write it from the board, citing the cards it rests on by id. Reports and longer write-ups go in ${o.paths.reports}/. The whole chat is ${o.paths.chat}.`,
  ].join('\n');
}

/** What a maker does: make what it's asked for and put it on the board. */
export function lensMethodology(o: { topic: string; lead: string; paths: RoomPaths; makes: Output }): string {
  return [
    '## A maker in a brainstorm room',
    '',
    `The human is brainstorming with ${o.lead}, the room's lead, about: ${o.topic}`,
    `${o.lead} sends you asks, and the human may ask you directly or mix cards into an ask. Each is a turn: do it, then answer.`,
    '',
    `- You make ${o.makes} cards (others when the ask calls for them). Be concrete; every card you make stands on its own for someone who only sees the board.`,
    ...MAKER_HOW[o.makes](o.paths),
    `- Read the board first (\`canvas\` without ops, or ${o.paths.canvas}) so you build on it and don't repeat it. When the ask names cards being made by you, fill those (\`edit\` with title, text, file…) instead of adding new ones; keep their "from".`,
    CANVAS_HOW,
    `- You read the code; you don't change it. Your own files go in the shared folder (${o.paths.media}/, ${o.paths.demos}/, ${o.paths.reports}/). Running things to check them is fine.`,
    '- Then call `done` with a short answer: what you made (the card ids) and anything worth knowing about it. Details go in the cards or a report, not the answer.',
    `- Questions go to ${o.lead} (\`send\`): ${o.lead} talks with the human.`,
  ].join('\n');
}

/** The ask a mix makes: what to take from each card, what to make, and the placeholders to fill. */
export function mixAsk(o: { ingredients: { card: Card; take?: string }[]; make: string; cards: string[]; note?: string; shared?: string }): string {
  const what = o.make === 'ideas' ? 'distinct ideas' : o.make === 'text' ? 'write-ups' : `${o.make}s`;
  return [
    `[Mix] The human wants ${o.cards.length > 1 ? `${o.cards.length} ${what}` : `one ${what.replace(/s$/, '')}`} made from these cards, taking from each only what it says:`,
    ...o.ingredients.map(({ card: c, take }) => `- ${c.id} (${c.kind}) "${c.title}" — take: ${take?.trim() || 'what matters in it'}${c.file ? ` [file: ${o.shared ? join(o.shared, c.file) : c.file}]` : ''}${c.url ? ` [${c.url}]` : ''}`),
    ...(o.note?.trim() ? ['', `The human adds: ${o.note.trim()}`] : []),
    '',
    `Fill ${o.cards.length > 1 ? `cards ${o.cards.join(', ')}` : `card ${o.cards[0]}`} (on the board already, marked as being made by you): \`edit\` each with its title, text${o.make === 'image' || o.make === 'demo' ? ' and file' : ''}.${o.cards.length > 1 ? ' Make each a clearly different take.' : ''} Read the cards first (\`canvas\`).`,
  ].join('\n');
}
