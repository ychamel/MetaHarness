import { useMemo, useState } from 'react';
import { money } from '../format.ts';
import type { Agent, CostSplit, Goal, Tokens } from '../types.ts';

type Kind = keyof CostSplit;
const KINDS: { kind: Kind; tokens: keyof Tokens; label: string; color: string }[] = [
  { kind: 'input', tokens: 'tokensIn', label: 'Input', color: 'var(--series-1)' },
  { kind: 'output', tokens: 'tokensOut', label: 'Output', color: 'var(--series-2)' },
  { kind: 'cacheRead', tokens: 'cacheRead', label: 'Cache reads', color: 'var(--series-3)' },
  { kind: 'cacheWrite', tokens: 'cacheWrite', label: 'Cache writes', color: 'var(--series-4)' },
];
type By = 'agent' | 'role' | 'model';
type Metric = 'cost' | 'tokens';

interface Row {
  key: string;
  label: string;
  sub: string;
  agents: string[];
  cost: number | null;
  split: CostSplit | null;
  tokens: Tokens | null;
  sources: Set<string>;
}

const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const addT = (a: Tokens | null, b: Tokens | null): Tokens | null => (!a ? b : !b ? a : { tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });
const addS = (a: CostSplit | null, b: CostSplit | null): CostSplit | null => (!a ? b : !b ? a : { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

function group(agents: Agent[], by: By): Row[] {
  const rows = new Map<string, Row>();
  for (const a of agents) {
    const key = by === 'agent' ? a.name : by === 'role' ? a.role : `${a.harness}/${a.model}`;
    const r = rows.get(key) ?? { key, label: key, sub: by === 'agent' ? `${a.role} · ${a.harness} · ${a.model}` : '', agents: [], cost: null, split: null, tokens: null, sources: new Set() };
    r.agents.push(a.name);
    if (a.cost != null) r.cost = (r.cost ?? 0) + a.cost;
    r.split = addS(r.split, a.costSplit);
    r.tokens = addT(r.tokens, a.tokens);
    r.sources.add(a.costSource ?? 'none');
    rows.set(key, r);
  }
  for (const r of rows.values()) if (by !== 'agent') r.sub = `${r.agents.length} agent${r.agents.length > 1 ? 's' : ''}`;
  return [...rows.values()];
}

/** Where a goal's money went: by agent, role or model, and by kind of token. */
export default function Costs({ goal, onSelect, onSetup }: { goal: Goal; onSelect: (n: string) => void; onSetup: () => void }) {
  const [by, setBy] = useState<By>('agent');
  const [metric, setMetric] = useState<Metric>('cost');
  const [tip, setTip] = useState<{ x: number; y: number; text: string }>();

  const rows = useMemo(() => {
    const rs = group(goal.agents, by);
    if (goal.gatekeeperCost) rs.push({ key: '(gatekeeper)', label: 'gatekeeper', sub: 'approvals', agents: [], cost: goal.gatekeeperCost, split: null, tokens: null, sources: new Set(['harness']) });
    return rs.sort((a, b) => (metric === 'cost' ? (b.cost ?? -1) - (a.cost ?? -1) : total(b.tokens) - total(a.tokens)));
  }, [goal, by, metric]);

  const all = goal.agents.reduce<{ split: CostSplit | null; tokens: Tokens | null }>((acc, a) => ({ split: addS(acc.split, a.costSplit), tokens: addT(acc.tokens, a.tokens) }), { split: null, tokens: null });
  const input = all.tokens ? all.tokens.tokensIn + all.tokens.cacheRead + all.tokens.cacheWrite : 0;
  const unpriced = [...new Set(goal.agents.filter(a => a.cost == null && a.tokens).map(a => `${a.harness}/${a.model}`))];
  const max = Math.max(1e-9, ...rows.map(r => (metric === 'cost' ? (r.cost ?? 0) : total(r.tokens))));

  return (
    <div className="scroll">
      <div className="costs">
      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Spent</div>
          <div className="tile-value">{money(goal.cost)}</div>
          <div className="muted small">{goal.agents.some(a => a.costSource === 'prices') ? 'partly estimated from your prices' : 'as the harnesses report it'}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Input from the cache</div>
          <div className="tile-value">{input ? `${Math.round((100 * all.tokens!.cacheRead) / input)}%` : '—'}</div>
          <div className="muted small">{all.tokens ? `${count(all.tokens.cacheRead)} of ${count(input)} input tokens` : 'no token counts yet'}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Writing the cache</div>
          <div className="tile-value">{all.split ? money(all.split.cacheWrite) : '—'}</div>
          <div className="muted small">{all.split && goal.cost ? `${Math.round((100 * all.split.cacheWrite) / goal.cost)}% of the spend` : 'paid again when a cache expires'}</div>
        </div>
      </div>

      {unpriced.length > 0 && (
        <div className="notice-box">
          No price for {unpriced.join(', ')}, so {unpriced.length > 1 ? 'their' : 'its'} tokens aren't counted in dollars.{' '}
          <button className="link" onClick={onSetup}>
            Set prices in Harnesses
          </button>
        </div>
      )}

      <div className="toolbar flat">
        <div className="seg" role="group" aria-label="Group by">
          {(['agent', 'role', 'model'] as By[]).map(b => (
            <button key={b} className={by === b ? 'on' : ''} onClick={() => setBy(b)}>
              By {b}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Measure">
          <button className={metric === 'cost' ? 'on' : ''} onClick={() => setMetric('cost')}>
            Dollars
          </button>
          <button className={metric === 'tokens' ? 'on' : ''} onClick={() => setMetric('tokens')}>
            Tokens
          </button>
        </div>
        <div className="legend">
          {KINDS.map(k => (
            <span key={k.kind}>
              <i style={{ background: k.color }} /> {k.label}
            </span>
          ))}
        </div>
      </div>

      <table className="cost-table">
        <thead>
          <tr>
            <th>{by === 'agent' ? 'Agent' : by === 'role' ? 'Role' : 'Model'}</th>
            <th className="bar-col">{metric === 'cost' ? 'Dollars by kind of token' : 'Tokens by kind'}</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const value = metric === 'cost' ? (r.cost ?? 0) : total(r.tokens);
            const parts = KINDS.map(k => ({ ...k, v: metric === 'cost' ? (r.split?.[k.kind] ?? 0) : (r.tokens?.[k.tokens] ?? 0), t: r.tokens?.[k.tokens] ?? 0, d: r.split?.[k.kind] }));
            const splitSum = parts.reduce((s, p) => s + p.v, 0);
            return (
              <tr key={r.key} className={by === 'agent' && r.agents.length ? 'clickable' : ''} onClick={() => by === 'agent' && r.agents[0] && onSelect(r.agents[0])}>
                <td>
                  <div className="name">{r.label}</div>
                  <div className="muted small ellipsis">{r.sub}</div>
                </td>
                <td className="bar-col">
                  <div className="stack" style={{ width: `${(100 * value) / max}%` }} onMouseLeave={() => setTip(undefined)}>
                    {splitSum > 0
                      ? parts
                          .filter(p => p.v > 0)
                          .map(p => (
                            <span
                              key={p.kind}
                              style={{ flexGrow: p.v, background: p.color }}
                              onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${r.label} · ${p.label}: ${count(p.t)} tokens${p.d != null ? ` · ${money(p.d)}` : ''}` })}
                            />
                          ))
                      : value > 0 && <span className="unsplit" style={{ flexGrow: 1 }} onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${r.label}: ${money(r.cost)} (not split by kind)` })} />}
                  </div>
                  <div className="muted small token-line">
                    {r.tokens
                      ? KINDS.filter(k => r.tokens![k.tokens] > 0)
                          .map(k => `${count(r.tokens![k.tokens])} ${k.label.toLowerCase()}`)
                          .join(' · ')
                      : 'no token counts'}
                  </div>
                </td>
                <td className="num" title={r.sources.has('prices') ? 'Estimated from your prices' : undefined}>
                  {money(r.cost)}
                  {r.sources.has('prices') ? '*' : ''}
                </td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={3} className="empty">
                Nothing spent yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted small">
        * estimated from the prices in Harnesses. Claude Code reports each model's cost; its split by kind of token follows Anthropic's price ratios. Codex, Antigravity and
        ACP harnesses report tokens only.
      </p>
      {tip && (
        <div className="viz-tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
          {tip.text}
        </div>
      )}
      </div>
    </div>
  );
}

const total = (t: Tokens | null) => (t ? t.tokensIn + t.tokensOut + t.cacheRead + t.cacheWrite : 0);
