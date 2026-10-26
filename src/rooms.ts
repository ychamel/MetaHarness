import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFrontMatter } from './config.ts';
import type { Worktree } from './git.ts';
import type { Role } from './types.ts';

/**
 * Brainstorm rooms (design §21): the human talks with one lead agent, which keeps a canvas of
 * cards and links up to date and sends lenses (agents the human set up as available) to look
 * into things behind the scenes. A room is a goal underneath (the same agents, events, costs and
 * views). This file holds the plain parts: lenses and casts, the canvas, and what the lead and
 * the lenses are told.
 */

/** A lens the lead may send: a role (or just a model), what it's for in this room, and how it should look at things. */
export interface Lens {
  /** A role from the configuration; none: the lens is just a model (`on` is then required). */
  role?: string;
  /** Its name in the room; default the role's, or the model's. */
  name?: string;
  /** "harness/model" or "harness/model@effort", instead of the role's own. */
  on?: string;
  /** What it's for here: the lead picks lenses by it. Default: the role's usual one. */
  responsibility?: string;
  /** How it should look at the question, e.g. "argue for the simplest fix". */
  stance?: string;
  /** Put away by the human: the lead can't send it until it's back. */
  off?: boolean;
}

/** A saved set of lenses: casts/<name>.md. */
export interface Cast {
  name: string;
  goodAt: string;
  participants: Lens[];
  file: string;
}

/** Responsibilities to start from; a lens keeps its own text, edited or not. */
export const RESPONSIBILITIES: { name: string; text: string; roles: string[] }[] = [
  { name: 'Gather', roles: ['scout'], text: 'Gather information fast: where things are in the code, what changed and when, with file:line. Report what you found, not what to do about it.' },
  { name: 'Investigate', roles: ['explorer'], text: 'Investigate hard questions: reproduce a bug, trace a flow end to end, run the code or its tests to check. Report the cause, with the evidence.' },
  { name: 'Big picture', roles: ['designer', 'architect'], text: 'Explain the bigger picture: how the parts fit, what a change means for the design, the trade-offs, and where things should live.' },
  { name: 'Review', roles: ['reviewer'], text: 'Review a proposed direction or change: the risks, gaps and edge cases, and what would break. Say what you would change and why.' },
  { name: 'Ideas', roles: ['creative'], text: "Come up with ideas and options from what the canvas holds. Don't read the code yourself: work from the canvas and the reports." },
  { name: 'Patch', roles: ['implementer'], text: "Make a small agreed change when the lead gives you a patch job: tested, and committed on the room's branch." },
];

/** A lens's responsibility: its own, else its role's usual one, else none. */
export function responsibilityOf(p: Lens): string {
  if (p.responsibility?.trim()) return p.responsibility.trim();
  const role = p.role?.toLowerCase() ?? '';
  return RESPONSIBILITIES.find(r => r.roles.some(x => role === x || role.includes(x)))?.text ?? '';
}

/** A short label: the preset's name when the text is one, else its first words. */
export function responsibilityLabel(text: string): string {
  const preset = RESPONSIBILITIES.find(r => r.text === text);
  if (preset) return preset.name;
  const first = text.split(/[.:\n]/)[0].trim();
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}

/** A lens that's just a model: a role made from it, its instructions being the responsibility. */
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

/* ---------------- the canvas ---------------- */

/** question: still open to the room; idea: an option or approach; finding: a fact from the code; risk: what could go wrong; decision: what the human settled. */
export type CardKind = 'question' | 'idea' | 'finding' | 'risk' | 'decision';
export const CARD_KINDS: CardKind[] = ['question', 'idea', 'finding', 'risk', 'decision'];
const KIND_WORDS: Record<string, CardKind> = { option: 'idea', approach: 'idea', proposal: 'idea', fact: 'finding', evidence: 'finding', concern: 'risk', issue: 'risk', problem: 'risk', decided: 'decision' };

