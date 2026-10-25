import { addSplit, addTokens, tokensOf, type Tokens } from './costs.ts';
import type { CostSplit, Usage } from './adapters/types.ts';
import type { AgentState, MhEvent } from './types.ts';

/**
 * Rebuilding a goal from its event log after the daemon restarts (design §11: the log is the
 * source of truth). This file only folds events into plain data; the daemon turns that back
 * into live agents and resumes their native sessions.
 */

export interface PendingMessage {
  id: string;
  from: string;
  text: string;
  urgent: boolean;
  ts: string;
}

export interface AgentReplay {
  name: string;
  role: string;
  harness: string;
  model: string;
  effort?: string;
  parent: string;
  brief: string;
  quick: boolean;
  cwd: string;
  worktree?: { path: string; branch: string; base: string; deps?: string[] };
  startedFrom?: string;
  state: AgentState;
  status: string;
  lastText: string;
  doneNote?: string;
  /** The latest native session, which a restart resumes. */
  nativeSession?: string;
  cost?: number;
  costBefore?: number;
  costSource?: 'harness' | 'prices';
  tokens?: Tokens;
  tokensBefore?: Tokens;
  costSplit?: CostSplit;
  splitBefore?: CostSplit;
  /** When it last called its model (ms), from its last usage report. */
  lastCallAt?: number;
  cacheMinutes?: number;
  contextPct?: number;
  /** While rate limited: when it was due to continue, in ms since the epoch. */
  limitedUntil?: number;
  /** Messages sent to it that it never received. */
  undelivered: PendingMessage[];
}

export interface InboxReplay {
  id: string;
  agent: string;
  kind: string;
  text: string;
  ts: string;
  note?: string;
}

