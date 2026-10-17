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
    case 'inbox.item':
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