export interface Card {
  id: string;
  kind: CardKind;
  /** A few words: what the card says at a glance. */
  title: string;
  /** More, when the title isn't enough (markdown). */
  text?: string;
  /** Files (path or path:line) it rests on. */
  refs?: string[];
  /** open (default); settled: answered or done; dropped: an idea turned down, a finding that proved wrong. */
  status?: 'settled' | 'dropped';
  /** The human, the lead, a lens, or where it was carried over from. */
  by: string;
  /** What lenses (or the human) added to someone else's card. */
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

export interface Canvas {
  cards: Card[];
  links: CardLink[];
  seq: number;
}

export type CanvasOp =
  | { op: 'add'; kind: CardKind; title: string; text?: string; refs?: string[]; links?: { to: string; label?: string }[]; ref?: string }
  | { op: 'edit'; id: string; title?: string; text?: string; kind?: CardKind; refs?: string[] }
  | { op: 'settle' | 'drop' | 'reopen'; id: string }
  | { op: 'note'; id: string; text: string }
  | { op: 'link'; from: string; to: string; label?: string }
  | { op: 'unlink'; from: string; to: string }
  | { op: 'remove'; id: string };

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

/**
 * Applies changes to the canvas. A card added with `ref` can be linked to by that ref later in
 * the same call. Unknown ids, empty titles and repeats are skipped and said so.
 */
export function applyCanvas(c: Canvas, ops: CanvasOp[], by: string): CanvasResult {
  const out: CanvasResult = { changed: false, done: [], skipped: [] };
  const refs = new Map<string, string>();
  const idOf = (x: string) => {
    const k = String(x ?? '').trim().replace(/^#/, '');
    return refs.get(k) ?? c.cards.find(card => card.id.toLowerCase() === k.toLowerCase())?.id;
  };
  const link = (from: string, to: string, label?: string) => {
    if (from === to || c.links.some(l => l.from === from && l.to === to)) return false;
    c.links.push({ from, to, ...(label?.trim() ? { label: cut(label.trim(), 40) } : {}) });
    return true;
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
        out.skipped.push(`"${cut(title, 60)}" is already on the canvas as ${same.id}`);
        continue;
      }
      const card: Card = {
        id: `c${++c.seq}`, kind: op.kind, title: cut(title, 160), by,
        ...(op.text?.trim() ? { text: cut(op.text.trim(), 1500) } : {}), ...(op.refs?.length ? { refs: op.refs.map(r => r.trim()).filter(Boolean).slice(0, 8) } : {}),
      };
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
    const id = idOf(op.id);
    const card = id ? c.cards.find(x => x.id === id) : undefined;
    if (!card) {
      out.skipped.push(`there's no card ${op.id}`);
      continue;
    }
    if (op.op === 'edit') {
      if (op.title?.trim()) card.title = cut(op.title.trim(), 160);
      if (op.text !== undefined) {
        if (op.text.trim()) card.text = cut(op.text.trim(), 1500);
        else delete card.text;
      }
      if (op.kind && CARD_KINDS.includes(op.kind)) card.kind = op.kind;
      if (op.refs) card.refs = op.refs.map(r => r.trim()).filter(Boolean).slice(0, 8);
      out.done.push(`edited ${card.id}`);
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
      out.done.push(`removed ${card.id}`);
    } else continue;
    out.changed = true;
  }
  return out;
}

/** Canvas ops from whatever shape a model sends: `ops` (or `changes`) as a list or JSON, or one op at the top level. */
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
  const out: CanvasOp[] = [];
  for (const x of items) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const op = String(o.op ?? o.action ?? (o.title ? 'add' : '')).toLowerCase();
    const id = str(o.id ?? o.card) ?? '';
    if (op === 'add' || op === 'create') {
      const links = (Array.isArray(o.links) ? o.links : strs(o.links ?? o.link ?? o.to) ?? [])
        .map(l => (l && typeof l === 'object' ? { to: String((l as Record<string, unknown>).to ?? ''), label: str((l as Record<string, unknown>).label) } : { to: String(l) }))
        .filter(l => l.to);
      out.push({ op: 'add', kind: cardKind(o.kind ?? o.type) as CardKind, title: str(o.title ?? o.text) ?? '', ...(o.title && o.text ? { text: str(o.text) } : o.detail ? { text: str(o.detail) } : {}), ...(strs(o.refs ?? o.files) ? { refs: strs(o.refs ?? o.files) } : {}), ...(links.length ? { links } : {}), ...(o.ref ? { ref: str(o.ref) } : {}) });
    } else if (op === 'edit' || op === 'update') out.push({ op: 'edit', id, title: str(o.title), text: str(o.text ?? o.detail), kind: cardKind(o.kind ?? o.type), refs: strs(o.refs ?? o.files) });
    else if (['settle', 'drop', 'reopen', 'remove'].includes(op)) out.push({ op: op as 'settle' | 'drop' | 'reopen' | 'remove', id });
    else if (op === 'close' || op === 'resolve' || op === 'answer') out.push({ op: 'settle', id });
    else if (op === 'delete') out.push({ op: 'remove', id });
    else if (op === 'note' || op === 'comment') out.push({ op: 'note', id, text: str(o.text ?? o.note) ?? '' });
    else if (op === 'link' || op === 'unlink') out.push({ op, from: str(o.from) ?? id, to: str(o.to) ?? '', ...(op === 'link' && o.label ? { label: str(o.label) } : {}) } as CanvasOp);
  }
  return out;
}

