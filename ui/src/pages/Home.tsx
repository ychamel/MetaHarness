import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { ago, clock, duration, firstLine, money } from '../format.ts';
import type { ConfigView, GoalSummary, Snapshot } from '../types.ts';
import { ACTIONABLE, NeedsYou } from '../components/Inbox.tsx';
import { NewGoalForm } from '../components/Dialogs.tsx';
import { Markdown, More } from '../components/common.tsx';

/** Everything loaded on the daemon (all goals' Inbox items and the accounts), refreshed every few seconds. */
function useOverview() {
  const [snap, setSnap] = useState<Snapshot>();
  useEffect(() => {
    let alive = true;
    const load = () => void api.state().then(s => alive && setSnap(s), () => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return snap;
}

interface Props {
  goals: GoalSummary[];
  loaded: boolean;
  config?: ConfigView;
  onOpen: (goal: string, agent?: string) => void;
  onStart: (b: Record<string, unknown>) => Promise<boolean>;
  onCommand: (b: Record<string, unknown>) => Promise<unknown>;
  onSetup: () => void;
}

export function Home({ goals, loaded, config, onOpen, onStart, onCommand, onSetup }: Props) {
  const overview = useOverview();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  const repo = config?.scopes.find(s => s.scope === 'repo')?.dir.replace(/[/\\]\.metaharness$/, '');
  const running = goals.filter(g => g.status === 'running');
  // The log is shared by every repository the daemon has run in: past goals are this one's, unless asked.
  const here = (g: GoalSummary) => !repo || g.dir === repo;
  const others = goals.filter(g => g.status !== 'running' && !here(g)).length;
  const past = goals.filter(g => g.status !== 'running' && (elsewhere || here(g)) && (!query || `${g.request} ${g.result ?? ''} ${g.dir}`.toLowerCase().includes(query.toLowerCase())));
  const shown = showAll || query ? past : past.slice(0, 8);
  const needs = (overview?.inbox ?? []).filter(i => ACTIONABLE.includes(i.kind));
  const label = (id: string) => firstLine(goals.find(g => g.id === id)?.request).slice(0, 40) || id;
  const accounts = (overview?.accounts ?? []).filter(a => a.status !== 'ok' || (a.usedPct ?? 0) > 0);
  const roles = config?.roles.length ?? 0;

  return (
    <div className="page home">
      <div className="page-head">
        <div>
          <h1>Home</h1>
          {repo && (
            <div className="muted">
              Teams work in <span className="mono">{repo}</span>
              {config?.override ? <span className="pill">every role runs on {config.override}</span> : null}
            </div>
          )}
        </div>
      </div>

      <NeedsYou
        items={needs}
        goalLabel={label}
        onResolve={(item, decision, reply) => void onCommand({ cmd: 'inbox.resolve', item, decision, reply })}
        onSelectAgent={(name, goal) => onOpen(goal, name)}
      />

      <section className="panel">
        <h2>Start a goal</h2>
        {config && roles === 0 ? (
          <div className="empty">
            There are no roles yet, so there's nobody to lead.{' '}
            <button className="btn primary small" onClick={onSetup}>
              Set up roles
            </button>
          </div>
        ) : (
          <NewGoalForm config={config} onStart={onStart} />
        )}
      </section>

      {running.length > 0 && (
        <section>
          <h2 className="section-h">Running</h2>
          <div className="goal-cards">
            {running.map(g => (
              <button key={g.id} className="goal-card" onClick={() => onOpen(g.id)}>
                <div className="goal-card-top">
                  <span className="pill running">running {duration(g.createdAt)}</span>
                  {g.inbox > 0 && <span className="badge warn" title="Waiting for you">{g.inbox}</span>}
                  <span className="spacer" />
                  <span className="muted">{money(g.cost)}</span>
                </div>
                <div className="goal-card-title">{firstLine(g.request)}</div>
                <div className="muted small">
                  {g.working} of {g.agents} agent{g.agents === 1 ? '' : 's'} working
                  {g.workflow ? ` · ${g.workflow}` : ''}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="section-h-row">
          <h2 className="section-h">Past goals{repo && !elsewhere ? ' here' : ''}</h2>
          {others > 0 && (
            <label className="check small muted">
              <input type="checkbox" checked={elsewhere} onChange={e => setElsewhere(e.target.checked)} /> Include {others} from other directories
            </label>
          )}
          {(past.length > 3 || query) && <input type="search" className="search" placeholder="Search goals and outcomes" value={query} onChange={e => setQuery(e.target.value)} />}
        </div>
        <div className="goal-rows">
          {shown.map(g => (
            <div key={g.id} className="goal-row" onClick={() => onOpen(g.id)} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onOpen(g.id)}>
              <div className="goal-row-top">
                <span className={`pill ${g.status}`}>{g.status}</span>
                <span className="goal-row-title">{firstLine(g.request)}</span>
                <span className="spacer" />
                <span className="muted small">
                  {g.agents} agents · {money(g.cost)} · {ago(g.createdAt)}
                </span>
              </div>
              {!here(g) && <div className="muted small mono ellipsis">{g.dir}</div>}
              {g.result && (
                <div onClick={e => e.stopPropagation()}>
                  <More lines={2} className="quiet">
                    <Markdown text={g.result} />
                  </More>
                </div>
              )}
            </div>
          ))}
          {!past.length && <div className="empty">{!loaded ? 'Loading…' : query ? 'No goal matches.' : `Finished goals${repo ? ' in this repository' : ''} and what came of them show up here.`}</div>}
          {!showAll && !query && past.length > shown.length && (
            <button className="btn ghost" onClick={() => setShowAll(true)}>
              Show all {past.length}
            </button>
          )}
        </div>
      </section>

      {accounts.length > 0 && (
        <section>
          <h2 className="section-h">Accounts</h2>
          <div className="accounts">
            {accounts.map(a => (
              <div key={a.id} className={`account ${a.status}`}>
                <b>{a.id}</b>
                <span>{a.status}</span>
                {a.usedPct != null && (
                  <span className="meter" title={`${a.usedPct}% used`}>
                    <i style={{ width: `${Math.min(100, a.usedPct)}%` }} />
                  </span>
                )}
                <span className="muted small">{[a.usedPct != null && `${a.usedPct}% used`, a.window, a.resetsAt && `resets ${clock(a.resetsAt)}`].filter(Boolean).join(' · ')}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
