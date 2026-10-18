import type { AgentState, MhEvent } from './types.ts';

export const money = (v: number | null | undefined) => (v == null ? '—' : v < 0.01 && v > 0 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`);

export function clock(ts: string | number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

/** MetaHarness's own tools: their calls already show as status lines, messages and done notes. */
export const OWN_TOOLS = new Set(['team', 'spawn', 'send', 'wait', 'status', 'done', 'workflow']);
export const isOwnTool = (e: MhEvent) => e.type === 'agent.tool_call' && OWN_TOOLS.has(String(e.data.tool).replace(/^mcp__metaharness__/, ''));

export function ago(ts: string | number): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export const oneLine = (v: unknown, max = 160) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};

/** Agents that are doing something now. */
export const BUSY: AgentState[] = ['starting', 'working', 'waiting', 'limited'];

export const STATE_LABEL: Record<AgentState, string> = {
  starting: 'starting', working: 'working', waiting: 'waiting', limited: 'rate limited', idle: 'idle',
  done: 'done', ended: 'ended', crashed: 'crashed', paused: 'paused',
};

/** One readable line for the activity feed, or '' for events not worth a line. */
export function eventText(e: MhEvent): string {
  const d = e.data;
  switch (e.type) {
    case 'goal.started': return `Goal started: ${oneLine(d.request, 300)}`;
    case 'goal.ended': return `Goal ended: ${oneLine(d.reason)}`;
    case 'goal.paused': return 'Goal paused';
    case 'goal.resumed': return 'Goal resumed';
    case 'goal.recovered': return `Picked up after a daemon restart${d.resumed?.length ? `: ${d.resumed.join(', ')} continue` : ''}`;
    case 'goal.cleaned': return `Cleaned up: ${d.removed.length} worktree(s) removed, ${d.deleted.length} branch(es) deleted${d.kept.length ? `, ${d.kept.length} kept` : ''}`;
    case 'agent.spawned': return `Spawned by ${e.parent === 'human' ? 'you' : e.parent} as ${d.role} (${d.harness} · ${d.model})${d.quick ? ', quick helper' : ''}${d.branch ? ` on ${d.branch}` : ''}`;
    case 'agent.state': return `is ${STATE_LABEL[d.state as AgentState] ?? d.state}`;
    case 'agent.status': return `status: ${oneLine(d.text)}`;
    case 'agent.text': return oneLine(d.text, 400);
    case 'agent.tool_call': return `→ ${d.tool} ${oneLine(d.summary, 140)}`;
    case 'message.sent': return `✉ to ${d.to === 'human' ? 'you' : d.to}${d.urgent ? ' (urgent)' : ''}: ${oneLine(d.text, 300)}`;
    case 'agent.done': return `done: ${oneLine(d.note, 400)}`;
    case 'agent.idle': return 'stopped without calling done';
    case 'agent.ended': case 'agent.crashed': return `${e.type.slice(6)}: ${oneLine(d.reason)}`;
    case 'agent.paused': return `paused by ${d.by === 'human' ? 'you' : d.by}`;
    case 'agent.resumed': return `resumed by ${d.by === 'human' ? 'you' : d.by}`;
    case 'agent.paused_between_steps': return `turn paused between steps${d.cut ? ' (a command ran too long and was cut)' : ''}`;
    case 'agent.moved': return `moved to ${d.to.harness} · ${d.to.model}: ${oneLine(d.reason)}`;
    case 'agent.limited': return `rate limited on ${d.account} until ${clock(d.until)}`;
    case 'agent.interrupted': return `interrupted${d.how === 'restart' ? ' (session restarted)' : ''}`;
    case 'git.commit': return `committed on ${d.branch}: ${oneLine(d.summary)}`;
    case 'git.merge': return `merged ${d.from} into ${d.into}${d.fastForward ? ' (fast-forward)' : ''}`;
    case 'git.conflict': return `⚠ ${d.op} conflict on ${d.branch}${d.from ? ` with ${d.from}` : ''}: ${(d.files as string[]).join(', ')}`;
    case 'git.conflict_resolved': return `${d.op} on ${d.branch} ${d.how}`;
    case 'shared.write': return `wrote shared/${d.path} (v${d.version})`;
    case 'shared.delete': return `deleted shared/${d.path}`;
    case 'shared.clash': return `⚠ changed shared/${d.path}, which is ${d.owner}'s`;
    case 'approval.auto': return `ran without asking (read-only): ${oneLine(d.detail, 140)}`;
    case 'approval.refused': return `refused: ${oneLine(d.detail, 100)} — ${oneLine(d.why, 160)}`;
    case 'inbox.item': return `→ you (${d.kind}): ${oneLine(d.text, 300)}`;
    case 'inbox.resolved': return `you ${d.decision === 'approve' ? 'approved' : d.decision === 'deny' ? 'denied' : 'dismissed'} ${d.id}${d.reply ? `: ${oneLine(d.reply)}` : ''}`;
    case 'account.limit': return `${d.account}: ${d.status}${d.usedPct != null ? `, ${d.usedPct}% used` : ''}`;
    default: return '';
  }
}

/** Kinds of feed line, for styling and filtering. */
export function eventKind(e: MhEvent): 'say' | 'tool' | 'message' | 'git' | 'shared' | 'you' | 'life' | 'warn' {
  if (e.type === 'agent.text' || e.type === 'agent.done') return 'say';
  if (e.type === 'agent.tool_call' || e.type.startsWith('approval.')) return 'tool';
  if (e.type === 'message.sent') return 'message';
  if (e.type.startsWith('git.')) return e.type === 'git.conflict' ? 'warn' : 'git';
  if (e.type.startsWith('shared.')) return e.type === 'shared.clash' ? 'warn' : 'shared';
  if (e.type.startsWith('inbox.')) return 'you';
  if (e.type === 'agent.crashed' || e.type === 'agent.limited') return 'warn';
  return 'life';
}
