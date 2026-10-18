import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ago, BUSY, duration, money } from '../format.ts';
import type { Goal, GoalSummary, MhEvent, Snapshot } from '../types.ts';
import { TeamTree } from '../components/TeamTree.tsx';
import { ACTIONABLE, NeedsYou, Updates } from '../components/Inbox.tsx';
import { AgentDetail } from '../components/AgentDetail.tsx';
import { Markdown, More, useConfirm } from '../components/common.tsx';
import { MessageDialog } from '../components/Dialogs.tsx';
import { Story } from '../views/Story.tsx';
import { Files } from '../views/Files.tsx';
import { Activity } from '../views/Activity.tsx';

// The flow views pull in React Flow; load them when first opened.
const Graph = lazy(() => import('../views/Graph.tsx'));
const Sequence = lazy(() => import('../views/Sequence.tsx'));
const Timeline = lazy(() => import('../views/Timeline.tsx'));
const Costs = lazy(() => import('../views/Costs.tsx'));

export type GoalTab = 'story' | 'files' | 'graph' | 'sequence' | 'timeline' | 'costs' | 'log';
const TABS: [GoalTab, string, string][] = [
  ['story', 'Story', 'What happened, the important parts first'],
  ['files', 'Files', 'The shared folder: designs, reviews, reports'],
  ['graph', 'Graph', 'Who talks to whom'],
  ['sequence', 'Sequence', 'Messages over time'],
  ['timeline', 'Timeline', 'Who was busy when'],
  ['costs', 'Costs', 'Where the money went, by agent, role, model and kind of token'],
  ['log', 'Log', 'Every event, as it happened'],
];

