import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { agentColors } from '../agentColors.ts';
import { ago } from '../format.ts';
import type { DiffView, Goal, GitView, MhEvent } from '../types.ts';
import { DiffFiles } from '../components/Diff.tsx';
import { Splitter } from '../components/Splitter.tsx';

/** What the diff pane shows. */
export type GitSel = { kind: 'commit'; sha: string } | { kind: 'whole' } | { kind: 'uncommitted'; agent: string } | { kind: 'range'; from: string; to: string; label: string };

interface Row {
  seq: number;
  ts: string;
  kind: 'commit' | 'merge' | 'conflict' | 'resolved';
  agent?: string;
  branch: string;
  sha?: string;
  text: string;
  added?: number;
  removed?: number;
  files?: number;
  map?: boolean;
}

/** The goal's commits, merges and conflicts, newest first, from the event log. */
export function gitRows(events: MhEvent[], mapFile = 'ARCHITECTURE.md'): Row[] {
  const rows: Row[] = [];
  // A merge commit is logged as a commit and as a merge: one row, saying what it merged.
  const merges = new Map(events.filter(e => e.type === 'git.merge' && !e.data.fastForward).map(e => [String(e.data.sha), e]));
  for (const e of events) {
    const d = e.data;
    if (e.type === 'git.commit' && merges.has(String(d.sha))) {
      const m = merges.get(String(d.sha))!.data;
      rows.push({ seq: e.seq, ts: e.ts, kind: 'merge', agent: e.agent, branch: String(d.branch), sha: String(d.sha), text: `merged ${m.from} into ${m.into}`, added: d.added as number, removed: d.removed as number, files: d.files as number });
    } else if (e.type === 'git.commit') {
      rows.push({ seq: e.seq, ts: e.ts, kind: 'commit', agent: e.agent, branch: String(d.branch), sha: String(d.sha), text: String(d.summary), added: d.added as number, removed: d.removed as number, files: d.files as number, map: (d.paths as string[] | undefined)?.includes(mapFile) });
    } else if (e.type === 'git.merge' && !d.fastForward) {
      if (events.some(c => c.type === 'git.commit' && c.data.sha === d.sha)) continue;
      rows.push({ seq: e.seq, ts: e.ts, kind: 'merge', agent: e.agent, branch: String(d.into), sha: String(d.sha), text: `merged ${d.from} into ${d.into}`, added: d.added as number, removed: d.removed as number, files: d.files as number });
    } else if (e.type === 'git.merge') {
      rows.push({ seq: e.seq, ts: e.ts, kind: 'merge', agent: e.agent, branch: String(d.into), text: `fast-forwarded ${d.into} to ${d.from}` });
    } else if (e.type === 'git.conflict') {
      rows.push({ seq: e.seq, ts: e.ts, kind: 'conflict', agent: e.agent, branch: String(d.branch), text: `${d.op} stopped on conflicts${d.from ? ` with ${d.from}` : ''}: ${(d.files as string[]).join(', ')}` });
    } else if (e.type === 'git.conflict_resolved') {
      rows.push({ seq: e.seq, ts: e.ts, kind: 'resolved', agent: e.agent, branch: String(d.branch), text: `${d.op} ${d.how}` });
    }
  }
  return rows.reverse();
}

export const shortBranch = (goal: string, b: string) => b.replace(`mh/${goal}/`, '');

