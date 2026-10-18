import type { MhEvent } from './types.ts';

const oneLine = (v: unknown, max = 160) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};

/** One readable line per event, for `mh tail`. Returns '' for events not worth showing. */
export function eventLine(e: MhEvent): string {
  const t = e.ts.slice(11, 19);
  const who = (e.agent ?? '').padEnd(15);
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case 'goal.started':
      return `${t}  ${'goal'.padEnd(15)}started: ${oneLine(d.request)}`;
    case 'goal.ended':
      return `${t}  ${'goal'.padEnd(15)}ended: ${oneLine(d.reason)}`;
    case 'goal.recovered':
      return `${t}  ${'goal'.padEnd(15)}picked up after a daemon restart: ${d.resumed.length ? `${d.resumed.join(', ')} continue` : 'nobody was mid-task'}${d.later.length ? `; ${d.later.join(', ')} resume when messaged` : ''}`;
    case 'agent.spawned':
      return `${t}  ${who}spawned by ${e.parent} as ${d.role} (${d.harness} · ${d.model})${d.quick ? ', quick helper' : ''}`;
    case 'agent.state':
      return `${t}  ${who}is ${d.state}`;
    case 'agent.status':
      return `${t}  ${who}status: ${oneLine(d.text)}`;
    case 'agent.text':
      return `${t}  ${who}says: ${oneLine(d.text)}`;
    case 'agent.tool_call':
      return `${t}  ${who}→ ${d.tool} ${oneLine(d.summary, 100)}`;
    case 'message.sent':
      return `${t}  ${who}✉ to ${d.to}${d.urgent ? ' (urgent)' : ''}: ${oneLine(d.text)}`;
    case 'message.delivered':
      return `${t}  ${who}got the message from ${d.from} (${d.via})`;
    case 'agent.done':
      return `${t}  ${who}done: ${oneLine(d.note)}`;
    case 'agent.idle':
      return `${t}  ${who}stopped without calling done`;
    case 'agent.ended':
    case 'agent.crashed':
      return `${t}  ${who}${e.type.slice(6)}: ${oneLine(d.reason)}`;
    case 'git.commit':
      return `${t}  ${who}committed on ${d.branch}: ${oneLine(d.summary)}`;
    case 'git.merge':
      return `${t}  ${who}merged ${d.from} into ${d.into}${d.fastForward ? ' (fast-forward)' : ''}`;
    case 'git.conflict': {
      const files = (d.files as string[]).slice(0, 5).join(', ') + (d.files.length > 5 ? ` and ${d.files.length - 5} more` : '');
      return `${t}  ${who}⚠ ${d.op} conflict on ${d.branch}${d.from ? ` (with ${d.from})` : ''}: ${files}`;
    }
    case 'git.conflict_resolved':
      return `${t}  ${who}${d.op} on ${d.branch} ${d.how === 'committed' ? 'resolved and committed' : d.how === 'aborted' ? 'aborted' : 'finished'}`;
    case 'shared.write':
      return `${t}  ${(e.agent ?? '?').padEnd(15)}wrote shared/${d.path} (v${d.version})`;
    case 'shared.delete':
      return `${t}  ${(e.agent ?? '?').padEnd(15)}deleted shared/${d.path}`;
    case 'shared.clash':
      return `${t}  ${who}⚠ changed shared/${d.path}, which is ${d.owner}'s; the version before is in shared/${d.previous ?? '.history'}`;
    case 'goal.cleaned':
      return `${t}  ${'goal'.padEnd(15)}cleaned${d.force ? ' (forced)' : ''}: ${d.removed.length} worktree(s) removed, ${d.deleted.length} branch(es) deleted${d.kept.length ? `, ${d.kept.length} kept` : ''}`;
    case 'approval.refused':
      return `${t}  ${who}refused: ${oneLine(d.detail, 80)} (${oneLine(d.why, 80)})`;
    case 'approval.auto':
      return `${t}  ${who}ran without asking (read-only): ${oneLine(d.detail, 110)}`;
    case 'agent.moved':
      return `${t}  ${who}moved from ${d.from.harness} · ${d.from.model} to ${d.to.harness} · ${d.to.model}: ${oneLine(d.reason)}`;
    case 'agent.limited':
      return `${t}  ${who}rate limited on ${d.account}; continues at ${String(d.until).slice(11, 16)} UTC${d.known ? '' : ' (reset time unknown, will retry)'}`;
    case 'agent.interrupted':
      return `${t}  ${who}interrupted${d.how === 'restart' ? ' (session restarted from its ID)' : ''}`;
    case 'account.limit':
      return `${t}  ${'account'.padEnd(15)}${d.account}: ${d.status}${d.usedPct != null ? `, ${d.usedPct}% used` : ''}${d.resetsAt ? `, resets ${String(d.resetsAt).slice(11, 16)} UTC` : ''}`;
    case 'inbox.item':
      if (d.kind === 'decision') return `${t}  ${'→ you'.padEnd(15)}decision ${d.id} from ${e.agent}: ${oneLine(d.text, 300)} (mh approve ${d.id}, or mh deny ${d.id} "<what to change>")`;
      return d.kind === 'approval'
        ? `${t}  ${'→ you'.padEnd(15)}approval ${d.id} from ${e.agent}: ${oneLine(d.text, 400)} (mh status shows it in full)`
        : `${t}  ${'→ you'.padEnd(15)}${d.kind} from ${e.agent}: ${oneLine(d.text)}`;
    case 'usage':
    case 'agent.tool_result':
    case 'agent.session':
      return '';
    default:
      return `${t}  ${who}${e.type} ${oneLine(JSON.stringify(d), 120)}`;
  }
}
