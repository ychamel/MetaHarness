import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, loadToken, setToken } from './api.ts';
import { useGoal } from './useGoal.ts';
import type { ConfigView, GoalSummary, ProjectSummary } from './types.ts';
import { BeginnerContext } from './beginner.ts';
import { SpawnDialog, StartGoalDialog, type ContinueFrom } from './components/Dialogs.tsx';
import { ConfirmProvider, ErrorBoundary, useToast } from './components/common.tsx';
import { Home } from './pages/Home.tsx';
import { GoalPage, type GoalTab, type RoomFrom } from './pages/GoalPage.tsx';
import { NewRoomDialog } from './components/Room.tsx';
import { Harnesses } from './pages/Harnesses.tsx';
import { AssistantPanel } from './components/AssistantPanel.tsx';
import { UpdateBanner } from './components/UpdateBanner.tsx';
import { Settings } from './pages/Settings.tsx';
import { Roles } from './pages/Roles.tsx';
import { Workflows } from './pages/Workflows.tsx';
import { Guidelines } from './pages/Guidelines.tsx';
import { Rules } from './pages/Rules.tsx';
import { Tools } from './pages/Tools.tsx';
import { Goals } from './pages/Goals.tsx';
import { Projects } from './pages/Projects.tsx';

type Page = 'home' | 'projects' | 'goal' | 'room' | 'goals' | SetupPage;
type SetupPage = 'roles' | 'workflows' | 'rules' | 'guidelines' | 'tools' | 'harnesses' | 'settings';

/** Setup's pages, in groups: one entry in the rail, a strip across the top of each. */
const SETUP: [string, [SetupPage, string, string][]][] = [
  ['Team', [['roles', 'Roles', 'The teammates a goal can use'], ['workflows', 'Workflows', 'How to run one kind of task, step by step'], ['guidelines', 'Guidelines', 'How every agent should work with the rest of the team']]],
  ['Behaviour', [['rules', 'Rules', 'Short notes agents get at the moment they matter'], ['settings', 'Settings', 'Approvals, prompt caches, plan limits, keeping agents going']]],
  ['Machine', [['harnesses', 'Harnesses', 'The agent CLIs on this machine, their models and prices'], ['tools', 'Tools & skills', 'MCP servers and skills roles can carry']]],
];
const SETUP_PAGES = SETUP.flatMap(([, pages]) => pages.map(([p]) => p));
const SETUP_KEY = 'mh.setup.page';
function lastSetup(): SetupPage {
  try {
    const p = localStorage.getItem(SETUP_KEY) as SetupPage | null;
    return p && SETUP_PAGES.includes(p) ? p : 'roles';
  } catch {
    return 'roles';
  }
}

/** Where you are, kept in the address so a reload or a shared link comes back to it. */
interface Place {
  page: Page;
  /** The project you're working in (design §22). */
  project?: string;
  goal?: string;
  room?: string;
  agent?: string;
  tab?: GoalTab;
  file?: string;
  /** The role, workflow or server open in Setup: scope/name, or "new". */
  item?: string;
}

function readHash(): Place {
  const p = new URLSearchParams(location.hash.slice(1));
  const get = (k: string) => p.get(k) ?? undefined;
  const page = (get('page') as Page) ?? (get('goal') ? 'goal' : 'home');
  return { page, project: get('project') ?? lastProject(), goal: get('goal'), room: get('room'), agent: get('agent'), tab: get('tab') as GoalTab, file: get('file'), item: get('item') };
}

function writeHash(pl: Place): string {
  const p = new URLSearchParams();
  p.set('page', pl.page);
  for (const k of ['project', 'goal', 'room', 'agent', 'tab', 'file', 'item'] as const) if (pl[k]) p.set(k, pl[k]!);
  return `#${p}`;
}