export interface GoalReplay {
  id: string;
  /** A discussion room: no lead, so it's over only once ended. */
  kind?: 'room';
  roomBranch?: string;
  /** What a room's coordinator has spent. */
  coordinatorCost: number;
  request: string;
  dir: string;
  sharedDir: string;
  createdAt: string;
  workflow?: string;
  branch?: string;
  base?: string;
  /** The goal ended (its lead couldn't start). */
  ended: boolean;
  lead: string;
  agents: Map<string, AgentReplay>;
  counters: Map<string, number>;
  /** Inbox items the human hasn't answered. */
  inbox: InboxReplay[];
  /** The last tip reported for each branch, and the branch each reported commit was seen on. */
  refs: Map<string, string>;
  seenOn: Map<string, string>;
  /** Conflicts reported and not yet resolved, by folder. */
  conflicts: Map<string, { op: 'merge' | 'cherry-pick' | 'revert' | 'rebase'; sha?: string; branch: string; agent?: string }>;
  /** Each shared file's latest version and owner (its first known writer). */
  shared: Map<string, { version: number; owner?: string }>;
  /** What the goal's gatekeeper has spent. */
  gatekeeperCost: number;
  /** Notes the human pinned on areas and hasn't removed, with who has had each. */
  notes: Map<string, { id: string; path: string; text: string; delivered: Set<string> }>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Folds one goal's events, oldest first. Undefined if the log doesn't start the goal. */
export function replayGoal(events: MhEvent[]): GoalReplay | undefined {
  const start = events.find(e => e.type === 'goal.started');
  if (!start) return undefined;
  const d = start.data;
  const g: GoalReplay = {
    id: start.goal, ...(d.kind === 'room' ? { kind: 'room' as const, roomBranch: str(d.roomBranch) || undefined } : {}), coordinatorCost: 0, request: str(d.request), dir: str(d.dir), sharedDir: str(d.sharedDir), createdAt: start.ts,
    workflow: str(d.workflow) || undefined, branch: str(d.branch) || undefined, base: str(d.base) || undefined,
    ended: false, lead: '', agents: new Map(), counters: new Map(), inbox: [], refs: new Map(), seenOn: new Map(),
    conflicts: new Map(), shared: new Map(), gatekeeperCost: 0, notes: new Map(),
  };
  if (g.branch && g.base) g.refs.set(g.branch, g.base);
  const pending = new Map<string, PendingMessage & { to: string }>();
  const sessions = new Map<string, number>();
  const sessionTokens = new Map<string, Tokens>();

  for (const e of events) {
    const a = e.agent ? g.agents.get(e.agent) : undefined;
    const x = e.data;
    switch (e.type) {
      case 'goal.ended':
        g.ended = true;
        break;
      case 'agent.spawned': {
        const role = str(x.role);
        g.counters.set(role, (g.counters.get(role) ?? 0) + 1);
        const deps = Array.isArray(x.deps) ? x.deps.map(String) : undefined;
        const wt = str(x.worktree) ? { path: str(x.worktree), branch: str(x.branch), base: str(x.base), ...(deps ? { deps } : {}) } : undefined;
        g.agents.set(e.agent!, {
          name: e.agent!, role, harness: str(x.harness), model: str(x.model), effort: str(x.effort) || undefined, parent: e.parent ?? 'human',
          brief: str(x.brief), quick: x.quick === true, cwd: str(x.cwd) || g.dir, worktree: wt,
          startedFrom: str(x.startedFrom) || undefined, state: 'starting', status: '', lastText: '', undelivered: [],
        });
        if (!g.lead && !g.kind && (e.parent ?? 'human') === 'human') g.lead = e.agent!;
        if (wt) g.refs.set(wt.branch, wt.base);
        break;
      }
      case 'agent.renamed':
        // A crashed lead's events were renamed in the log; its name, and the lead, passed to its replacement.
        if (g.lead === str(x.to)) g.lead = str(x.from);
        break;
      case 'agent.session':
        if (!a) break;
        // A later session starts its cost from zero (see the daemon's restart and move).
        if (sessions.has(a.name)) {
          a.costBefore = a.cost;
          a.tokensBefore = a.tokens;
          a.splitBefore = a.costSplit;
        }
        sessionTokens.delete(a.name);
        sessions.set(a.name, (sessions.get(a.name) ?? 0) + 1);
        a.nativeSession = str(x.nativeSession) || a.nativeSession;
        break;
      case 'agent.moved': {
        if (!a) break;
        const to = x.to as { harness?: string; model?: string; effort?: string } | undefined;
        a.harness = to?.harness ?? a.harness;
        a.model = to?.model ?? a.model;
        a.effort = to?.effort;
        // The new harness can't resume the old one's session.
        a.nativeSession = undefined;
        break;
      }
      case 'agent.state':
        if (a) a.state = x.state as AgentState;
        break;
      case 'agent.status':
        if (a) a.status = str(x.text);
        break;
      case 'agent.text':
        if (a) a.lastText = str(x.text);
        break;
      case 'agent.done':
        if (a) a.doneNote = str(x.note);
        break;
      case 'agent.limited':
        if (a) a.limitedUntil = Date.parse(str(x.until)) || undefined;
        break;
      case 'usage': {
        if (!a) break;
        const cost = typeof x.costUsd === 'number' ? x.costUsd : typeof x.estCostUsd === 'number' ? x.estCostUsd : undefined;
        if (cost !== undefined) {
          a.cost = (a.costBefore ?? 0) + cost;
          a.costSource = typeof x.costUsd === 'number' ? 'harness' : 'prices';
        }
        if (typeof x.contextPct === 'number') a.contextPct = x.contextPct;
        const session = tokensOf(x as Usage, sessionTokens.get(a.name));
        sessionTokens.set(a.name, session);
        a.tokens = addTokens(a.tokensBefore, session);
        if (x.costSplit) a.costSplit = addSplit(a.splitBefore, x.costSplit as CostSplit);
        if (typeof x.cacheMinutes === 'number') a.cacheMinutes = x.cacheMinutes;
        a.lastCallAt = Date.parse(e.ts) || a.lastCallAt;
        break;
      }
      case 'gatekeeper.usage':
        if (typeof x.total === 'number') g.gatekeeperCost = x.total;
        break;
      case 'coordinator.usage':
        if (typeof x.total === 'number') g.coordinatorCost = x.total;
        break;
      case 'message.sent':
        if (str(x.id) && str(x.to) && x.to !== 'human') {
          pending.set(str(x.id), { id: str(x.id), to: str(x.to), from: e.agent ?? 'human', text: str(x.text), urgent: x.urgent === true, ts: e.ts });
        }
        break;
      case 'message.delivered':
        pending.delete(str(x.id));
        break;
      case 'inbox.item':
        g.inbox.push({ id: str(x.id), agent: e.agent ?? '', kind: str(x.kind), text: str(x.text), ts: e.ts, ...(str(x.note) ? { note: str(x.note) } : {}) });
        break;
      case 'inbox.resolved':
        g.inbox = g.inbox.filter(i => i.id !== x.id);
        break;
      case 'git.commit':
        g.refs.set(str(x.branch), str(x.sha));
        g.seenOn.set(str(x.sha), str(x.branch));
        break;
      case 'git.merge':
        g.refs.set(str(x.into), str(x.sha));
        break;
      case 'git.conflict':
        g.conflicts.set(str(x.dir), { op: str(x.op) as 'merge', sha: str(x.sha) || undefined, branch: str(x.branch), agent: e.agent });
        break;
      case 'git.conflict_resolved':
        g.conflicts.delete(str(x.dir));
        break;
      case 'note.pinned':
        g.notes.set(str(x.id), { id: str(x.id), path: str(x.path), text: str(x.text), delivered: new Set() });
        break;
      case 'note.removed':
        g.notes.delete(str(x.id));
        break;
      case 'note.delivered':
        g.notes.get(str(x.id))?.delivered.add(e.agent ?? '');
        break;
      case 'shared.write': {
        const prev = g.shared.get(str(x.path));
        g.shared.set(str(x.path), { version: Number(x.version) || 1, owner: prev?.owner ?? (str(x.by) || undefined) });
        break;
      }
      // A deleted file keeps its version and owner, in case it's written again.
    }
  }
  for (const m of pending.values()) g.agents.get(m.to)?.undelivered.push(m);
  return g;
}

/** A goal is over once its lead has finished; there's nothing to resume after that. */
export function goalOver(g: GoalReplay): boolean {
  if (g.ended) return true;
  if (g.kind === 'room') return g.ended;
  const lead = g.agents.get(g.lead);
  return !lead || lead.doneNote !== undefined || ['done', 'ended', 'crashed'].includes(lead.state);
}

/** Agents that were in the middle of something when the daemon stopped. */
export const INTERRUPTED: AgentState[] = ['starting', 'working', 'waiting'];
