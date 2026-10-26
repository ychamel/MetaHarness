import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFrontMatter } from './config.ts';
import type { Session, SessionEvents, Usage } from './adapters/types.ts';
import type { Worktree } from './git.ts';
import type { Role } from './types.ts';

/**
 * Discussion rooms (design §21): the human leads a few agents through a question about the code.
 * A room is a goal underneath (the same agents, events, costs and views) with no lead agent. Each
 * seat has a responsibility; everything said goes to the room's thread; the coordinator routes
 * what nobody was picked for and, after each answer, decides who goes next; fixes go on the
 * room's own branch, merged once at the end. This file holds the plain parts: seats and casts,
 * responsibilities, the board, what participants are told, and the coordinator session.
 */

/** One seat: a role (or just a model), what it's responsible for here, and how it should look at things. */
export interface Participant {
  /** A role from the configuration; none: the seat is just a model (`on` is then required). */
  role?: string;
  /** Its name in the room; default the role's, or the model's. */
  name?: string;
  /** "harness/model" or "harness/model@effort", instead of the role's own. */
  on?: string;
  /** What it's for in this room: the coordinator routes by it. Default: the role's usual one. */
  responsibility?: string;
  /** How it should look at the question, e.g. "argue for the simplest fix". */
  stance?: string;
  /** It may hand lookups to MetaHarness's scout (a quick helper), keeping its own turn for the thinking. */
  scout?: boolean;
  /** Out of the discussion for now: nobody routes to it, and its session rests until it's brought back. */
  benched?: boolean;
}

/** A saved set of seats: casts/<name>.md. */
export interface Cast {
  name: string;
  goodAt: string;
  participants: Participant[];
  file: string;
}

/** Responsibilities to start from; a seat keeps its own text, edited or not. */
export const RESPONSIBILITIES: { name: string; text: string; roles: string[] }[] = [
  { name: 'Gather', roles: ['scout'], text: 'Gather information fast: where things are in the code, what changed and when, with file:line. Report what you found, not what to do about it.' },
  { name: 'Investigate', roles: ['explorer'], text: 'Investigate hard questions: reproduce a bug, trace a flow end to end, run the code or its tests to check. Report the cause, with the evidence.' },
  { name: 'Big picture', roles: ['designer', 'architect'], text: 'Explain the bigger picture: how the parts fit, what a change means for the design, the trade-offs, and where things should live.' },
  { name: 'Review', roles: ['reviewer'], text: 'Review a proposed direction or change: the risks, gaps and edge cases, and what would break. Say what you would change and why.' },
  { name: 'Ideas', roles: ['creative'], text: "Come up with ideas and options from what the room has found. Don't read the code yourself: work from the thread, the board and the reports." },
  { name: 'Patch', roles: ['implementer'], text: 'Make the agreed change when given a patch job: small, tested, and committed on the room\'s branch.' },
];