/** The project this browser last worked in, for an address that names none. */
const PROJECT_KEY = 'metaharness-project';
function lastProject(): string | undefined {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function keepProject(id?: string): void {
  try {
    if (id) localStorage.setItem(PROJECT_KEY, id);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    /* private window */
  }
}

export function App() {
  return (
    <ConfirmProvider>
      <Shell />
    </ConfirmProvider>
  );
}

function Shell() {
  const [token, setTok] = useState(() => loadToken());
  const [authFailed, setAuthFailed] = useState(false);
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<ConfigView>();
  const [place, setPlace] = useState<Place>(readHash);
  const [dialog, setDialog] = useState<{ kind: 'goal'; workflow?: string; request?: string; from?: ContinueFrom } | { kind: 'spawn'; parent?: string } | { kind: 'room'; from?: RoomFrom }>();
  const { toast, say } = useToast();
  const [asking, setAsking] = useState(false);
  const refreshGoal = useRef<() => Promise<void>>(undefined);

  // Back and forward move between places.
  useEffect(() => {
    const on = () => setPlace(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((next: Partial<Place>, replace = false) => {
    setPlace(prev => {
      const pl = { ...prev, ...next };
      const hash = writeHash(pl);
      if (hash !== location.hash) {
        if (replace) history.replaceState(history.state, '', hash);
        else history.pushState(null, '', hash);
      }
      return pl;
    });
  }, []);

  const loadGoals = useCallback(async () => {
    try {
      const [g, p] = await Promise.all([api.goals(), api.projects()]);
      setGoals(g);
      setProjects(p);
      setLoaded(true);
      setAuthFailed(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthFailed(true);
    }
  }, []);
  // The project: the one in the address, if it's still one you opened.
  const project = projects.find(p => p.id === place.project && p.opened) ?? (loaded ? undefined : projects.find(p => p.id === place.project));
  const projectId = project?.id ?? (loaded ? undefined : place.project);
  useEffect(() => keepProject(projectId), [projectId]);
  const loadConfig = useCallback(() => void api.config(projectId).then(setConfig, () => {}), [projectId]);
  useEffect(() => {
    if (!token) return;
    void loadGoals();
    const t = setInterval(() => void loadGoals(), 4000);
    return () => clearInterval(t);
  }, [token, loadGoals]);
  useEffect(() => {
    if (token) loadConfig();
  }, [token, loadConfig]);

  // Goals and rooms share the log; each tab lists the project's own.
  const goalList = useMemo(() => goals.filter(g => g.kind !== 'room' && g.project === projectId), [goals, projectId]);
  const rooms = useMemo(() => goals.filter(g => g.kind === 'room' && g.project === projectId), [goals, projectId]);
  // The goal page opens on the running goal, or the latest one; the room page likewise.
  // One that was deleted falls back to those.
  const pick = (list: GoalSummary[], want?: string) => {
    const known = want && (!loaded || list.some(g => g.id === want)) ? want : undefined;
    return known ?? (list.find(g => g.status === 'running') ?? list[0])?.id;
  };
  const goalId = pick(goalList, place.goal);
  const roomId = pick(rooms, place.room);
  // Goals and rooms are shown in their project; with none open, the projects are.
  const noProject = loaded && !project;
  const onGoalPage = place.page === 'goal' && !noProject;
  const onRoomPage = place.page === 'room' && !noProject;
  const shownId = onGoalPage ? goalId : onRoomPage ? roomId : undefined;
  const { snapshot, events, connected, error, refresh } = useGoal(token && !authFailed ? shownId : undefined);
  const goal = snapshot?.goals.find(g => g.id === shownId);
  refreshGoal.current = refresh;

  // A browser notification when an agent starts waiting on you, if you've allowed them.
  const needs = goals.reduce((n, g) => n + (g.needs ?? 0), 0);
  const lastNeeds = useRef(needs);
  useEffect(() => {
    if (needs > lastNeeds.current && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('MetaHarness', { body: needs === 1 ? 'An agent is waiting on you.' : `${needs} things are waiting on you.` });
    }
    lastNeeds.current = needs;
  }, [needs]);
  useEffect(() => {
    document.title = needs ? `(${needs}) MetaHarness` : 'MetaHarness';
  }, [needs]);

  // The lead's prompt cache is yours to keep warm: say so when it's about to expire.
  const seenSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!events.length) return;
    const last = events.at(-1)!.seq;
    if (seenSeq.current === undefined) return void (seenSeq.current = last);
    for (const e of events) {
      if (e.seq <= seenSeq.current || e.type !== 'agent.cache_expiring' || e.data.told !== 'human') continue;
      const text = `${e.agent}'s prompt cache expires in about ${e.data.inSec < 90 ? `${e.data.inSec} seconds` : `${Math.round(e.data.inSec / 60)} minutes`}. Message it now if you have more for it; after that its next turn costs more.`;
      say(text);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('MetaHarness', { body: text });
    }
    seenSeq.current = last;
  }, [events, say]);
  // Another goal or room: its old warnings aren't news.
  useEffect(() => void (seenSeq.current = undefined), [shownId]);

  // An address naming a goal of another project you opened opens that project.
  useEffect(() => {
    const id = place.page === 'room' ? place.room : place.page === 'goal' ? place.goal : undefined;
    const p = id && goals.find(g => g.id === id)?.project;
    if (p && p !== projectId && projects.some(x => x.id === p && x.opened)) go({ project: p }, true);
  }, [place.page, place.goal, place.room, goals, projects, projectId, go]);

  const command = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        // Setup, goals and rooms are the project's: every command says which (the daemon ignores it where it doesn't matter).
        const r = await api.command(projectId && !('project' in body) ? { ...body, project: projectId } : body);
        if (typeof r.result === 'string' && !['agent.message', 'inbox.resolve', 'room.post', 'room.canvas', 'room.lens', 'room.lensOff', 'room.stop', 'room.ask', 'room.mix', 'room.godot'].includes(String(body.cmd))) say(r.result);
        if (body.cmd === 'agent.message') say('Sent.');
        void refresh();
        void loadGoals();
        return r as Record<string, unknown>;
      } catch (e) {
        say((e as Error).message);
        return undefined;
      }
    },
    [refresh, say, loadGoals, projectId],
  );

  const saveConfig = useCallback(
    async (body: Record<string, unknown>) => {
      const r = (await command(body)) as { config?: ConfigView } | undefined;
      if (r?.config) setConfig(r.config);
      // Prices and cache lifetimes change what the goal page shows.
      if (r?.config) void refreshGoal.current?.();
      return r?.config;
    },
    [command],
  );

  const startGoal = useCallback(
    async (b: Record<string, unknown>) => {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      const r = (await command(b)) as { goal?: string; room?: string } | undefined;
      if (!r?.goal) return false;
      setDialog(undefined);
      if (r.room) go({ page: 'room', room: r.room, agent: undefined, tab: 'thread', file: undefined });
      else go({ page: 'goal', goal: r.goal, agent: undefined, tab: 'story', file: undefined });
      return true;
    },
    [command, go],
  );

  if (!token || authFailed) {
    return (
      <SignIn
        failed={authFailed}
        onToken={t => {
          setToken(t);
          setTok(t);
          setAuthFailed(false);
        }}
      />
    );
  }

  const pickProject = (id: string) => go({ project: id, page: 'home', goal: undefined, room: undefined, agent: undefined, item: undefined, file: undefined });
  const current = goalList.find(g => g.id === goalId);
  const currentRoom = rooms.find(g => g.id === roomId);
  const allKind = place.page === 'goals' && place.item === 'rooms' ? 'room' : 'goal';
  const setup = (page: Page) => ({ selected: place.page === page ? place.item : undefined, onSelect: (item?: string) => go({ item }), onSave: saveConfig, onCommand: command, config });
  const onSetup = SETUP_PAGES.includes(place.page as SetupPage);
  const goSetup = (page: SetupPage) => {
    try {
      localStorage.setItem(SETUP_KEY, page);
    } catch {
      // Remembered for this visit only.
    }
    go({ page, item: undefined });
  };
  const continueFrom = (from: ContinueFrom) => setDialog({ kind: 'goal', from });

  return (
    <BeginnerContext.Provider value={!!config?.settings.effective.beginner}>
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="rail-brand" title="MetaHarness">
          <svg viewBox="0 0 16 16" aria-hidden>
            <circle cx="4" cy="8" r="3" fill="var(--accent)" />
            <circle cx="12" cy="4" r="2.5" fill="var(--done)" />
            <circle cx="12" cy="12" r="2.5" fill="var(--waiting)" />
          </svg>
        </div>
        <RailButton icon={ICONS.project} label={project?.name ?? 'Projects'} on={place.page === 'projects' || (place.page === 'home' && !project)} badge={projects.filter(p => p.id !== projectId).reduce((n, p) => n + p.needs, 0)} onClick={() => go({ page: 'projects', item: undefined })} />
        <RailButton icon={ICONS.home} label="Home" on={place.page === 'home' && !!project} badge={project?.needs} onClick={() => go({ page: 'home', item: undefined })} />
        <RailButton
          icon={ICONS.goal}
          label="Goals"
          on={onGoalPage || (place.page === 'goals' && allKind === 'goal')}
          dot={current?.status === 'running'}
          onClick={() => (noProject ? go({ page: 'projects' }) : goalList.length ? go({ page: 'goal', goal: goalId, item: undefined, tab: place.tab === 'thread' ? 'story' : place.tab }) : setDialog({ kind: 'goal' }))}
        />
        <RailButton
          icon={ICONS.room}
          label="Rooms"
          on={onRoomPage || (place.page === 'goals' && allKind === 'room')}
          dot={currentRoom?.status === 'running'}
          onClick={() => go(noProject ? { page: 'projects' } : { page: 'room', room: roomId, item: undefined, tab: 'thread' })}
        />
        <RailButton icon={ICONS.ask} label="Ask" on={asking} onClick={() => setAsking(a => !a)} />
        <div className="rail-sep" />
        <RailButton icon={ICONS.settings} label="Setup" on={onSetup} onClick={() => goSetup(onSetup ? (place.page as SetupPage) : lastSetup())} />
      </nav>

      <main className="content">
        <ErrorBoundary resetKey={place.page}>
        <UpdateBanner />
        {error && (onGoalPage || onRoomPage) && <div className="error-bar">{error}</div>}
        {(place.page === 'projects' || (noProject && ['home', 'goal', 'room'].includes(place.page))) && (
          <Projects projects={projects} loaded={loaded} current={projectId} onPick={pickProject} onCommand={command} onChanged={() => void loadGoals()} />
        )}
        {place.page === 'home' && project && (
          <Home
            goals={goalList}
            rooms={rooms}
            loaded={loaded}
            config={config}
            onOpen={(g, agent) => go({ page: 'goal', goal: g, agent, tab: place.tab === 'thread' ? 'story' : (place.tab ?? 'story'), file: undefined })}
            onOpenRoom={r => go({ page: 'room', room: r, agent: undefined, tab: 'thread', file: undefined })}
            onNewRoom={() => setDialog({ kind: 'room' })}
            onNewGoal={() => setDialog({ kind: 'goal' })}
            onContinue={continueFrom}
            onCommand={command}
            onSaveConfig={saveConfig}
            onSetup={() => go({ page: 'roles', item: 'new' })}
            onAllGoals={() => go({ page: 'goals', item: undefined })}
          />
        )}
        {place.page === 'goals' && (
          <Goals
            goals={goals.filter(g => (allKind === 'room') === (g.kind === 'room'))}
            projectDir={project?.dir}
            kind={allKind}
            loaded={loaded}
            config={config}
            onKind={k => go({ page: 'goals', item: k === 'room' ? 'rooms' : undefined })}
            onContinue={from => setDialog({ kind: 'goal', from, request: `Build ${from.label} for production, from its prototype.` })}
            onNew={() => setDialog({ kind: allKind })}
            onOpen={(g, tab) => {
              // A goal from another project opens in it.
              const p = goals.find(x => x.id === g)?.project;
              const there = p && p !== projectId && projects.some(x => x.id === p && x.opened) ? { project: p } : {};
              if (allKind === 'room') go({ ...there, page: 'room', room: g, agent: undefined, tab: tab ?? 'thread', file: undefined });
              else go({ ...there, page: 'goal', goal: g, agent: undefined, tab: tab ?? 'story', file: undefined });
            }}
            onCommand={command}
            onChanged={() => void loadGoals()}
          />
        )}
        {onRoomPage && !rooms.length && loaded && (
          <div className="page">
            <div className="empty big">
              <div>
                <b>Rooms</b> are for getting clear and deciding, when you don't know yet what you want. A lead agent helps you narrow it down and keeps a board; makers find references and make images, playable demos with knobs and write-ups; you mix cards into new ideas. A topic can branch into a room of its own; what you settle becomes a goal.
              </div>
              <button className="btn primary" onClick={() => setDialog({ kind: 'room' })}>
                New room
              </button>
            </div>
          </div>
        )}
        {(onGoalPage || (onRoomPage && (rooms.length > 0 || !loaded))) && (
          <GoalPage
            goals={goalList}
            rooms={rooms}
            config={config}
            onNewRoom={from => setDialog({ kind: 'room', from })}
            onContinue={from => setDialog({ kind: 'goal', from, ...(from.kind === 'room' ? { request: `Carry out what the room settled: ${from.label}` } : from.kind === 'prototype' ? { request: `Build ${from.label} for production, from its prototype.` } : {}) })}
            onSaveConfig={saveConfig}
            onAllGoals={() => go({ page: 'goals', item: undefined })}
            onAllRooms={() => go({ page: 'goals', item: 'rooms' })}
            loaded={loaded}
            goal={goal}
            snapshot={snapshot}
            events={events}
            connected={connected}
            agentName={place.agent}
            tab={place.tab ?? (onRoomPage ? 'thread' : 'story')}
            file={place.file}
            onTab={tab => go({ tab }, true)}
            onFile={file => go({ file }, true)}
            onAgent={agent => go({ agent }, true)}
            onGoal={g => go(onRoomPage ? { room: g, agent: undefined, file: undefined } : { goal: g, agent: undefined, file: undefined })}
            onCommand={command}
            onSpawn={parent => setDialog({ kind: 'spawn', parent })}
            onNewGoal={() => setDialog({ kind: 'goal' })}
            onEditRole={role => {
              const r = config?.roles.find(x => x.name === role);
              go({ page: 'roles', item: r ? `${r.scope}/${r.name}` : undefined });
            }}
            onHarnesses={() => go({ page: 'harnesses', item: undefined })}
          />
        )}
        {onSetup && <SetupNav page={place.page as SetupPage} onPage={goSetup} />}
        {place.page === 'roles' && <Roles {...setup('roles')} />}
        {place.page === 'workflows' && <Workflows {...setup('workflows')} onStartWith={workflow => setDialog({ kind: 'goal', workflow })} />}
        {place.page === 'rules' && <Rules {...setup('rules')} />}
        {place.page === 'guidelines' && <Guidelines config={config} onSave={saveConfig} />}
        {place.page === 'tools' && <Tools {...setup('tools')} />}
        {place.page === 'harnesses' && <Harnesses {...setup('harnesses')} />}
        {place.page === 'settings' && (
          <Settings
            config={config}
            onSave={saveConfig}
            onBuiltinRole={async (which, scope, exists) => {
              const name = config?.settings.effective[which] ?? which;
              const next = exists ? config : await saveConfig({ cmd: 'role.builtin', role: which, scope });
              const r = next?.roles.find(x => x.name === name);
              if (r) go({ page: 'roles', item: `${r.scope}/${r.name}` });
            }}
          />
        )}
        </ErrorBoundary>
      </main>

      {dialog?.kind === 'goal' && <StartGoalDialog key={`${dialog.workflow}/${dialog.from?.id}/${dialog.from?.action}`} config={config} initialWorkflow={dialog.workflow} initialRequest={dialog.request} from={dialog.from} onClose={() => setDialog(undefined)} onStart={startGoal} />}
      {dialog?.kind === 'room' && (
        <NewRoomDialog
          config={config}
          from={dialog.from}
          onClose={() => setDialog(undefined)}
          onStart={startGoal}
          onCommand={async b => {
            const r = await command(b);
            if ((r as { config?: ConfigView } | undefined)?.config) setConfig((r as { config: ConfigView }).config);
            return r;
          }}
        />
      )}
      {dialog?.kind === 'spawn' && goal && (
        <SpawnDialog
          config={config}
          goal={goal}
          parent={dialog.parent}
          onClose={() => setDialog(undefined)}
          onSpawn={async b => {
            const r = (await command(b)) as { agent?: string } | undefined;
            if (r?.agent) {
              setDialog(undefined);
              go({ agent: r.agent }, true);
            }
          }}
        />
      )}
      <AssistantPanel
        open={asking}
        project={projectId}
        onClose={() => setAsking(false)}
        onApplied={() => {
          loadConfig();
          void loadGoals();
          void refresh();
        }}
        context={[
          project ? `project ${project.name} (${project.dir})` : 'no project open',
          (onGoalPage || onRoomPage) && goal
            ? `${onRoomPage ? 'room' : 'goal'} ${goal.id} ("${goal.request.split('\n')[0].slice(0, 60)}")${place.agent ? `, agent ${place.agent}` : ''}${place.tab ? `, its ${place.tab} tab` : ''}`
            : place.page !== 'home' && place.page !== 'goal' && place.page !== 'room'
              ? `the ${place.page} page${place.item ? ` (${place.item})` : ''}`
              : undefined,
        ].filter(Boolean).join('; ')}
      />
      {toast}
    </div>
    </BeginnerContext.Provider>
  );
}

