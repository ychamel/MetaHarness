import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ago, BUSY, duration, goalTitle, money } from '../format.ts';
import type { ConfigView, Goal, GoalSummary, MhEvent, Snapshot } from '../types.ts';
import { TeamTree } from '../components/TeamTree.tsx';
import { ACTIONABLE, NeedsYou, Updates } from '../components/Inbox.tsx';
import { AgentDetail } from '../components/AgentDetail.tsx';
import { ErrorBoundary, HeaderActions, Markdown, More, useConfirm } from '../components/common.tsx';
import { ContinueButtons, MessageDialog, UndoGoalButton, type ContinueFrom } from '../components/Dialogs.tsx';
import { AccountChips, harnessOf } from '../components/Accounts.tsx';
import { ApprovalsSelect, AwayButton, AwayNote, useAway } from '../components/Away.tsx';
import { Splitter } from '../components/Splitter.tsx';
import { Story } from '../views/Story.tsx';
import { Files } from '../views/Files.tsx';
import { Activity } from '../views/Activity.tsx';
import type { GitSel } from '../views/Git.tsx';
import type { DesignNav } from '../views/Design.tsx';
import { RoomHeader, type RoomFrom } from '../components/Room.tsx';
import { roomOf } from '../roomData.ts';
import { useBackCloses, useIsPhone } from '../phone.ts';

// The flow views pull in React Flow; load them when first opened.
const Graph = lazy(() => import('../views/Graph.tsx'));
const Sequence = lazy(() => import('../views/Sequence.tsx'));
const Timeline = lazy(() => import('../views/Timeline.tsx'));
const Costs = lazy(() => import('../views/Costs.tsx'));
const Design = lazy(() => import('../views/Design.tsx'));
const RoomView = lazy(() => import('../views/RoomView.tsx'));

export type GoalTab = 'thread' | 'team' | 'story' | 'design' | 'git' | 'files' | 'graph' | 'sequence' | 'timeline' | 'costs' | 'log';
/** A tab, and the views it switches between (the first is where it opens). */
type TabDef = { id: GoalTab; label: string; title: string; views?: [GoalTab, string, string][] };
const TAB = {
  story: {
    id: 'story', label: 'Story', title: 'What happened, the important parts first',
    views: [['story', 'Story', 'What happened, the important parts first'], ['log', 'Every event', 'Every event, as it happened, with filters']],
  },
  graph: {
    id: 'graph', label: 'Graph', title: 'Who talks to whom, and when',
    views: [['graph', 'Map', 'Who talks to whom'], ['sequence', 'Messages', 'Messages over time'], ['timeline', 'Busy', 'Who was busy when']],
  },
  design: { id: 'design', label: 'Design', title: 'The code: its areas and systems, what a commit, a landing, a branch or the whole goal changed, and the commits with their diffs' },
  files: { id: 'files', label: 'Files', title: 'The shared folder: designs, reviews, reports' },
  costs: { id: 'costs', label: 'Costs', title: 'Where the money went, by agent, role, model and kind of token' },
  room: { id: 'thread', label: 'Room', title: 'The room: the chat with its lead, the board, and the makers' },
} satisfies Record<string, TabDef>;
const TABS: TabDef[] = [TAB.story, TAB.graph, TAB.design, TAB.files, TAB.costs];
/** On a phone the team has no column: it's a tab, and picking an agent opens it over the page. */
const TEAM_TAB: TabDef = { id: 'team', label: 'Team', title: 'Who is on it and what each is doing, and the updates' };
const ON_PHONE: Room = { team: true, agent: true };
/** A room's tabs: the room, then what it wrote and what it cost. */
const ROOM_TABS: TabDef[] = [TAB.room, TAB.files, TAB.costs];
/** The tab each view belongs to (Git is the Design tab's Commits lens). */
const TAB_OF: Partial<Record<GoalTab, GoalTab>> = { log: 'story', sequence: 'graph', timeline: 'graph', git: 'design' };

