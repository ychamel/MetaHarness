import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ago, BUSY, duration, money } from '../format.ts';
import type { ConfigView, Goal, GoalSummary, MhEvent, Participant, Snapshot } from '../types.ts';
import { TeamTree } from '../components/TeamTree.tsx';
import { ACTIONABLE, NeedsYou, Updates } from '../components/Inbox.tsx';
import { AgentDetail } from '../components/AgentDetail.tsx';
import { ErrorBoundary, Markdown, More, useConfirm } from '../components/common.tsx';
import { MessageDialog } from '../components/Dialogs.tsx';
import { AccountChips, harnessOf } from '../components/Accounts.tsx';
import { Splitter } from '../components/Splitter.tsx';
import { Story } from '../views/Story.tsx';
import { Files } from '../views/Files.tsx';
import { Activity } from '../views/Activity.tsx';
import type { GitSel } from '../views/Git.tsx';
import type { DesignNav } from '../views/Design.tsx';
import { RoomHeader } from '../components/Room.tsx';
import { roomOf } from '../roomData.ts';

// The flow views pull in React Flow; load them when first opened.
const Graph = lazy(() => import('../views/Graph.tsx'));
const Sequence = lazy(() => import('../views/Sequence.tsx'));
const Timeline = lazy(() => import('../views/Timeline.tsx'));
const Costs = lazy(() => import('../views/Costs.tsx'));
const Design = lazy(() => import('../views/Design.tsx'));
const Git = lazy(() => import('../views/Git.tsx'));
const Thread = lazy(() => import('../views/Thread.tsx'));

export type GoalTab = 'thread' | 'story' | 'design' | 'git' | 'files' | 'graph' | 'sequence' | 'timeline' | 'costs' | 'log';
const TABS: [GoalTab, string, string][] = [
  ['story', 'Story', 'What happened, the important parts first'],
  ['design', 'Design', 'The code as areas from the map, in layers: what a commit, a landing, a branch or the whole goal changed, dependencies, flows, hotspots, and who works where'],
  ['git', 'Git', 'Commits, branches and diffs'],
  ['files', 'Files', 'The shared folder: designs, reviews, reports'],
  ['graph', 'Graph', 'Who talks to whom'],
  ['sequence', 'Sequence', 'Messages over time'],
  ['timeline', 'Timeline', 'Who was busy when'],
  ['costs', 'Costs', 'Where the money went, by agent, role, model and kind of token'],
  ['log', 'Log', 'Every event, as it happened'],
];
/** A room's tabs: its thread first, where a goal has its story; the rest as for a goal. */
const ROOM_TABS: [GoalTab, string, string][] = [['thread', 'Room', 'The room: who is in it and what they are doing, the thread, the board, and asking'], ...TABS.filter(([t]) => t !== 'story')];

/** Where a new room starts from, and what it's seeded with. */
export interface RoomFrom {
  id: string;
  label: string;
  kind: 'room' | 'goal';
  topic?: string;
  cast?: Participant[];
}

/**
 * Parts of the goal page put away to give the tabs more room: the same on every tab, so switching
 * tabs never moves the page. Kept in the browser. With the agent's column put away, an agent
 * picked slides in over the page.
 */
type Room = { team?: boolean; header?: boolean; agent?: boolean };
const ROOM_KEY = 'mh.goal.panes';

function useRoom(): [Room, (r: Room) => void] {
  const [room, setRoom] = useState<Room>(() => {
    try {
      return JSON.parse(localStorage.getItem(ROOM_KEY) ?? '{}');
    } catch {
      return {};
    }
  });
  const set = (r: Room) => {
    setRoom(r);
    try {
      localStorage.setItem(ROOM_KEY, JSON.stringify(r));
    } catch {
      // Kept for this visit only.
    }
  };
  return [room, set];
}

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
  onFile: (path?: string) => void;
  onAgent: (name?: string) => void;
  onGoal: (id: string) => void;
  onCommand: (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onSpawn: (parent?: string) => void;
  onNewGoal: () => void;
  onEditRole: (role: string) => void;
  onHarnesses: () => void;
  config?: ConfigView;
  /** Rooms, for a room's switcher. */
  rooms: GoalSummary[];
  onNewRoom: (from?: RoomFrom) => void;
  /** A goal that carries out what a room settled. */
  onGoalFromRoom: (room: string, topic: string) => void;
  onAllGoals: () => void;
  onAllRooms: () => void;
}