/** Setup's pages in their groups, across the top of each. */
function SetupNav({ page, onPage }: { page: SetupPage; onPage: (p: SetupPage) => void }) {
  const strip = useRef<HTMLElement>(null);
  // On a phone the strip scrolls sideways: the current page stays in view.
  useEffect(() => {
    strip.current?.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [page]);
  return (
    <nav className="setup-nav" aria-label="Setup" ref={strip}>
      {SETUP.map(([group, pages]) => (
        <span key={group} className="setup-group">
          <span className="setup-group-name">{group}</span>
          {pages.map(([p, label, title]) => (
            <button key={p} className={`tab${page === p ? ' on' : ''}`} title={title} aria-current={page === p ? 'page' : undefined} onClick={() => onPage(p)}>
              {label}
            </button>
          ))}
        </span>
      ))}
    </nav>
  );
}

function RailButton({ icon, label, on, badge, dot, disabled, onClick }: { icon: ReactNode; label: string; on?: boolean; badge?: number; dot?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`rail-btn${on ? ' on' : ''}`} onClick={onClick} disabled={disabled} aria-current={on ? 'page' : undefined} title={label}>
      <span className="rail-icon">
        {icon}
        {badge ? <span className="rail-badge">{badge}</span> : dot ? <span className="rail-dot" /> : null}
      </span>
      <span className="rail-label">{label}</span>
    </button>
  );
}