const HEADINGS: Record<CardKind, string> = { question: 'Questions', idea: 'Ideas', finding: 'Findings', risk: 'Risks', decision: 'Decided' };

/** The canvas as the agents read it: cards by kind, with their ids, links and notes. */
export function canvasMarkdown(topic: string, c: Canvas): string {
  const parts = [`# Canvas: ${topic.split('\n')[0]}`];
  for (const k of CARD_KINDS) {
    const cards = c.cards.filter(x => x.kind === k);
    if (!cards.length) continue;
    const lines = cards.map(x => {
      const out = c.links.filter(l => l.from === x.id).map(l => `→ ${l.to}${l.label ? ` (${l.label})` : ''}`);
      return [
        `- [${x.id}] ${x.status ? `(${x.status}) ` : ''}${x.title}${out.length ? `  ${out.join(', ')}` : ''}  — ${x.by}`,
        ...(x.text ? [`  ${x.text.replace(/\n/g, '\n  ')}`] : []),
        ...(x.refs?.length ? [`  files: ${x.refs.join(', ')}`] : []),
        ...(x.notes ?? []).map(n => `  · ${n.by}: ${n.text}`),
      ].join('\n');
    });
    parts.push(`## ${HEADINGS[k]}\n\n${lines.join('\n')}`);
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

/** Cards carried into a new canvas under new ids, with the links between them. */
export function seedCanvas(c: Canvas, from: { cards: Card[]; links: CardLink[] }, by: string): void {
  const ids = new Map<string, string>();
  for (const x of from.cards) {
    const id = `c${++c.seq}`;
    ids.set(x.id, id);
    const { branches: _branches, ...rest } = x;
    c.cards.push({ ...rest, id, by: x.by === 'human' || x.by.startsWith('room ') || x.by.startsWith('goal ') ? x.by : by });
  }
  for (const l of from.links) if (ids.has(l.from) && ids.has(l.to)) c.links.push({ ...l, from: ids.get(l.from)!, to: ids.get(l.to)! });
}

/* ---------------- the room ---------------- */

export interface RoomState {
  topic: string;
  /** The lenses the human set up; the lead sends them. A lens's agent starts the first time it's sent. */
  lenses: Lens[];
  canvas: Canvas;
  /** The room's branch mh/<room>/room, shared by everyone in it. Unset without git. */
  worktree?: Worktree;
  /** Lenses on a patch job right now: they may change files. */
  writers: Set<string>;
}

/* ---------------- casts ---------------- */

/**
 * casts/<name>.md: one `## <role, or "model"> [as <name>]` heading per lens, then `on:`,
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

/* ---------------- what the lead and the lenses are told ---------------- */

export interface RoomPaths {
  canvas: string;
  chat: string;
  reports: string;
}

/** One line per lens: its name, what it is, what it's for, and whether it's started or put away. */
export function lensLines(lenses: Lens[], started: (name: string) => boolean): string[] {
  return lenses.map(p => {
    const what = p.role ?? modelWord(p.on) ?? 'model';
    const r = responsibilityOf(p);
    return `- ${p.name} (${what}${p.on ? ` on ${p.on}` : ''}): ${r || 'no responsibility given'}${p.stance ? ` Stance: ${p.stance}` : ''}${p.off ? ' [put away by the human: not available]' : started(p.name!) ? ' [started: it remembers what it did here]' : ''}`;
  });
}

export const CANVAS_HOW = [
  'The canvas is a board of cards with links, which the human watches instead of reading the chat back. Change it with the `canvas` tool: `ops` is a list of',
  '  {"op": "add", "kind": "question" | "idea" | "finding" | "risk" | "decision", "title": "a few words", "text": "optional detail", "refs": ["src/x.ts:40"], "links": [{"to": "c2", "label": "answers"}], "ref": "a"}',
  '  {"op": "edit", "id": "c3", "title": "…"}, {"op": "settle" | "drop" | "reopen" | "remove", "id": "c3"}, {"op": "note", "id": "c3", "text": "…"}, {"op": "link", "from": "c4", "to": "c2", "label": "rules out"}',
  '  (a card added with "ref" can be linked to by that ref later in the same call). `canvas` without ops shows the whole canvas.',
].join('\n');

/** What the lead does in a room: talk with the human, keep the canvas, send lenses. */
export function leadMethodology(o: { topic: string; paths: RoomPaths; lenses: string[]; branch?: string }): string {
  return [
    '## A brainstorm room',
    '',
    `You are the human's one point of contact in a brainstorm about: ${o.topic}`,
    'The aim is to explore: reach a design, understand a part of the code, or find small issues and fix them on the go. Bigger work becomes a goal later, when the human says so.',
    '',
    '### Talking',
    '- Reply fast and short, like a sharp colleague at a whiteboard: the answer first, then what it rests on, in a few sentences. Ask one question at a time when you need the human.',
    '- Your reply is your final message of the turn: end your turn to send it. Calling `done` with your reply as the note does the same.',
    '- Never make the human wait on lenses. When something needs looking into, send a lens, tell the human in one line who is looking at what, and end your turn. Its answer wakes you as a message.',
    "- When a lens's answer wakes you, put what matters on the canvas, then tell the human in a line or two what changed and what you suggest next.",
    '- You may read a file or two yourself for a quick check; anything bigger goes to a lens.',
    '',
    '### The canvas',
    CANVAS_HOW,
    '- Keeping it current is your main job besides talking. After each exchange, add what came up: questions, ideas, findings (with file:line refs), risks. Link cards that relate (an idea answers a question, a finding rules out an idea).',
    '- Only the human decides: a decision card is what the human agreed to. Settle questions once answered, drop ideas turned down, merge duplicates, and keep titles to a few words (detail goes in text).',
    `- Lenses add cards and notes of their own. The human edits it too; you hear what they changed. The canvas is also ${o.paths.canvas}.`,
    '',
    '### Lenses',
    'The human set these up for you to send:',
    ...(o.lenses.length ? o.lenses : ['(none yet: say so if a question needs one, and which kind)']),
    '- Send one with `spawn` (role: the lens\'s name, brief: a precise ask: what to find or judge, where to look, what you want back). Send several at once when their asks don\'t depend on each other. Sending one again gives it a new ask; it keeps what it learnt here.',
    `- For a small fix the human asked for, send a lens with \`patch: true\`: it may change files ${o.branch ? `on the room's branch ${o.branch}, ` : ''}and commits; the human merges at the end. You never change project files yourself.`,
    '- Don\'t `wait` for lenses: end your turn instead.',
    '',
    '### Branching',
    '- When the talk splits into a separate topic, suggest branching it: the human can branch any card into a room of its own.',
    `- Reports and longer write-ups go in ${o.paths.reports}/. The whole chat is ${o.paths.chat}.`,
  ].join('\n');
}

/** What a lens does: answer the lead's ask, put results on the canvas. */
export function lensMethodology(o: { topic: string; lead: string; paths: RoomPaths }): string {
  return [
    '## A lens in a brainstorm room',
    '',
    `The human is brainstorming with ${o.lead}, the room's lead, about: ${o.topic}`,
    `${o.lead} sends you asks. Each is a turn: do it, then answer.`,
    '',
    '- Stick to your responsibility. Be focused and concrete: name files, functions and lines.',
    `- Put what you establish on the canvas yourself with the \`canvas\` tool (findings, risks, ideas, with refs), linked to the cards it concerns; add a note to a card you have something to say about. Read the canvas first (\`canvas\` without ops, or ${o.paths.canvas}) so you don't repeat it.`,
    CANVAS_HOW,
    `- Then call \`done\` with a short answer for ${o.lead}: the answer first, what it rests on, and the cards you added. Details (analysis, logs, long lists) go in a report, ${o.paths.reports}/<your name>-<n>.md, named in your answer.`,
    `- You read the code; you don't change it, unless the ask is a patch job (it says so). Running the code or its tests to check something is fine.`,
    `- Questions go to ${o.lead} (\`send\`), never to the human or other lenses: ${o.lead} talks with the human.`,
  ].join('\n');
}

/** How a patch job reaches a lens. */
export function patchNote(o: { worktree?: string; branch?: string }): string {
  return `[Room] This is a patch job: you may change files for it. ${o.worktree ? `Work in ${o.worktree}, the room's branch ${o.branch}: run the relevant tests, commit with a clear message (\`git add <your files>\`), and answer with what you changed and how you checked it.` : 'Run the relevant tests, and answer with what you changed and how you checked it.'} Leave the docs the cartographer keeps to it: it brings them up to date once the human merges the room's branch. Your write access ends with your answer.`;
}