interface Props {
  goals: GoalSummary[];
  /** The goals list has loaded at least once. */
  loaded: boolean;
  goal?: Goal;
  snapshot?: Snapshot;
  events: MhEvent[];
  connected: boolean;
  agentName?: string;
  tab: GoalTab;
  file?: string;
  onTab: (t: GoalTab) => void;
  onFile: (path: string) => void;
  onAgent: (name?: string) => void;
  onGoal: (id: string) => void;
  onCommand: (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onSpawn: (parent?: string) => void;
  onNewGoal: () => void;
  onEditRole: (role: string) => void;
  onHarnesses: () => void;
}

export function GoalPage(p: Props) {
  const { goal, snapshot, events } = p;
  const inbox = useMemo(() => (snapshot?.inbox ?? []).filter(i => i.goal === goal?.id), [snapshot, goal?.id]);
  const needs = inbox.filter(i => ACTIONABLE.includes(i.kind));
  const updates = inbox.filter(i => !ACTIONABLE.includes(i.kind));
  const agent = goal?.agents.find(a => a.name === p.agentName) ?? goal?.agents.find(a => a.name === goal.lead);
  const resolve = (item: string, decision: string, reply?: string) => void p.onCommand({ cmd: 'inbox.resolve', item, decision, reply });

  if (!goal) {
    return (
      <div className="page">
        <div className="empty big">
          {p.goals.length || !p.loaded ? (
            'Loading the goal…'
          ) : (
            <>
              No goals yet.
              <button className="btn primary" onClick={p.onNewGoal}>
                New goal
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="goal-page">
      <GoalHeader {...p} goal={goal} events={events} />
      <div className="main">
        <aside className="col">
          <div className="section-title">
            Team <span className="muted normal">{teamSummary(goal)}</span>
          </div>
          <div className="scroll">
            <TeamTree goal={goal} selected={agent?.name} onSelect={p.onAgent} />
          </div>
          <Updates items={updates} onResolve={resolve} onSelectAgent={n => p.onAgent(n)} />
        </aside>

        <section className="col center">
          <NeedsYou items={needs} onResolve={resolve} onSelectAgent={n => p.onAgent(n)} />
          <nav className="tabs">
            {TABS.map(([t, label, title]) => (
              <button key={t} className={`tab${p.tab === t ? ' on' : ''}`} title={title} onClick={() => p.onTab(t)}>
                {label}
              </button>
            ))}
          </nav>
          <Suspense fallback={<div className="empty">Loading…</div>}>
            {p.tab === 'story' && (
              <Story
                goal={goal}
                events={events}
                onSelectAgent={p.onAgent}
                onOpenFile={f => {
                  p.onFile(f);
                  p.onTab('files');
                }}
              />
            )}
            {p.tab === 'files' && <Files goal={goal} events={events} selected={p.file} onSelect={p.onFile} onSelectAgent={p.onAgent} />}
            {p.tab === 'graph' && <Graph goal={goal} events={events} selected={agent?.name} onSelect={p.onAgent} />}
            {p.tab === 'sequence' && <Sequence goal={goal} events={events} onSelect={p.onAgent} />}
            {p.tab === 'timeline' && <Timeline goal={goal} events={events} onSelect={p.onAgent} />}
            {p.tab === 'costs' && <Costs goal={goal} onSelect={p.onAgent} onSetup={p.onHarnesses} />}
            {p.tab === 'log' && <Activity events={events} agents={goal.agents.map(a => a.name)} onSelectAgent={p.onAgent} />}
          </Suspense>
        </section>

        <aside className="col">
          {agent ? (
            <AgentDetail
              key={`${goal.id}/${agent.name}`}
              goal={goal}
              agent={agent}
              events={events}
              manifest={snapshot?.harnesses[agent.harness]}
              onCommand={p.onCommand}
              onSpawnUnder={name => p.onSpawn(name)}
              onEditRole={p.onEditRole}
            />
          ) : (
            <div className="empty">Pick an agent to see what it's doing.</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function teamSummary(goal: Goal): string {
  const working = goal.agents.filter(a => BUSY.includes(a.state)).length;
  const done = goal.agents.filter(a => a.state === 'done').length;
  return [working && `${working} working`, done && `${done} done`].filter(Boolean).join(' · ');
}

function GoalHeader({ goals, goal, events, connected, onGoal, onCommand, onSpawn, onNewGoal, onTab, onFile }: Props & { goal: Goal }) {
  const confirm = useConfirm();
  const [messaging, setMessaging] = useState(false);
  const agents = goal.agents;
  const live = goal.live && goal.status !== 'ended';
  const paused = agents.filter(a => a.state === 'paused' || a.pausing).length;
  const active = agents.filter(a => !['ended', 'crashed', 'done'].includes(a.state)).length;
  const allPaused = live && paused > 0 && paused >= active;
  const leadDone = events.find(e => e.type === 'agent.done' && e.agent === goal.lead);
  const took = goal.status === 'running' ? `running ${duration(goal.createdAt)}` : leadDone ? `took ${duration(goal.createdAt, new Date(leadDone.ts).getTime())}` : `started ${ago(goal.createdAt)}`;
  const lead = agents.find(a => a.name === goal.lead);
  const report = useMemo(() => {
    const paths = events.filter(e => e.type === 'shared.write').map(e => String(e.data.path));
    return paths.find(p => /(^|\/)report\.md$/i.test(p)) ?? paths.find(p => /(^|\/)design\.md$/i.test(p));
  }, [events]);

  return (
    <header className="goal-header">
      <div className="goal-title-row">
        <GoalSwitcher goals={goals} goal={goal} onGoal={onGoal} onNewGoal={onNewGoal} />
        <div className="goal-actions">
          {live && (
            <>
              <button className="btn" onClick={() => setMessaging(true)} title="Message the lead, everyone, a role or one agent">
                ✉ Message
              </button>
              <button className="btn" onClick={() => onSpawn()} title="Start an agent on this goal yourself">
                + Agent
              </button>
              <button className="btn" onClick={() => void onCommand({ cmd: allPaused ? 'goal.resume' : 'goal.pause', goal: goal.id })} title={allPaused ? '' : 'Every agent stops after its current step'}>
                {allPaused ? '▶ Resume all' : '⏸ Pause all'}
              </button>
              <button
                className="btn ghost danger"
                onClick={async () => {
                  if (await confirm({ title: 'End this goal?', body: 'Every agent on it stops, and worktrees whose work is merged are removed. Unmerged or uncommitted work is kept.', confirm: 'End the goal', danger: true }))
                    void onCommand({ cmd: 'goal.end', goal: goal.id });
                }}
              >
                End goal
              </button>
            </>
          )}
          {!live || goal.status !== 'running' ? <CleanButton goal={goal} onCommand={onCommand} /> : null}
        </div>
      </div>
      <div className="goal-meta">
        <span className={`pill ${goal.status}`}>{goal.status === 'running' ? 'running' : goal.status}</span>
        <span>{took}</span>
        {goal.cost != null && <span title="Cost reported by the harnesses">{money(goal.cost)}</span>}
        <span>
          {agents.length} agent{agents.length === 1 ? '' : 's'}
        </span>
        {goal.workflow && <span>workflow: {goal.workflow}</span>}
        {goal.branch && <span className="mono">{goal.branch}</span>}
        {!connected && goal.live && <span className="warn-text">reconnecting…</span>}
      </div>
      {goal.notice && (
        <div className="notice" title={goal.notice}>
          {goal.notice}
        </div>
      )}
      {goal.status !== 'running' && lead?.doneNote && (
        <div className="outcome">
          <div className="kicker">
            Outcome
            {report && (
              <button
                className="btn ghost small"
                onClick={() => {
                  onFile(report);
                  onTab('files');
                }}
              >
                Open {report}
              </button>
            )}
          </div>
          <More lines={4}>
            <Markdown text={lead.doneNote} />
          </More>
        </div>
      )}
      {messaging && <MessageDialog goal={goal} onClose={() => setMessaging(false)} onSend={async b => !!(await onCommand(b))} />}
    </header>
  );
}

function CleanButton({ goal, onCommand }: { goal: Goal; onCommand: Props['onCommand'] }) {
  const confirm = useConfirm();
  const hasWorktrees = goal.agents.some(a => a.worktree);
  if (!hasWorktrees) return null;
  return (
    <button
      className="btn ghost"
      title="Remove this goal's worktrees and merged branches"
      onClick={async () => {
        const r = (await onCommand({ cmd: 'goal.clean', goal: goal.id })) as { results?: { kept: string[] }[]; refused?: string[] } | undefined;
        const kept = r?.results?.flatMap(x => x.kept) ?? [];
        if (kept.length && (await confirm({ title: 'Some work was kept', body: <><p>These have uncommitted or unmerged work:</p><ul>{kept.map(k => <li key={k} className="mono">{k}</li>)}</ul><p>Remove them anyway? That work is lost.</p></>, confirm: 'Remove them too', danger: true })))
          void onCommand({ cmd: 'goal.clean', goal: goal.id, force: true });
      }}
    >
      Clean up
    </button>
  );
}

function GoalSwitcher({ goals, goal, onGoal, onNewGoal }: { goals: GoalSummary[]; goal: Goal; onGoal: (id: string) => void; onNewGoal: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="goal-switcher" ref={ref}>
      <button className="goal-title" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} title={goal.request}>
        <span className="title-text">{goal.request.split('\n')[0]}</span>
        <span className="muted">▾</span>
      </button>
      {open && (
        <div className="menu" role="listbox">
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onNewGoal();
            }}
          >
            <b>+ New goal</b>
          </button>
          {goals.map(g => (
            <button
              key={g.id}
              className={`menu-item${g.id === goal.id ? ' on' : ''}`}
              onClick={() => {
                onGoal(g.id);
                setOpen(false);
              }}
            >
              <span className={`pill ${g.status}`}>{g.status}</span>
              <span className="ellipsis">{g.request}</span>
              <span className="sub">
                {g.inbox > 0 && <span className="badge">{g.inbox}</span>} {money(g.cost)} · {ago(g.createdAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

