import { useEffect, useMemo, useRef, useState } from 'react';
import { clock, STATE_LABEL } from '../format.ts';
import type { AgentState, Goal, MhEvent } from '../types.ts';

const ROW = 30;
const LEFT = 140;
const TOP = 30;
const COLOR: Partial<Record<AgentState, string>> = {
  starting: 'var(--working)', working: 'var(--working)', waiting: 'var(--waiting)', limited: 'var(--limited)',
  idle: 'var(--idle)', paused: 'var(--paused)', done: 'var(--done)', crashed: 'var(--crashed)',
};
const LEGEND: AgentState[] = ['working', 'waiting', 'idle', 'paused', 'limited', 'done', 'crashed'];

/** Working, waiting and idle over time, per agent: where the team waits on someone. */
export default function Timeline({ goal, events, onSelect }: { goal: Goal; events: MhEvent[]; onSelect: (n: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [, tick] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(500, e.contentRect.width)));
    if (box.current) ro.observe(box.current);
    const t = setInterval(() => tick(n => n + 1), 5000);
    return () => {
      ro.disconnect();
      clearInterval(t);
    };
  }, []);

  const { rows, start, end } = useMemo(() => {
    const start = events.length ? new Date(events[0].ts).getTime() : new Date(goal.createdAt).getTime();
    const end = goal.live && goal.status !== 'ended' ? Date.now() : events.length ? new Date(events.at(-1)!.ts).getTime() : start + 1;
    const rows = goal.agents.map(a => {
      const segs: { from: number; to: number; state: AgentState }[] = [];
      let cur: { from: number; state: AgentState } | undefined;
      for (const e of events) {
        if (e.agent !== a.name) continue;
        const t = new Date(e.ts).getTime();
        if (e.type === 'agent.spawned') cur = { from: t, state: 'starting' };
        else if (e.type === 'agent.state') {
          if (cur) segs.push({ ...cur, to: t });
          cur = { from: t, state: e.data.state as AgentState };
        }
      }
      if (cur && cur.state !== 'ended') segs.push({ ...cur, to: end });
      return { agent: a, segs };
    });
    return { rows, start, end: Math.max(end, start + 1000) };
  }, [goal, events]);

  const plot = width - LEFT - 16;
  const x = (t: number) => LEFT + ((t - start) / (end - start)) * plot;
  const height = TOP + rows.length * ROW + 10;
  // A tick every 10 s up to every 4 h, whichever gives about eight; seconds show while ticks are under a minute apart.
  const step = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].map(s => s * 1000).find(s => (end - start) / s <= 8) ?? 28_800_000;
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
  const tickLabel = (t: number) => (step < 60_000 ? clock(t) : clock(t).slice(0, 5));

  return (
    <>
      <div className="toolbar">
        <div className="legend">
          {LEGEND.map(s => (
            <span key={s}>
              <i style={{ background: COLOR[s] }} /> {STATE_LABEL[s]}
            </span>
          ))}
        </div>
      </div>
      <div className="scroll" ref={box}>
        <svg className="lanes" width={width} height={height} role="img" aria-label="Agent states over time">
          {ticks.map(t => (
            <g key={t}>
              <line className="tick" x1={x(t)} x2={x(t)} y1={TOP - 6} y2={height} />
              <text className="label" x={x(t)} y={16} textAnchor="middle">
                {tickLabel(t)}
              </text>
            </g>
          ))}
          {rows.map(({ agent, segs }, i) => {
            const y = TOP + i * ROW;
            return (
              <g key={agent.name} style={{ cursor: 'pointer' }} onClick={() => onSelect(agent.name)}>
                <text x={agent.quick ? 20 : 8} y={y + ROW / 2 + 4} opacity={agent.quick ? 0.75 : 1}>
                  {agent.name}
                </text>
                {segs.map((s, j) => (
                  <rect key={j} className="bar" x={x(s.from)} y={y + 6} width={Math.max(1.5, x(s.to) - x(s.from))} height={ROW - 12} fill={COLOR[s.state] ?? 'var(--idle)'} opacity={s.state === 'done' ? 0.45 : 0.9}>
                    <title>{`${agent.name}: ${STATE_LABEL[s.state]}, ${clock(s.from)} – ${clock(s.to)}`}</title>
                  </rect>
                ))}
              </g>
            );
          })}
          {goal.live && goal.status !== 'ended' && <line className="now" x1={x(end)} x2={x(end)} y1={TOP - 6} y2={height} />}
        </svg>
      </div>
    </>
  );
}
