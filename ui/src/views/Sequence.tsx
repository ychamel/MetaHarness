import { useMemo, useState } from 'react';
import { clock, oneLine } from '../format.ts';
import type { Goal, MhEvent } from '../types.ts';

const LANE = 150;
const ROW = 34;
const LEFT = 70;
const TOP = 46;

/** Who knew what, and when: one lane per agent, messages and spawns as arrows, in order. */
export default function Sequence({ goal, events, onSelect }: { goal: Goal; events: MhEvent[]; onSelect: (n: string) => void }) {
  const [who, setWho] = useState('');
  const [helpers, setHelpers] = useState(false);

  const { lanes, rows } = useMemo(() => {
    const agents = goal.agents.filter(a => helpers || !a.quick);
    const lanes = ['human', ...agents.map(a => a.name)];
    const at = new Map(lanes.map((l, i) => [l, i]));
    const rows = events
      .filter(e => {
        if (e.type === 'message.sent') return at.has(e.agent ?? '') && at.has(String(e.data.to));
        if (e.type === 'agent.spawned') return at.has(e.agent ?? '') && at.has(e.parent ?? 'human');
        if (e.type === 'agent.done') return at.has(e.agent ?? '');
        return false;
      })
      .filter(e => !who || e.agent === who || e.data.to === who || e.parent === who)
      .map(e =>
        e.type === 'message.sent'
          ? { e, from: e.agent!, to: String(e.data.to), kind: 'msg' as const, text: String(e.data.text) }
          : e.type === 'agent.spawned'
            ? { e, from: e.parent ?? 'human', to: e.agent!, kind: 'spawn' as const, text: `spawned as ${e.data.role}` }
            : { e, from: e.agent!, to: e.agent!, kind: 'done' as const, text: String(e.data.note) },
      );
    return { lanes, rows: rows.map(r => ({ ...r, a: at.get(r.from)!, b: at.get(r.to)! })) };
  }, [goal, events, who, helpers]);

  // Room on the right for the last lane's done notes.
  const width = LEFT + lanes.length * LANE + 240;
  const height = TOP + rows.length * ROW + 30;
  const x = (i: number) => LEFT + i * LANE + LANE / 2;

  return (
    <>
      <div className="toolbar">
        <select value={who} onChange={e => setWho(e.target.value)} aria-label="Agent">
          <option value="">Everyone</option>
          {lanes.slice(1).map(l => (
            <option key={l} value={l}>
              Only {l}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={helpers} onChange={e => setHelpers(e.target.checked)} /> Quick helpers
        </label>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {rows.length} events
        </span>
      </div>
      <div className="scroll">
        <svg className="lanes" width={width} height={height} role="img" aria-label="Messages between agents over time">
          <defs>
            <marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
            </marker>
            <marker id="seq-arrow-you" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--you)" />
            </marker>
            <marker id="seq-arrow-spawn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--text-3)" />
            </marker>
          </defs>
          {lanes.map((l, i) => (
            <g key={l} className="head" style={{ cursor: l === 'human' ? 'default' : 'pointer' }} onClick={() => l !== 'human' && onSelect(l)}>
              <line className="lane" x1={x(i)} x2={x(i)} y1={TOP - 10} y2={height - 10} />
              <text x={x(i)} y={22} textAnchor="middle">
                {l === 'human' ? 'You' : l}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const y = TOP + i * ROW + ROW / 2;
            const you = r.from === 'human' || r.to === 'human';
            return (
              <g key={r.e.seq}>
                <title>{`${clock(r.e.ts)} ${r.from} → ${r.to}: ${r.text}`}</title>
                <text className="label" x={6} y={y + 4}>
                  {clock(r.e.ts).slice(0, 5)}
                </text>
                {r.kind === 'done' ? (
                  <>
                    <circle cx={x(r.a)} cy={y} r={5} fill="var(--done)" />
                    <text className="label" x={x(r.a) + 9} y={y + 4}>
                      done: {oneLine(r.text, 40)}
                    </text>
                  </>
                ) : (
                  <>
                    <line
                      className={r.kind === 'spawn' ? 'spawn' : `msg${you ? ' you' : ''}`}
                      x1={x(r.a) + (r.b > r.a ? 4 : -4)}
                      x2={x(r.b) + (r.b > r.a ? -6 : 6)}
                      y1={y}
                      y2={y}
                      markerEnd={`url(#${r.kind === 'spawn' ? 'seq-arrow-spawn' : you ? 'seq-arrow-you' : 'seq-arrow'})`}
                    />
                    <text className="label" x={(x(r.a) + x(r.b)) / 2} y={y - 5} textAnchor="middle">
                      {oneLine(r.text, Math.max(14, Math.round((Math.abs(r.b - r.a) * LANE) / 7)))}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
        {!rows.length && <div className="empty">No messages yet.</div>}
      </div>
    </>
  );
}