export default function Git({ goal, events, sel, onSel, onSelectAgent }: { goal: Goal; events: MhEvent[]; sel?: GitSel; onSel: (s: GitSel) => void; onSelectAgent: (n: string) => void }) {
  const [view, setView] = useState<GitView>();
  const [diff, setDiff] = useState<DiffView>();
  const [error, setError] = useState<string>();
  const [branch, setBranch] = useState<string>();
  const color = useMemo(() => agentColors(goal), [goal]);
  const rows = useMemo(() => gitRows(events, view?.mapFile), [events, view?.mapFile]);
  const gitEvents = rows.length;
  const live = goal.live && goal.status !== 'ended';

  useEffect(() => {
    let alive = true;
    const load = () => api.git(goal.id).then(v => alive && setView(v), () => {});
    load();
    const t = live ? setInterval(load, 10_000) : undefined;
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [goal.id, gitEvents, live]);

  const current: GitSel = sel ?? (rows.find(r => r.sha) ? { kind: 'commit', sha: rows.find(r => r.sha)!.sha! } : { kind: 'whole' });
  const key = JSON.stringify(current);
  useEffect(() => {
    let alive = true;
    setDiff(undefined);
    setError(undefined);
    const q = current.kind === 'commit' ? { sha: current.sha } : current.kind === 'whole' ? { whole: true } : current.kind === 'uncommitted' ? { agent: current.agent } : { from: current.from, to: current.to };
    api.diff(goal.id, q).then(
      d => alive && setDiff(d),
      e => alive && setError((e as Error).message),
    );
    return () => {
      alive = false;
    };
    // The key stands for the selection; uncommitted work is read again as the log moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.id, key, current.kind === 'uncommitted' ? events.length : 0]);

  if (view && !view.git) return <div className="empty">{view.note}</div>;
  const g = view?.git;
  const shown = branch ? rows.filter(r => r.branch === branch) : rows;
  const isSel = (s: GitSel) => JSON.stringify(s) === key;
  return (
    <div className="git-view">
      <div className="git-side">
        {g && (
          <div className="git-head">
            <div>
              <span className="mono">{g.branch}</span>
              <span className="muted">
                {' '}
                · {g.commits} commit{g.commits === 1 ? '' : 's'} since the goal started
              </span>
            </div>
            <div className="row-wrap">
              <button className={`btn small${isSel({ kind: 'whole' }) ? ' on' : ''}`} onClick={() => onSel({ kind: 'whole' })} title="Everything the goal branch gained since the goal started: what a pull request would hold">
                Whole goal
              </button>
              <button
                className={`btn small${current.kind === 'uncommitted' && current.agent === goal.lead ? ' on' : ''}`}
                onClick={() => onSel({ kind: 'uncommitted', agent: goal.lead })}
                title="Changes in your checkout that nobody has committed: yours and the agents' alike"
              >
                Uncommitted here{g.uncommitted ? ` (${g.uncommitted})` : ''}
              </button>
            </div>
          </div>
        )}
        {!!view?.conflicts?.length && (
          <div className="notice-box warn">
            {view.conflicts.map(c => (
              <div key={c.dir}>
                ⚠ A {c.op} on {shortBranch(goal.id, c.branch)} is stopped on conflicts{c.agent ? ` (${c.agent})` : ''}.
              </div>
            ))}
          </div>
        )}
        {!!view?.branches?.length && (
          <>
            <div className="section-title">Branches</div>
            {view.branches.map(b => (
              <div key={b.name} className={`branch-row${branch === b.name ? ' on' : ''}`}>
                <button className="link-row" onClick={() => setBranch(branch === b.name ? undefined : b.name)} title={branch === b.name ? 'Show every branch' : 'Show only this branch'}>
                  <span className="swatch" style={{ background: color(b.agent) }} />
                  <span className="agent-name">{b.agent}</span>
                  <span className="mono muted ellipsis">{shortBranch(goal.id, b.name)}</span>
                </button>
                <span className="sub">
                  {b.tip ? (b.ahead ? `${b.ahead} not merged` : 'merged') : 'gone'}
                  {b.behind > 0 && ` · ${b.behind} behind`}
                  {b.uncommitted ? (
                    <>
                      {' · '}
                      <button className="text-link" onClick={() => onSel({ kind: 'uncommitted', agent: b.agent })}>
                        {b.uncommitted} uncommitted
                      </button>
                    </>
                  ) : null}
                  {b.tip && b.ahead > 0 && (
                    <>
                      {' · '}
                      <button className="text-link" onClick={() => onSel({ kind: 'range', from: b.base, to: b.tip!, label: `${b.agent}'s branch` })}>
                        its changes
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </>
        )}
        <div className="section-title">
          History{branch && <span className="muted normal"> · {shortBranch(goal.id, branch)}</span>}
        </div>
        <div className="scroll">
          {shown.map(r => (
            <button
              key={r.seq}
              className={`commit-row ${r.kind}${r.sha && current.kind === 'commit' && current.sha === r.sha ? ' on' : ''}`}
              disabled={!r.sha}
              onClick={() => r.sha && onSel({ kind: 'commit', sha: r.sha })}
            >
              <span className="swatch" style={{ background: r.agent ? color(r.agent) : 'transparent' }} />
              <span className="commit-text">
                <span className="ellipsis">
                  {r.kind === 'conflict' && '⚠ '}
                  {r.map && <span className="pill decision">map</span>} {r.text}
                </span>
                <span className="sub">
                  <span
                    className={r.agent ? 'agent-link' : ''}
                    onClick={ev => {
                      if (!r.agent) return;
                      ev.stopPropagation();
                      onSelectAgent(r.agent);
                    }}
                  >
                    {r.agent ?? 'unnamed (you?)'}
                  </span>
                  {' · '}
                  <span className="mono">{shortBranch(goal.id, r.branch)}</span>
                  {r.sha && <span className="mono"> · {r.sha.slice(0, 7)}</span>}
                  {' · '}
                  {ago(r.ts)}
                </span>
              </span>
              {r.added !== undefined && (
                <span className="commit-size">
                  <span className="diff-add">+{r.added}</span> <span className="diff-del">−{r.removed}</span>
                </span>
              )}
            </button>
          ))}
          {!shown.length && <div className="empty">No commits yet. Agents' commits show here as they're made.</div>}
        </div>
      </div>
      <Splitter pane="git" grow="right" min={240} max={700} label="Commit list" />
      <div className="git-diff">
        <div className="git-diff-head">
          <b>{current.kind === 'range' ? `Changes on ${current.label}` : diff?.title ?? '…'}</b>
          {diff?.shared && <div className="muted small">Uncommitted changes in your checkout could be anyone's: yours, or any agent working there.</div>}
        </div>
        <div className="scroll">{error ? <div className="empty warn-text">{error}</div> : diff ? <DiffFiles files={diff.files} /> : <div className="empty">Loading…</div>}</div>
      </div>
    </div>
  );
}