/** A seat's responsibility: its own, else its role's usual one, else none. */
export function responsibilityOf(p: Participant): string {
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

/** A seat that's just a model: a role made from it, its instructions being the responsibility. */
export function modelRole(p: Participant): Role {
  const on = p.on ?? '';
  const at = on.lastIndexOf('@');
  const route = at > 0 ? on.slice(0, at) : on;
  const slash = route.indexOf('/');
  return {
    name: 'model', harness: slash > 0 ? route.slice(0, slash) : route, model: slash > 0 ? route.slice(slash + 1) : '', ...(at > 0 ? { effort: on.slice(at + 1).toLowerCase() } : {}),
    fallback: [], goodAt: responsibilityOf(p), instructions: '', helper: false, allow: [], autoApprove: 'read-only', mcp: [], worktree: false, file: '(room seat)',
  };
}

export type BoardKind = 'finding' | 'question' | 'decision' | 'file';
export const BOARD_KINDS: BoardKind[] = ['finding', 'question', 'decision', 'file'];

export interface BoardItem {
  id: string;
  kind: BoardKind;
  text: string;
  /** human, (coordinator), or where it was carried over from. */
  by: string;
  /** An open question that was answered. */
  closed?: boolean;
}

export type BoardOp =
  | { op: 'add'; kind: BoardKind; text: string }
  | { op: 'edit'; id: string; text: string }
  | { op: 'close'; id: string; closed?: boolean }
  | { op: 'remove'; id: string };

/**
 * How a message is asked. ask: a short answer; job: go and find out, then report; views: everyone
 * answers on their own, shown together; respond: answer one message of the thread; debate: rounds
 * where each sees the others' last answers; chain: one after another, each with the last answer;
 * patch: one participant changes the code on the room's branch.
 */
export type AskMode = 'ask' | 'job' | 'views' | 'respond' | 'debate' | 'chain' | 'patch';
export const ASK_MODES: AskMode[] = ['ask', 'job', 'views', 'respond', 'debate', 'chain', 'patch'];

/** A question in progress: who still owes an answer, and what follows. */
export interface Flow {
  id: string;
  mode: AskMode;
  text: string;
  /** Who asked: the human or the coordinator. */
  from: string;
  /** Everyone it's for, in order (a chain's order). */
  to: string[];
  round: number;
  rounds: number;
  waiting: Set<string>;
  /** This round's answers, by participant. */
  answers: Map<string, string>;
  /** Earlier rounds' answers, for a debate's next round. */
  earlier: Map<string, string>;
  /** Every answer's message id, for the coordinator's decision once the flow is through. */
  answerIds: string[];
  /** The message a respond answers, quoted to each. */
  quote?: { from: string; text: string };
  /** One part of a split question: its plan, which hears when it's through. */
  plan?: string;
}

/** A question the coordinator split into parts, one per seat; a part may wait for others' answers. */
export interface Plan {
  id: string;
  /** The human's message it splits. */
  msg: string;
  /** The whole question, which every part sees for context. */
  text: string;
  parts: { seat: string; ask: string; after: number[]; flow?: string; answers?: { from: string; text: string }[]; ids?: string[] }[];
}

export interface CoordinatorStatus {
  state: 'converging' | 'developing' | 'drifting';
  line: string;
  ending?: 'design' | 'patch' | 'goal';
}

/** What the coordinator is asked to do next: route a message nobody was picked for, or decide after answers. */
export type CoordinatorJob = { kind: 'route'; msg: string; text: string; mode: AskMode } | { kind: 'decide'; msgs: string[] };

export interface RoomState {
  topic: string;
  /** Open: participants message each other directly and the coordinator only watches. Moderated (default): the coordinator decides who goes next. */
  open: boolean;
  /** Everyone declared, started or not: a seat's session starts the first time it's addressed. */
  cast: Participant[];
  board: BoardItem[];
  boardSeq: number;
  flows: Map<string, Flow>;
  /** The room's branch mh/<room>/room, shared by every participant. Unset without git. */
  worktree?: Worktree;
  /** Participants with a patch job right now: they may change files. */
  writers: Set<string>;
  coordinator?: Coordinator;
  /** What the coordinator still has to do, in order; one at a time. */
  jobs: CoordinatorJob[];
  coordinating?: boolean;
  status?: CoordinatorStatus;
  /** Times the coordinator forwarded since the human last spoke: from 4 it hands back. */
  forwards: number;
  /** The log position each participant last spoke (or was asked) at: its digest starts after it. */
  lastSeen: Map<string, number>;
  /** Who asked each participant something directly (open discussion): they hear its answer. */
  askedBy?: Map<string, Set<string>>;
  /** Messages for participants still ending the turn they answered in: they go when it ends. */
  deferred?: { name: string; from: string; text: string }[];
  /** Split questions still being answered. */
  plans: Map<string, Plan>;
}

/* ---------------- seats and casts ---------------- */

/**
 * casts/<name>.md: one `## <role, or "model"> [as <name>]` heading per seat, then `on:`,
 * `responsibility:`, `stance:` and `scout: on` lines as needed.
 */
export function parseCast(file: string): Cast {
  const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'));
  const participants: Participant[] = [];
  let seat: Participant | undefined;
  for (const line of body.split('\n')) {
    const h = /^##\s+([\w.-]+)(?:\s+as\s+([\w.-]+))?\s*$/.exec(line);
    if (h) {
      seat = { ...(h[1] === 'model' ? {} : { role: h[1] }), ...(h[2] ? { name: h[2] } : {}) };
      participants.push(seat);
      continue;
    }
    const kv = /^(on|responsibility|stance|scout):\s*(.*\S)\s*$/.exec(line);
    if (seat && kv?.[1] === 'scout') seat.scout = /^(on|yes|true)$/i.test(kv[2]);
    else if (seat && kv) seat[kv[1] as 'on' | 'responsibility' | 'stance'] = kv[2];
  }
  return { name: basename(file, '.md'), goodAt: meta.good_at ?? '', participants: participants.filter(p => p.role || p.on), file };
}

export function castText(c: { goodAt?: string; participants: Participant[] }): string {
  const seats = c.participants.map(p =>
    [
      `## ${p.role || 'model'}${p.name ? ` as ${p.name}` : ''}`,
      ...(p.on ? [`on: ${p.on}`] : []),
      ...(p.responsibility ? [`responsibility: ${p.responsibility.replace(/\s+/g, ' ')}`] : []),
      ...(p.stance ? [`stance: ${p.stance.replace(/\s+/g, ' ')}`] : []),
      ...(p.scout ? ['scout: on'] : []),
    ].join('\n'),
  );
  return `---\ngood_at: ${(c.goodAt ?? '').replace(/\n/g, ' ')}\n---\n${seats.join('\n\n')}\n`;
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
function modelWord(on?: string): string | undefined {
  const model = on?.split('@')[0].split('/').pop();
  if (!model) return undefined;
  const words = model.split(/[-._]/).filter(w => w && !/^\d+$/.test(w) && !/^(gpt|claude|gemini|high|low|medium)$/i.test(w));
  return words.at(-1) ?? model;
}

/** Names safe for branches and @mentions. */
export function seatName(p: Participant, taken: Iterable<string>): string {
  const used = new Set([...taken].map(n => n.toLowerCase()));
  const clean = (s: string) => s.trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const model = modelWord(p.on);
  const role = p.role ? clean(p.role) : '';
  let name = clean(p.name ?? '') || (!role ? clean(model ?? 'model') : used.has(role.toLowerCase()) && model ? `${role}-${clean(model)}` : role);
  const base = name;
  for (let n = 2; used.has(name.toLowerCase()) || name === 'main' || name === 'room' || name === 'coordinator'; n++) name = `${base}-${n}`;
  return name;
}

/* ---------------- the board ---------------- */

const PREFIX: Record<BoardKind, string> = { finding: 'f', question: 'q', decision: 'd', file: 'p' };

/** Applies changes to the board. Unknown ids and empty text are skipped. */
export function applyBoard(st: Pick<RoomState, 'board' | 'boardSeq'>, ops: BoardOp[], by: string): boolean {
  let changed = false;
  for (const op of ops) {
    if (op.op === 'add') {
      const text = op.text?.trim();
      if (!text || !BOARD_KINDS.includes(op.kind)) continue;
      if (st.board.some(i => i.kind === op.kind && i.text.toLowerCase() === text.toLowerCase())) continue;
      st.board.push({ id: `${PREFIX[op.kind]}${++st.boardSeq}`, kind: op.kind, text: text.slice(0, 600), by });
      changed = true;
      continue;
    }
    const item = st.board.find(i => i.id === op.id);
    if (!item) continue;
    if (op.op === 'edit' && op.text?.trim()) item.text = op.text.trim().slice(0, 600);
    else if (op.op === 'close') item.closed = op.closed ?? true;
    else if (op.op === 'remove') st.board.splice(st.board.indexOf(item), 1);
    else continue;
    changed = true;
  }
  return changed;
}

const HEADINGS: Record<BoardKind, string> = { finding: 'Findings', question: 'Open questions', decision: 'Decided', file: 'Files' };

export function boardMarkdown(topic: string, board: BoardItem[]): string {
  const parts = [`# Board: ${topic.split('\n')[0]}`];
  for (const k of BOARD_KINDS) {
    const items = board.filter(i => i.kind === k);
    if (!items.length) continue;
    parts.push(`## ${HEADINGS[k]}\n\n${items.map(i => `- ${i.closed ? '~~' : ''}${i.text}${i.closed ? '~~ (answered)' : ''} [${i.id}]`).join('\n')}`);
  }
  if (parts.length === 1) parts.push('(empty so far)');
  return parts.join('\n\n') + '\n';
}

/* ---------------- what participants are told ---------------- */

export interface RoomPaths {
  board: string;
  transcript: string;
  reports: string;
}

/** One line per seat: its name, what it is, what it's responsible for, and whether it has started. */
export function rosterLines(cast: Participant[], started: (name: string) => boolean, you?: string): string[] {
  return cast.map(p => {
    const what = p.role ?? modelWord(p.on) ?? 'model';
    const r = responsibilityOf(p);
    return `- ${p.name} (${what}${r ? `: ${responsibilityLabel(r)}` : ''})${p.benched ? ', benched: out of the discussion for now' : started(p.name!) ? '' : ', not started yet'}${p.name === you ? '  ← you' : ''}`;
  });
}

/** The part of a participant's system prompt that replaces the team methodology. */
export function roomMethodology(o: { topic: string; open: boolean; paths: RoomPaths; roster: string[]; scout?: string }): string {
  const talk = o.open
    ? [
        '- Open discussion: you may `send` another participant a question or a point directly (by name); their answer comes back to you. Keep it to the point.',
        '- A coordinator watches, keeps the board and may steer the room back to the question.',
      ]
    : [
        '- You answer to the room, not to one person: everyone reads the thread. A coordinator reads every answer and decides who goes next: it may pass your answer to someone to check or build on, or hand it back to the human.',
        '- To suggest who should check or continue your work, end your answer with a line like `→ reviewer: does this hold for saved games?`. The coordinator weighs it.',
        "- Don't message other participants yourself: what you `send` them goes to the coordinator, which decides.",
      ];
  return [
    '## A discussion room',
    '',
    `The human leads a discussion with a few AI agents from different providers about: ${o.topic}`,
    '',
    'Who is in the room:',
    ...o.roster,
    '',
    '- Each message you get is a turn: answer it, then call `done` with your answer as the note. That is what the room sees. Without `done`, your last message is taken as your answer.',
    '- Stick to your responsibility. Be focused and concrete: name files, functions and lines.',
    `- Keep your answer simple and conversational: a few plain sentences, the answer first, then what it rests on. Details (analysis, lists of findings, code, logs) go in a report in the shared folder, ${o.paths.reports}/<your name>-<n>.md: name its path in your answer, and the human can open it from the thread.`,
    ...(o.scout ? [scoutLine(o.scout)] : []),
    "- You read the code; you don't change it, unless you're given a patch job (it says so). Running the code or its tests to check something is fine.",
    `- Each message ends with what's new in the room since you last spoke. The board (findings, open questions, decisions) is ${o.paths.board}, and the whole thread ${o.paths.transcript}: read them when you need more.`,
    ...talk,
    '- A question only the human can answer: `send` it to human; it goes to the thread.',
  ].join('\n');
}

/** What a seat with its scout on is told. */
export function scoutLine(role: string): string {
  return `- You have a scout for lookups: call \`spawn\` with role "${role}", quick: true, and a precise question (where something is, what calls what, what changed). It reads the code fast and answers inline; you do the thinking. Don't use it for what one file read answers.`;
}

/** How a message reaches a participant, by mode. */
export function frame(mode: AskMode, text: string, o: { round?: number; rounds?: number; quote?: { from: string; text: string }; earlier?: { from: string; text: string }[]; worktree?: string; branch?: string } = {}): string {
  const said = (xs: { from: string; text: string }[]) => xs.map(x => `--- ${x.from}:\n${x.text}`).join('\n\n');
  switch (mode) {
    case 'job':
      return `${text}\n\n[Room] This is a job: look into it with your tools, then answer simply, with the details in a report in the shared folder.`;
    case 'views':
      return `${text}\n\n[Room] Others are answering this too, each on their own: give your own view, without reading the thread first. You'll see theirs afterwards.`;
    case 'respond':
      return `${o.quote ? `${o.quote.from} said:\n${o.quote.text}\n\n` : ''}${text}\n\n[Room] Respond to that.`;
    case 'debate':
      if (!o.earlier?.length) return `${text}\n\n[Room] A debate of ${o.rounds} rounds: give your position. After each round you see the others' answers and respond.`;
      return `[Room] Round ${o.round} of ${o.rounds} on: ${text}\n\nWhat the others said last round:\n\n${said(o.earlier)}\n\nRespond: where you agree, where not and why, and what changed your view.${o.round === o.rounds ? ' This is the last round: end with your position.' : ''}`;
    case 'chain':
      if (!o.earlier?.length) return text;
      return `${text}\n\n[Room] This comes to you after others in a chain. What they answered:\n\n${said(o.earlier)}\n\nBuild on it.`;
    case 'patch':
      return [
        text,
        '',
        `[Room] This is a patch job: you may change files for it. ${o.worktree ? `Work in ${o.worktree}, the room's branch ${o.branch}: run the relevant tests, commit with a clear message (\`git add <your files>\`), and answer with what you changed and how you checked it.` : 'Run the relevant tests, and answer with what you changed and how you checked it.'} Leave ARCHITECTURE.md and the doc comments alone: the cartographer maps the result once the human merges the room's branch. Your write access ends with your answer.`,
      ].join('\n');
    default:
      return text;
  }
}

/** One part of a split question: its own ask, the whole question for context, and what the parts it waited for found. */
export function framePart(ask: string, whole: string, earlier: { from: string; text: string }[]): string {
  return [
    ask,
    '',
    `[Room] This is your part of a question the human asked the room; others answer the other parts, so answer only yours. The whole question, for context:\n"${whole.replace(/\s+/g, ' ').slice(0, 1500)}"`,
    ...(earlier.length ? ['', 'What the others found first:', '', earlier.map(x => `--- ${x.from}:\n${x.text}`).join('\n\n'), '', 'Build on it.'] : []),
  ].join('\n');
}

/* ---------------- the coordinator ---------------- */

export type NextAction = 'back' | 'forward' | 'compare' | 'note';

export interface CoordinatorReply {
  status?: CoordinatorStatus;
  board: BoardOp[];
  /** route: who handles the human's message, and how; or the parts it's split into. */
  route?: { to: string[]; mode: AskMode; line: string; parts?: { to: string; ask: string; after: string[] }[] };
  /** decide: what happens after the answers. */
  next?: { action: NextAction; to: string[]; text: string; line: string };
}

/** The first JSON object in the answer, read leniently. */
export function parseCoordinator(text: string): CoordinatorReply | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const states = ['converging', 'developing', 'drifting'];
  const endings = ['design', 'patch', 'goal'];
  const state = String(raw.status ?? '').toLowerCase();
  const ending = String(raw.ending ?? '').toLowerCase();
  const arr = (v: unknown) => (Array.isArray(v) ? (v.filter(x => x && typeof x === 'object') as Record<string, unknown>[]) : []);
  const names = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map(x => String(x).replace(/^@/, '').trim()).filter(Boolean);
  const board: BoardOp[] = [];
  for (const o of arr(raw.board)) {
    const op = String(o.op ?? 'add');
    const id = String(o.id ?? '');
    const text = typeof o.text === 'string' ? o.text : '';
    if (op === 'add' && BOARD_KINDS.includes(o.kind as BoardKind) && text) board.push({ op, kind: o.kind as BoardKind, text });
    else if (op === 'edit' && id && text) board.push({ op, id, text });
    else if (op === 'close' && id) board.push({ op, id });
    else if (op === 'remove' && id) board.push({ op, id });
  }
  const out: CoordinatorReply = { board };
  if (states.includes(state)) out.status = { state: state as CoordinatorStatus['state'], line: String(raw.line ?? '').slice(0, 300), ...(endings.includes(ending) ? { ending: ending as CoordinatorStatus['ending'] } : {}) };
  const r = raw.route && typeof raw.route === 'object' ? (raw.route as Record<string, unknown>) : undefined;
  const parts = arr(r?.parts)
    .map(p => ({ to: names(p.to)[0] ?? '', ask: String(p.ask ?? p.text ?? '').trim(), after: names(p.after) }))
    .filter(p => p.to && p.ask)
    .slice(0, 6);
  if (r && (names(r.to).length || parts.length)) {
    const mode = ['ask', 'job', 'views', 'chain'].includes(String(r.mode)) ? (String(r.mode) as AskMode) : 'ask';
    out.route = { to: parts.length ? [...new Set(parts.map(p => p.to))] : names(r.to).slice(0, 6), mode, line: String(r.line ?? '').slice(0, 300), ...(parts.length ? { parts } : {}) };
  }
  const n = raw.next && typeof raw.next === 'object' ? (raw.next as Record<string, unknown>) : undefined;
  const action = String(n?.action ?? '').toLowerCase();
  if (n && ['back', 'forward', 'compare', 'note'].includes(action)) {
    out.next = { action: action as NextAction, to: names(n.to).slice(0, 6), text: String(n.text ?? '').trim(), line: String(n.line ?? '').slice(0, 300) };
  }
  return out;
}

const BOARD_SCHEMA = `"board": [{"op": "add", "kind": "finding" | "question" | "decision" | "file", "text": "…"}, {"op": "close", "id": "q2"}, {"op": "edit", "id": "f1", "text": "…"}, {"op": "remove", "id": "f3"}]`;
const STATUS_SCHEMA = `"status": "converging" | "developing" | "drifting", "line": "one short line on why", "ending": null | "design" | "patch" | "goal"`;

export const ROUTE_ANSWER = `Pick who handles it, by their responsibilities.
- One question for one responsibility: send it whole, to one seat (or several when each brings something different).
- A question with parts that need different responsibilities (e.g. find the facts, then judge the design): split it. Give each part to the seat whose responsibility fits, with its own ask, written for that seat. Decide the order: parts that don't need each other run in parallel (no "after"); a part that needs others' results first names them in "after" and gets their answers. Don't split what one seat can answer well.
Answer with one JSON object and nothing else, either
{"route": {"to": ["<seat>", …], "mode": "ask" | "job" | "views" | "chain", "line": "one short line the human sees"}, …}
or, split,
{"route": {"parts": [{"to": "<seat>", "ask": "its part"}, {"to": "<seat>", "ask": "its part", "after": ["<seat whose part it needs>"]}], "mode": "ask" | "job", "line": "one short line the human sees, e.g. scout finds what changed while reviewer checks the tests; then designer judges it"}, …}
with, in both,
 ${STATUS_SCHEMA},
 ${BOARD_SCHEMA}`;

export const DECIDE_ANSWER = (open: boolean, handBack: boolean) =>
  open
    ? `This is an open discussion: you only watch. Answer with one JSON object and nothing else:
{${STATUS_SCHEMA},
 ${BOARD_SCHEMA},
 "next": {"action": "note"} or, only when it drifts, {"action": "forward", "to": ["<seat>"], "text": "what to bring them back to", "line": "…"}}`
    : `Decide what happens next${handBack ? ' (you have passed things on 4 times since the human last spoke: hand back now, with a summary)' : ''}. One of:
- "back": the question is answered, only the human can decide, or nothing new is coming: hand back with a short summary for the human.
- "forward": an answer should be checked or built on by someone else (weigh any "→ name" line at its end): say what to ask them, quoting what matters.
- "compare": answers disagree in a way worth settling: ask the seats involved to respond to each other's point.
- "note": the facts go to the board; nobody else needs to act, and the human hasn't asked anything new.
Answer with one JSON object and nothing else:
{"next": {"action": "back" | "forward" | "compare" | "note", "to": ["<seat>", …], "text": "the message for them (forward, compare) or the summary for the human (back)", "line": "one short line the human sees"},
 ${STATUS_SCHEMA},
 ${BOARD_SCHEMA}}`;

export interface CoordinatorHost {
  start(brief: string, events: SessionEvents): Promise<Session>;
  usage(u: Usage, session: number): void;
  log(type: string, data: Record<string, unknown>): void;
}

/**
 * The room's coordinator: a side session of the coordinator role, like the gatekeeper, reused
 * from decision to decision. One question at a time; an answer that doesn't come in time is
 * dropped, and the next question starts a fresh session.
 */
export class Coordinator {
  private session?: Session;
  private gen = 0;
  private lastText = '';
  private contextPct = 0;
  private pending?: { resolve: (t: string | undefined) => void; timer: NodeJS.Timeout };
  private stopped = false;
  private host: CoordinatorHost;
  private timeoutMs: number;

  constructor(host: CoordinatorHost, timeoutMs = 180_000) {
    this.host = host;
    this.timeoutMs = timeoutMs;
  }

  /** The text of its answer, or undefined if none came. */
  async ask(prompt: string): Promise<string | undefined> {
    if (this.stopped || this.pending) return undefined;
    if (this.session && this.contextPct >= 60) this.retire();
    const answer = new Promise<string | undefined>(resolve => {
      this.pending = { resolve, timer: setTimeout(() => this.finish(undefined, true), this.timeoutMs) };
    });
    this.lastText = '';
    if (this.session) void this.session.send(prompt, 'new_turn');
    else {
      const gen = ++this.gen;
      this.contextPct = 0;
      try {
        const s = await this.host.start(prompt, this.events(gen));
        if (gen !== this.gen || this.stopped) void s.stop().catch(() => {});
        else this.session = s;
      } catch (e) {
        this.host.log('coordinator.failed', { reason: (e as Error).message });
        this.finish(undefined);
      }
    }
    return answer;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.finish(undefined);
    const s = this.session;
    this.session = undefined;
    await s?.stop().catch(() => {});
  }

  private retire(): void {
    const s = this.session;
    this.session = undefined;
    this.gen++;
    void s?.stop().catch(() => {});
  }

  private finish(text: string | undefined, timedOut = false): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = undefined;
    if (timedOut) {
      this.host.log('coordinator.failed', { reason: `no answer within ${Math.round(this.timeoutMs / 1000)}s` });
      this.retire();
    }
    p.resolve(text);
  }

  private events(gen: number): SessionEvents {
    const live = () => gen === this.gen;
    return {
      turnStarted: () => {},
      turnEnded: () => live() && this.finish(this.lastText),
      text: t => {
        if (live()) this.lastText = t;
      },
      toolCall: () => {},
      toolResult: () => {},
      usage: u => {
        if (u.contextPct !== undefined && live()) this.contextPct = u.contextPct;
        this.host.usage(u, gen);
      },
      exited: (_r, detail) => {
        if (!live()) return;
        this.session = undefined;
        this.gen++;
        if (this.pending) this.host.log('coordinator.failed', { reason: `its session ended${detail ? ` (${detail.slice(0, 200)})` : ''}` });
        this.finish(undefined);
      },
      rateLimit: info => {
        if (live() && info.status === 'limited') this.finish(undefined);
      },
      approval: async () => ({ allow: false, message: 'The coordinator only reads. Answer with the JSON object.' }),
      decide: async t => (t.kind === 'read' ? { allow: true } : { allow: false, message: 'The coordinator only reads. Answer with the JSON object.' }),
      pull: () => undefined,
    };
  }
}
