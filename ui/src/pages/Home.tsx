import { useEffect, useState } from 'react';
import { ago, duration, firstLine, money } from '../format.ts';
import type { ConfigView, GoalSummary, Snapshot } from '../types.ts';
import { ACTIONABLE, NeedsYou } from '../components/Inbox.tsx';
import { NewGoalForm } from '../components/Dialogs.tsx';
import { Markdown, More } from '../components/common.tsx';
import { AccountList, useOverview } from '../components/Accounts.tsx';

interface Props {
  goals: GoalSummary[];
  rooms: GoalSummary[];
  onOpenRoom: (room: string) => void;
  onNewRoom: () => void;
  loaded: boolean;
  config?: ConfigView;
  onOpen: (goal: string, agent?: string) => void;
  onStart: (b: Record<string, unknown>) => Promise<boolean>;
  onCommand: (b: Record<string, unknown>) => Promise<unknown>;
  onSetup: () => void;
  onAllGoals: () => void;
}

export function Home({ goals, rooms, loaded, config, onOpen, onOpenRoom, onNewRoom, onStart, onCommand, onSetup, onAllGoals }: Props) {
  const openRooms = rooms.filter(r => r.status === 'running');
  const overview = useOverview();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [elsewhere, setElsewhere] = useState(false);
  const repo = config?.project?.dir;
  const running = goals.filter(g => g.status === 'running');
  // Goals come filtered to the project; the checkbox below is for the rest of the log.
  const here = (g: GoalSummary) => !repo || g.dir === repo;
  const others = goals.filter(g => g.status !== 'running' && !here(g)).length;
  const past = goals.filter(g => g.status !== 'running' && (elsewhere || here(g)) && (!query || `${g.request} ${g.result ?? ''} ${g.dir}`.toLowerCase().includes(query.toLowerCase())));
  const shown = showAll || query ? past : past.slice(0, 8);
  const needs = (overview?.inbox ?? []).filter(i => ACTIONABLE.includes(i.kind));
  const label = (id: string) => firstLine(goals.find(g => g.id === id)?.request).slice(0, 40) || id;
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
        <div className="section-h-row">
          <h2>Start a goal</h2>
          <span className="spacer" />
          <button className="btn small" onClick={onNewRoom} title="A brainstorm: talk it through with a lead agent, which keeps a canvas and sends other agents to look into things">
            Or open a room to talk it over first
          </button>
        </div>
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

      {openRooms.length > 0 && (
        <section>
          <h2 className="section-h">Open rooms</h2>
          <div className="goal-cards">
            {openRooms.map(r => (
              <button key={r.id} className="goal-card" onClick={() => onOpenRoom(r.id)}>
                <div className="goal-card-top">
                  <span className="pill running">open {duration(r.createdAt)}</span>
                  <span className="spacer" />
                  <span className="muted">{money(r.cost)}</span>
                </div>
                <div className="goal-card-title">{firstLine(r.request)}</div>
                <div className="muted small">
                  {r.working} of {r.agents} participant{r.agents === 1 ? '' : 's'} working
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
          {goals.length > 0 && (
            <button className="btn ghost small" onClick={onAllGoals} title="Every goal, with its size on disk; delete the ones you’re done with">
              All goals…
            </button>
          )}
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
          {!past.length && <div className="empty">{!loaded ? 'Loading…' : query ? 'No goal matches.' : `Finished goals${repo ? ' in this project' : ''} and what came of them show up here.`}</div>}
          {!showAll && !query && past.length > shown.length && (
            <button className="btn ghost" onClick={() => setShowAll(true)}>
              Show all {past.length}
            </button>
          )}
        </div>
      </section>

      {overview && (overview.accounts.length > 0 || overview.limitChecks.length > 0) && (
        <section>
          <h2 className="section-h">Plan limits</h2>
          <AccountList accounts={overview.accounts} checks={overview.limitChecks} onCheck={() => onCommand({ cmd: 'limits.check' })} />
        </section>
      )}
    </div>
  );
}