export type { RoomFrom };

/**
 * Parts of the goal page put away to give the tabs more room: the same on every tab, so switching
 * tabs never moves the page. Kept in the browser. With the agent's column put away, an agent
 * picked slides in over the page. Rooms keep their own: they start with the team and the agent
 * put away, since the lens bar and the chat with the lead show them already.
 */
type Room = { team?: boolean; header?: boolean; agent?: boolean };
type PageKind = 'goal' | 'room';
const ROOM_KEYS: Record<PageKind, string> = { goal: 'mh.goal.panes', room: 'mh.room.panes' };
const ROOM_DEFAULTS: Record<PageKind, Room> = { goal: {}, room: { team: true, agent: true } };

function readRoom(kind: PageKind): Room {
  try {
    const saved = localStorage.getItem(ROOM_KEYS[kind]);
    return saved ? JSON.parse(saved) : ROOM_DEFAULTS[kind];
  } catch {
    return ROOM_DEFAULTS[kind];
  }
}

function useRoom(kind: PageKind): [Room, (r: Room) => void] {
  const [rooms, setRooms] = useState<Record<PageKind, Room>>(() => ({ goal: readRoom('goal'), room: readRoom('room') }));
  const set = (r: Room) => {
    setRooms(all => ({ ...all, [kind]: r }));
    try {
      localStorage.setItem(ROOM_KEYS[kind], JSON.stringify(r));
    } catch {
      // Kept for this visit only.
    }
  };
  return [rooms[kind], set];
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
  /** A new goal that continues this one, or this room. */
  onContinue: (from: ContinueFrom) => void;
  onSaveConfig: (b: Record<string, unknown>) => Promise<unknown>;
  onEditRole: (role: string) => void;
  onHarnesses: () => void;
  config?: ConfigView;
  /** Rooms, for a room's switcher. */
  rooms: GoalSummary[];
  onNewRoom: (from?: RoomFrom) => void;
  onAllGoals: () => void;
  onAllRooms: () => void;
}