const svg = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);
const ICONS = {
  project: svg(<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />),
  home: svg(<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />),
  goal: svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" />
    </>,
  ),
  room: svg(
    <>
      <path d="M4 6h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.5V14H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" />
      <path d="M15 9.5h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1v2.5L16 17.5h-4a1 1 0 0 1-1-1V14" />
    </>,
  ),
  ask: svg(<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 10h.01M12 10h.01M15 10h.01" />),
  settings: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>,
  ),
};

function SignIn({ failed, onToken }: { failed: boolean; onToken: (t: string) => void }) {
  const [t, setT] = useState('');
  const hint = useMemo(() => (failed ? "That token doesn't match this daemon's." : 'This page needs the daemon’s token.'), [failed]);
  return (
    <div className="welcome">
      <h1>MetaHarness</h1>
      <p>
        {hint} The easiest way in is to run <code>mh ui</code>, which opens it for you. Or paste the token from <code>~/.metaharness/token</code>:
      </p>
      <input type="text" value={t} onChange={e => setT(e.target.value)} onKeyDown={e => e.key === 'Enter' && t.trim() && onToken(t)} placeholder="token" aria-label="Token" />
      <div>
        <button className="btn primary" disabled={!t.trim()} onClick={() => onToken(t)}>
          Continue
        </button>
      </div>
    </div>
  );
}