export function GoalPage(p: Props) {
  const { goal, snapshot, events } = p;
  const isRoom = goal?.kind === 'room';
  const roomView = useMemo(() => (isRoom ? roomOf(events, goal?.roomBranch ?? null) : undefined), [isRoom, events, goal?.roomBranch]);
  // A room has a thread where a goal has a story.
  const tab: GoalTab = isRoom && p.tab === 'story' ? 'thread' : !isRoom && p.tab === 'thread' ? 'story' : p.tab;
  const inbox = useMemo(() => (snapshot?.inbox ?? []).filter(i => i.goal === goal?.id), [snapshot, goal?.id]);
  const needs = inbox.filter(i => ACTIONABLE.includes(i.kind));
  const updates = inbox.filter(i => !ACTIONABLE.includes(i.kind));
  const agent = goal?.agents.find(a => a.name === p.agentName) ?? goal?.agents.find(a => a.name === goal.lead);
  const resolve = (item: string, decision: string, reply?: string) => void p.onCommand({ cmd: 'inbox.resolve', item, decision, reply });
  const [gitSel, setGitSel] = useState<GitSel>();
  const openGit = (sel: GitSel) => {
    setGitSel(sel);
    p.onTab('git');
  };
  // Where the Design view is (its scope, area and focus) outlasts switching tabs, not goals.
  const [designNav, setDesignNav] = useState<DesignNav>({});
  const [room, setRoom] = useRoom();
  // With its column put away, an agent picked slides in over the tab; the graph shows it in its own side panel instead.
  const [drawer, setDrawer] = useState(false);
  const onAgent = (name?: string) => {
    if (room.agent && name && tab !== 'graph') setDrawer(true);
    p.onAgent(name);
  };
  // The graph reads a shared file in its side panel; elsewhere it opens in the Files tab.
  const openFile = (path: string) => {
    p.onFile(path);
    if (tab !== 'graph') p.onTab('files');
  };
  useEffect(() => setDrawer(false), [tab]);
  useEffect(() => {
    if (!drawer) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      e.stopImmediatePropagation();
      setDrawer(false);
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [drawer]);
  const allAway = !!(room.team && room.header && room.agent);
  useEffect(() => setDesignNav({}), [goal?.id]);
  const openDesign = (nav: DesignNav) => {
    setDesignNav(nav);
    p.onTab('design');
  };

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

  const agentDetail = agent ? (
    <AgentDetail
      key={`${goal.id}/${agent.name}`}
      goal={goal}
      agent={agent}
      events={events}
      manifest={snapshot?.harnesses[agent.harness]}
      onCommand={p.onCommand}
      onSpawnUnder={name => p.onSpawn(name)}
      onEditRole={p.onEditRole}
      onOpenGit={openGit}
      onOpenFile={openFile}
    />
  ) : (
    <div className="empty">Pick an agent to see what it's doing.</div>
  );

  return (
    <div className={`goal-page${room.header ? ' no-header' : ''}`}>
      {!room.header &&
        (isRoom && roomView ? (
          <RoomHeader rooms={p.rooms} goal={goal} room={roomView} events={events} snapshot={snapshot} connected={p.connected} onGoal={p.onGoal} onNewRoom={() => p.onNewRoom()} onAllRooms={p.onAllRooms} onCommand={p.onCommand} />
        ) : (
          <GoalHeader {...p} goal={goal} events={events} />
        ))}
      <div className={`main${room.team ? ' no-team' : ''}${room.agent ? ' no-agent' : ''}`}>
        {!room.team && (
        <>
        <aside className="col">
          <div className="section-title">
            Team <span className="muted normal">{teamSummary(goal)}</span>
          </div>
          <div className="scroll">
            <TeamTree goal={goal} selected={agent?.name} onSelect={onAgent} />
          </div>
          <Updates items={updates} onResolve={resolve} onSelectAgent={onAgent} />
        </aside>
        <Splitter pane="team" grow="right" min={200} max={560} label="Team column" />
        </>
        )}

        <section className="col center">
          <NeedsYou items={needs} onResolve={resolve} onSelectAgent={onAgent} />
          <nav className="tabs">
            {room.header && (
              <button className="tabs-goal ellipsis" onClick={() => setRoom({ ...room, header: false })} title={`${goal.request}\n\nShow the goal's header again`}>
                <span className={`pill ${goal.status}`}>{goal.status}</span> {goal.request.split('\n')[0]}
              </button>
            )}
            {(isRoom ? ROOM_TABS : TABS).map(([t, label, title]) => (
              <button key={t} className={`tab${tab === t ? ' on' : ''}`} title={title} onClick={() => p.onTab(t)}>
                {label}
              </button>
            ))}
            <span className="grow" />
            <span className="room-toggles" role="group" aria-label="Make room">
              <RoomButton on={!room.team} label="team column" icon="team" onClick={() => setRoom({ ...room, team: !room.team })} />
              <RoomButton on={!room.header} label="goal header" icon="header" onClick={() => setRoom({ ...room, header: !room.header })} />
              <RoomButton on={!room.agent} label="agent column" icon="agent" onClick={() => setRoom({ ...room, agent: !room.agent })} />
              <button
                className={`room-btn${allAway ? ' on' : ''}`}
                onClick={() => setRoom(allAway ? {} : { team: true, header: true, agent: true })}
                title={allAway ? 'Bring the team, the header and the agent back' : 'Make room: put the team, the header and the agent away'}
                aria-pressed={allAway}
              >
                {allAway ? '⤡' : '⤢'}
              </button>
            </span>
          </nav>
          <ErrorBoundary resetKey={`${goal.id}/${tab}`}>
          <Suspense fallback={<div className="empty">Loading…</div>}>
            {tab === 'thread' && roomView && (
              <Thread
                goal={goal}
                events={events}
                room={roomView}
                config={p.config}
                onCommand={p.onCommand}
                onSelectAgent={onAgent}
                onOpenCommit={sha => openGit({ kind: 'commit', sha })}
                onOpenFile={openFile}
                onStartGoal={() => p.onGoalFromRoom(goal.id, goal.request)}
                onNewRoom={() => p.onNewRoom({ id: goal.id, label: goal.request.split('\n')[0], kind: 'room', topic: goal.request, cast: roomView.cast })}
              />
            )}
            {tab === 'story' && (
              <Story
                goal={goal}
                events={events}
                onSelectAgent={onAgent}
                onOpenFile={openFile}
              />
            )}
            {tab === 'design' && <Design goal={goal} events={events} nav={designNav} onNav={setDesignNav} onCommand={p.onCommand} onSelectAgent={onAgent} onOpenCommit={sha => openGit({ kind: 'commit', sha })} />}
            {tab === 'git' && <Git goal={goal} events={events} sel={gitSel} onSel={setGitSel} onSelectAgent={onAgent} onOpenDesign={(sha, area) => openDesign({ scope: { kind: 'commit', sha }, area })} />}
            {tab === 'files' && <Files goal={goal} events={events} selected={p.file} onSelect={p.onFile} onSelectAgent={onAgent} />}
            {tab === 'graph' && (
              // With the agent's column put away, the graph shows the agent in its own side panel.
              <Graph goal={goal} events={events} selected={agent?.name} agentPanel={room.agent ? agentDetail : undefined} file={p.file} onSelect={onAgent} onFile={p.onFile} onFilesTab={() => p.onTab('files')} />
            )}
            {tab === 'sequence' && <Sequence goal={goal} events={events} onSelect={onAgent} />}
            {tab === 'timeline' && <Timeline goal={goal} events={events} onSelect={onAgent} />}
            {tab === 'costs' && <Costs goal={goal} onSelect={onAgent} onSetup={p.onHarnesses} />}
            {tab === 'log' && <Activity events={events} agents={goal.agents.map(a => a.name)} onSelectAgent={onAgent} />}
          </Suspense>
          </ErrorBoundary>
        </section>
        {!room.agent && (
        <>
        <Splitter pane="agent" grow="left" min={300} max={1000} label="Agent column" />
        <aside className="col">{agentDetail}</aside>
        </>
        )}
        {room.agent && drawer && (
          <aside className="col agent-drawer" aria-label="Agent">
            <div className="drawer-head">
              <span className="muted small">Esc closes it</span>
              <button className="btn ghost small" onClick={() => setRoom({ ...room, agent: false })} title="Keep the agent beside the tab instead">
                Pin as a column
              </button>
              <button className="drawer-x" onClick={() => setDrawer(false)} title="Close (Esc)" aria-label="Close the agent">
                ×
              </button>
            </div>
            {agentDetail}
          </aside>
        )}
      </div>
    </div>
  );
}

const ROOM_ICONS: Record<'team' | 'header' | 'agent', string> = {
  team: 'M4 5h16v14H4zM9 5v14',
  header: 'M4 5h16v14H4zM4 10h16',
  agent: 'M4 5h16v14H4zM15 5v14',
};

/** Shows or puts away one part of the goal page. */
function RoomButton({ on, label, icon, onClick }: { on: boolean; label: string; icon: keyof typeof ROOM_ICONS; onClick: () => void }) {
  return (
    <button className={`room-btn${on ? '' : ' away'}`} onClick={onClick} title={on ? `Hide the ${label}` : `Show the ${label}`} aria-pressed={on} aria-label={on ? `Hide the ${label}` : `Show the ${label}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
        <path d={ROOM_ICONS[icon]} />
      </svg>
    </button>
  );
}

function teamSummary(goal: Goal): string {
  const working = goal.agents.filter(a => BUSY.includes(a.state)).length;
  const done = goal.agents.filter(a => a.state === 'done').length;
  return [working && `${working} working`, done && `${done} done`].filter(Boolean).join(' · ');
}

function GoalHeader({ goals, goal, events, snapshot, connected, onGoal, onCommand, onSpawn, onNewGoal, onTab, onFile, onAllGoals, onNewRoom }: Props & { goal: Goal }) {
  const confirm = useConfirm();
  const [messaging, setMessaging] = useState(false);
  const [outcome, setOutcome] = useState(false);
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

  const hasOutcome = goal.status !== 'running' && !!lead?.doneNote;
  const meta = (
    <div className="goal-meta">
      <span className={`pill ${goal.status}`}>{goal.status === 'running' ? 'running' : goal.status}</span>
      <span>{took}</span>
      {goal.cost != null && <span title="Cost reported by the harnesses">{money(goal.cost)}</span>}
      <span>
        {agents.length} agent{agents.length === 1 ? '' : 's'}
      </span>
      {goal.workflow && <span>workflow: {goal.workflow}</span>}
      {goal.branch && <span className="mono">{goal.branch}</span>}
      {goal.status === 'running' && snapshot && <AccountChips accounts={snapshot.accounts.filter(a => agents.some(x => x.harness === harnessOf(a.id)))} />}
      {!connected && goal.live && <span className="warn-text">reconnecting…</span>}
      {goal.notice && (
        <span className="help-dot" title={goal.notice}>
          i
        </span>
      )}
      {hasOutcome && (
        <button className={`btn ghost small${outcome ? ' on' : ''}`} onClick={() => setOutcome(o => !o)} aria-expanded={outcome}>
          Outcome {outcome ? '▴' : '▾'}
        </button>
      )}
    </div>
  );

  return (
    <header className="goal-header compact">
      <div className="goal-title-row">
        <button className="btn primary new-btn" onClick={onNewGoal} title="Start another goal">
          + New goal
        </button>
        <GoalSwitcher goals={goals.slice(0, 12)} goal={goal} onGoal={onGoal} onNewGoal={onNewGoal} onAllGoals={onAllGoals} />
        {meta}
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
          {goal.status !== 'running' && (
            <button className="btn ghost" onClick={() => onNewRoom({ id: goal.id, label: goal.request.split('\n')[0], kind: 'goal', topic: `How did "${goal.request.split('\n')[0].slice(0, 80)}" turn out, and what's next?` })} title="Talk over how it turned out with a few agents: a room that starts with this goal's outcome on its board">
              Discuss in a room
            </button>
          )}
          {!live || goal.status !== 'running' ? <CleanButton goal={goal} onCommand={onCommand} /> : null}
        </div>
      </div>
      {hasOutcome && outcome && lead?.doneNote && (
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

function GoalSwitcher({ goals, goal, onGoal, onNewGoal, onAllGoals }: { goals: GoalSummary[]; goal: Goal; onGoal: (id: string) => void; onNewGoal: () => void; onAllGoals: () => void }) {
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
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onAllGoals();
            }}
          >
            All goals…
          </button>
        </div>
      )}
    </div>
  );
}