export function GoalPage(p: Props) {
  const { goal, snapshot, events } = p;
  const isRoom = goal?.kind === 'room';
  const phone = useIsPhone();
  const roomView = useMemo(() => (isRoom ? roomOf(events) : undefined), [isRoom, events]);
  // A room has its room tab (kept as "thread" in links) where a goal has a story; a room's other tabs are a goal's.
  const asked: GoalTab = p.tab === 'team' && !phone ? (isRoom ? 'thread' : 'story') : p.tab;
  const tab: GoalTab = isRoom ? (['thread', 'team', 'files', 'costs'].includes(asked) ? asked : 'thread') : asked === 'thread' ? 'story' : asked === 'git' ? 'design' : asked;
  const group = TAB_OF[tab] ?? tab;
  // Links to the Git tab open the Design tab's Commits lens.
  useEffect(() => {
    if (p.tab === 'git' && !isRoom) setDesignNav(n => ({ ...n, lens: 'commits' }));
  }, [p.tab, isRoom]);
  const leadAgent = goal?.agents.find(a => a.name === goal.lead);
  const finished = !!goal && !isRoom && goal.status !== 'running';
  const inbox = useMemo(() => (snapshot?.inbox ?? []).filter(i => i.goal === goal?.id), [snapshot, goal?.id]);
  const needs = inbox.filter(i => ACTIONABLE.includes(i.kind));
  // The lead's report shows as the goal's outcome once it's over, not again among the updates.
  const leadDoneItem = inbox.find(i => i.kind === 'done' && i.agent === goal?.lead);
  const updates = inbox.filter(i => !ACTIONABLE.includes(i.kind) && !(finished && i === leadDoneItem));
  const agent = goal?.agents.find(a => a.name === p.agentName) ?? goal?.agents.find(a => a.name === goal.lead);
  const resolve = (item: string, decision: string, reply?: string) => void p.onCommand({ cmd: 'inbox.resolve', item, decision, reply });
  const [away] = useAway(snapshot?.away, p.onCommand);
  // Where the Design view is (its scope, area, focus and lens) outlasts switching tabs, not goals.
  const [designNav, setDesignNav] = useState<DesignNav>({});
  const [gitSel, setGitSel] = useState<GitSel>();
  const openGit = (sel: GitSel) => {
    setGitSel(sel);
    setDesignNav(n => ({ ...n, lens: 'commits' }));
    p.onTab('design');
  };
  const [savedRoom, setRoom] = useRoom(isRoom ? 'room' : 'goal');
  // What you put away on a big screen is kept for it; a phone always shows the one pane.
  const room = phone ? ON_PHONE : savedRoom;
  // With its column put away, an agent picked slides in over the tab; the graph shows it in its own side panel instead.
  const [drawer, setDrawer] = useState(false);
  const onAgent = (name?: string) => {
    if (room.agent && name && (phone || tab !== 'graph')) setDrawer(true);
    p.onAgent(name);
  };
  // The graph and a room read a shared file in their side panel; elsewhere it opens in the Files tab.
  const openFile = (path: string) => {
    if (phone) setDrawer(false);
    p.onFile(path);
    if (tab !== 'graph' && tab !== 'thread') p.onTab('files');
  };
  useEffect(() => setDrawer(false), [tab]);
  useBackCloses(drawer, () => setDrawer(false));
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
  // First on a room (the room itself leads), second on a goal (after its story).
  const shownTabs = !phone ? (isRoom ? ROOM_TABS : TABS) : isRoom ? [ROOM_TABS[0], TEAM_TAB, ...ROOM_TABS.slice(1)] : [TABS[0], TEAM_TAB, ...TABS.slice(1)];
  useEffect(() => setDesignNav({}), [goal?.id]);

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
          <RoomHeader
            rooms={p.rooms}
            goal={goal}
            room={roomView}
            events={events}
            snapshot={snapshot}
            connected={p.connected}
            onGoal={p.onGoal}
            onNewRoom={() => p.onNewRoom()}
            onRoomFromThis={() => p.onNewRoom({ id: goal.id, label: goal.request.split('\n')[0], kind: 'room', topic: goal.request, lenses: roomView.lenses })}
            onStartGoal={() => p.onContinue({ id: goal.id, label: goalTitle(goal.request), kind: 'room' })}
            onDesign={() => openFile('room/design.md')}
            onAllRooms={p.onAllRooms}
            onCommand={p.onCommand}
          />
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
          {away && !isRoom && goal.status === 'running' && <AwayNote compact />}
          <NeedsYou items={needs} onResolve={resolve} onSelectAgent={onAgent} />
          <nav className="tabs">
            {!phone && room.header && (
              <button className="tabs-goal ellipsis" onClick={() => setRoom({ ...room, header: false })} title={`${goal.request}\n\nShow the goal's header again`}>
                <span className={`pill ${goal.status}`}>{goal.status}</span> {goal.request.split('\n')[0]}
              </button>
            )}
            <span className="tab-strip">
              {shownTabs.map(t => (
                <button key={t.id} className={`tab${group === t.id ? ' on' : ''}`} title={t.title} onClick={() => group !== t.id && p.onTab(t.id)}>
                  {t.label}
                  {t.id === 'team' && updates.length > 0 && <span className="badge quiet">{updates.length}</span>}
                </button>
              ))}
            </span>
            {TABS.find(t => t.id === group)?.views && (
              <span className="seg tab-views" role="group" aria-label="View">
                {TABS.find(t => t.id === group)!.views!.map(([v, label, title]) => (
                  <button key={v} className={tab === v ? 'on' : ''} title={title} onClick={() => p.onTab(v)}>
                    {label}
                  </button>
                ))}
              </span>
            )}
            <span className="grow" />
            {!phone && <span className="room-toggles" role="group" aria-label="Make room">
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
            </span>}
          </nav>
          <ErrorBoundary resetKey={`${goal.id}/${tab}`}>
          <Suspense fallback={<div className="empty">Loading…</div>}>
            {tab === 'team' && (
              <div className="scroll team-pane">
                <div className="section-title">
                  Team <span className="muted normal">{teamSummary(goal)}</span>
                </div>
                <TeamTree goal={goal} selected={drawer ? agent?.name : undefined} onSelect={onAgent} />
                <Updates items={updates} onResolve={resolve} onSelectAgent={onAgent} />
              </div>
            )}
            {tab === 'thread' && roomView && (
              <RoomView
                goal={goal}
                events={events}
                room={roomView}
                config={p.config}
                onCommand={p.onCommand}
                onSelectAgent={onAgent}
                file={p.file}
                onFile={p.onFile}
                onFilesTab={() => p.onTab('files')}
                onBranch={cards => p.onNewRoom({ id: goal.id, label: goal.request.split('\n')[0], kind: 'room', topic: goal.request, lenses: roomView.lenses, cards: cards.map(c => ({ id: c.id, title: c.title })) })}
                onRoom={p.onGoal}
                onContinue={p.onContinue}
              />
            )}
            {finished && group === 'story' && (
              <Outcome goal={goal} lead={leadAgent} item={leadDoneItem} onResolve={resolve} onContinue={p.onContinue} onFile={openFile} events={events} onNewRoom={p.onNewRoom} />
            )}
            {tab === 'story' && (
              <Story
                goal={goal}
                events={events}
                onSelectAgent={onAgent}
                onOpenFile={openFile}
              />
            )}
            {tab === 'design' && <Design goal={goal} events={events} nav={designNav} onNav={setDesignNav} onCommand={p.onCommand} onSelectAgent={onAgent} gitSel={gitSel} onGitSel={setGitSel} />}
            {tab === 'files' && (
              <Files
                goal={goal} events={events} selected={p.file} onSelect={p.onFile} onSelectAgent={onAgent}
                onGoalFrom={isRoom ? undefined : path => p.onContinue({ id: goal.id, label: goalTitle(goal.request), kind: 'goal', action: 'continue', files: [path] })}
              />
            )}
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
            {phone ? (
              <div className="drawer-head">
                <button className="btn ghost small" onClick={() => setDrawer(false)}>
                  ← Back
                </button>
              </div>
            ) : (
              <div className="drawer-head">
                <span className="muted small">Esc closes it</span>
                <button className="btn ghost small" onClick={() => setRoom({ ...savedRoom, agent: false })} title="Keep the agent beside the tab instead">
                  Pin as a column
                </button>
                <button className="drawer-x" onClick={() => setDrawer(false)} title="Close (Esc)" aria-label="Close the agent">
                  ×
                </button>
              </div>
            )}
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

function GoalHeader({ goals, goal, events, snapshot, connected, config, onGoal, onCommand, onSaveConfig, onSpawn, onNewGoal, onAllGoals }: Props & { goal: Goal }) {
  const confirm = useConfirm();
  const phone = useIsPhone();
  const [messaging, setMessaging] = useState(false);
  const agents = goal.agents;
  const live = goal.live && goal.status !== 'ended';
  const paused = agents.filter(a => a.state === 'paused' || a.pausing).length;
  const active = agents.filter(a => !['ended', 'crashed', 'done'].includes(a.state)).length;
  const allPaused = live && paused > 0 && paused >= active;
  const leadDone = events.find(e => e.type === 'agent.done' && e.agent === goal.lead);
  const took = goal.status === 'running' ? `running ${duration(goal.createdAt)}` : leadDone ? `took ${duration(goal.createdAt, new Date(leadDone.ts).getTime())}` : `started ${ago(goal.createdAt)}`;
  const [away, setAway] = useAway(snapshot?.away, onCommand);
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
    </div>
  );

  return (
    <header className="goal-header compact">
      <div className="goal-title-row">
        {!phone && (
          <button className="btn primary new-btn" onClick={onNewGoal} title="Start another goal">
            + New goal
          </button>
        )}
        <GoalSwitcher goals={goals.slice(0, 12)} goal={goal} onGoal={onGoal} onNewGoal={onNewGoal} onAllGoals={onAllGoals} />
        {!phone && meta}
        <HeaderActions notice={goal.notice}>
          {live && (
            <>
              <ApprovalsSelect config={config} onSave={onSaveConfig} />
              <AwayButton away={away} onSet={setAway} />
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
        </HeaderActions>
      </div>
      {phone && meta}
      {messaging && <MessageDialog goal={goal} onClose={() => setMessaging(false)} onSend={async b => !!(await onCommand(b))} />}
    </header>
  );
}

/**
 * What a finished goal came to, once, above its story: the lead's report, the document it wrote,
 * and what to do next (each a new goal that continues this one, or a room to talk it over).
 */
function Outcome({ goal, lead, item, events, onResolve, onContinue, onFile, onNewRoom }: {
  goal: Goal;
  lead?: Goal['agents'][number];
  /** The lead's report in the Inbox: following up on it wakes the lead. */
  item?: { id: string };
  events: MhEvent[];
  onResolve: (item: string, decision: string, reply?: string) => void;
  onContinue: (f: ContinueFrom) => void;
  onFile: (path: string) => void;
  onNewRoom: (from?: RoomFrom) => void;
}) {
  const [reply, setReply] = useState<string>();
  const report = useMemo(() => {
    const paths = [...new Set(events.filter(e => e.type === 'shared.write').map(e => String(e.data.path)))].reverse().filter(p => !p.startsWith('imported/'));
    return paths.find(p => /(design|plan|report|review|audit)[^/]*\.md$/i.test(p));
  }, [events]);
  const title = goalTitle(goal.request);
  return (
    <div className="outcome goal-outcome">
      <div className="kicker">
        Outcome
        {report && (
          <button className="btn ghost small" onClick={() => onFile(report)}>
            Open {report}
          </button>
        )}
      </div>
      <More lines={4}>
        <Markdown text={lead?.doneNote || (goal.status === 'ended' ? 'The goal was ended before its lead reported.' : 'The lead stopped without a report.')} />
      </More>
      <div className="outcome-actions">
        <ContinueButtons small from={{ id: goal.id, label: title, kind: 'goal' }} onContinue={onContinue} />
        <button className="btn small ghost" onClick={() => onNewRoom({ id: goal.id, label: title, kind: 'goal', topic: `How did "${title.slice(0, 80)}" turn out, and what's next?` })} title="Talk over how it turned out: a room that starts with this goal's outcome on its canvas">
          Discuss in a room
        </button>
        <UndoGoalButton goal={goal.id} />
        <span className="grow" />
        {item &&
          (reply === undefined ? (
            <>
              <button className="btn small ghost" onClick={() => setReply('')} title="Ask the lead about it: it picks up again to answer">
                Follow up
              </button>
              <button className="btn small ghost" onClick={() => onResolve(item.id, 'dismiss')} title="Take its report off your updates">
                Mark read
              </button>
            </>
          ) : (
            <span className="row">
              <input type="text" autoFocus placeholder="Ask the lead (Enter sends)" value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => (e.key === 'Enter' && reply.trim() ? onResolve(item.id, 'dismiss', reply.trim()) : e.key === 'Escape' && setReply(undefined))} />
              <button className="btn small primary" disabled={!reply.trim()} onClick={() => onResolve(item.id, 'dismiss', reply.trim())}>
                Send
              </button>
            </span>
          ))}
      </div>
    </div>
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

