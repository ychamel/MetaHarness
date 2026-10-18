import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, loadToken, setToken } from './api.ts';
import { useGoal } from './useGoal.ts';
import type { ConfigView, GoalSummary } from './types.ts';
import { SpawnDialog, StartGoalDialog } from './components/Dialogs.tsx';
import { ConfirmProvider, useToast } from './components/common.tsx';
import { Home } from './pages/Home.tsx';
import { GoalPage, type GoalTab } from './pages/GoalPage.tsx';
import { Harnesses } from './pages/Harnesses.tsx';
import { Settings } from './pages/Settings.tsx';
import { Roles } from './pages/Roles.tsx';
import { Workflows } from './pages/Workflows.tsx';
import { Guidelines } from './pages/Guidelines.tsx';
import { Tools } from './pages/Tools.tsx';

type Page = 'home' | 'goal' | 'roles' | 'workflows' | 'guidelines' | 'tools' | 'harnesses' | 'settings';

/** Where you are, kept in the address so a reload or a shared link comes back to it. */
interface Place {
  page: Page;
  goal?: string;
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
  return { page, goal: get('goal'), agent: get('agent'), tab: get('tab') as GoalTab, file: get('file'), item: get('item') };
}

function writeHash(pl: Place): string {
  const p = new URLSearchParams();
  p.set('page', pl.page);
  for (const k of ['goal', 'agent', 'tab', 'file', 'item'] as const) if (pl[k]) p.set(k, pl[k]!);
  return `#${p}`;
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
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<ConfigView>();
  const [place, setPlace] = useState<Place>(readHash);
  const [dialog, setDialog] = useState<{ kind: 'goal'; workflow?: string } | { kind: 'spawn'; parent?: string }>();
  const { toast, say } = useToast();

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
      if (hash !== location.hash) (replace ? history.replaceState : history.pushState).call(history, null, '', hash);
      return pl;
    });
  }, []);

  const loadGoals = useCallback(async () => {
    try {
      setGoals(await api.goals());
      setLoaded(true);
      setAuthFailed(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthFailed(true);
    }
  }, []);
  const loadConfig = useCallback(() => void api.config().then(setConfig, () => {}), []);
  useEffect(() => {
    if (!token) return;
    void loadGoals();
    loadConfig();
    const t = setInterval(() => void loadGoals(), 4000);
    return () => clearInterval(t);
  }, [token, loadGoals, loadConfig]);

  // The goal page opens on the running goal, or the latest one.
  const goalId = place.goal ?? (goals.find(g => g.status === 'running') ?? goals[0])?.id;
  const onGoalPage = place.page === 'goal';
  const { snapshot, events, connected, error, refresh } = useGoal(token && !authFailed && onGoalPage ? goalId : undefined);
  const goal = snapshot?.goals.find(g => g.id === goalId);

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
  useEffect(() => void (seenSeq.current = undefined), [goalId]);

  const command = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const r = await api.command(body);
        if (typeof r.result === 'string' && !['agent.message', 'inbox.resolve'].includes(String(body.cmd))) say(r.result);
        if (body.cmd === 'agent.message') say('Sent.');
        void refresh();
        void loadGoals();
        return r as Record<string, unknown>;
      } catch (e) {
        say((e as Error).message);
        return undefined;
      }
    },
    [refresh, say, loadGoals],
  );

  const saveConfig = useCallback(
    async (body: Record<string, unknown>) => {
      const r = (await command(body)) as { config?: ConfigView } | undefined;
      if (r?.config) setConfig(r.config);
      return r?.config;
    },
    [command],
  );

  const startGoal = useCallback(
    async (b: Record<string, unknown>) => {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
      const r = (await command(b)) as { goal?: string } | undefined;
      if (!r?.goal) return false;
      setDialog(undefined);
      go({ page: 'goal', goal: r.goal, agent: undefined, tab: 'story', file: undefined });
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

  const current = goals.find(g => g.id === goalId);
  const setup = (page: Page) => ({ selected: place.page === page ? place.item : undefined, onSelect: (item?: string) => go({ item }), onSave: saveConfig, onCommand: command, config });

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="rail-brand" title="MetaHarness">
          <svg viewBox="0 0 16 16" aria-hidden>
            <circle cx="4" cy="8" r="3" fill="var(--accent)" />
            <circle cx="12" cy="4" r="2.5" fill="var(--done)" />
            <circle cx="12" cy="12" r="2.5" fill="var(--waiting)" />
          </svg>
        </div>
        <RailButton icon={ICONS.home} label="Home" on={place.page === 'home'} badge={needs} onClick={() => go({ page: 'home', item: undefined })} />
        <RailButton icon={ICONS.goal} label="Goal" on={onGoalPage} dot={current?.status === 'running'} disabled={!goals.length} onClick={() => go({ page: 'goal', goal: goalId, item: undefined })} />
        <RailButton icon={ICONS.plus} label="New goal" onClick={() => setDialog({ kind: 'goal' })} />
        <div className="rail-sep" />
        <div className="rail-group">Setup</div>
        <RailButton icon={ICONS.roles} label="Roles" on={place.page === 'roles'} onClick={() => go({ page: 'roles', item: undefined })} />
        <RailButton icon={ICONS.workflows} label="Workflows" on={place.page === 'workflows'} onClick={() => go({ page: 'workflows', item: undefined })} />
        <RailButton icon={ICONS.guide} label="Guidelines" on={place.page === 'guidelines'} onClick={() => go({ page: 'guidelines', item: undefined })} />
        <RailButton icon={ICONS.tools} label="Tools" on={place.page === 'tools'} onClick={() => go({ page: 'tools', item: undefined })} />
        <RailButton icon={ICONS.harness} label="Harnesses" on={place.page === 'harnesses'} onClick={() => go({ page: 'harnesses', item: undefined })} />
        <RailButton icon={ICONS.settings} label="Settings" on={place.page === 'settings'} onClick={() => go({ page: 'settings', item: undefined })} />
      </nav>

      <main className="content">
        {error && onGoalPage && <div className="error-bar">{error}</div>}
        {place.page === 'home' && (
          <Home goals={goals} loaded={loaded} config={config} onOpen={(g, agent) => go({ page: 'goal', goal: g, agent, tab: place.tab ?? 'story', file: undefined })} onStart={startGoal} onCommand={command} onSetup={() => go({ page: 'roles', item: 'new' })} />
        )}
        {onGoalPage && (
          <GoalPage
            goals={goals}
            loaded={loaded}
            goal={goal}
            snapshot={snapshot}
            events={events}
            connected={connected}
            agentName={place.agent}
            tab={place.tab ?? 'story'}
            file={place.file}
            onTab={tab => go({ tab }, true)}
            onFile={file => go({ file }, true)}
            onAgent={agent => go({ agent }, true)}
            onGoal={g => go({ goal: g, agent: undefined, file: undefined })}
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
        {place.page === 'roles' && <Roles {...setup('roles')} />}
        {place.page === 'workflows' && <Workflows {...setup('workflows')} onStartWith={workflow => setDialog({ kind: 'goal', workflow })} />}
        {place.page === 'guidelines' && <Guidelines config={config} onSave={saveConfig} />}
        {place.page === 'tools' && <Tools {...setup('tools')} />}
        {place.page === 'harnesses' && <Harnesses {...setup('harnesses')} />}
        {place.page === 'settings' && (
          <Settings
            config={config}
            onSave={saveConfig}
            onGatekeeper={async (scope, exists) => {
              const name = config?.settings.effective.gatekeeper ?? 'gatekeeper';
              const next = exists ? config : await saveConfig({ cmd: 'gatekeeper.create', scope });
              const r = next?.roles.find(x => x.name === name);
              if (r) go({ page: 'roles', item: `${r.scope}/${r.name}` });
            }}
          />
        )}
      </main>

      {dialog?.kind === 'goal' && <StartGoalDialog key={dialog.workflow} config={config} initialWorkflow={dialog.workflow} onClose={() => setDialog(undefined)} onStart={startGoal} />}
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
      {toast}
    </div>
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
  home: svg(<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />),
  goal: svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" />
    </>,
  ),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  roles: svg(
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M16 14.2c2.2.2 3.8 1.8 4.5 4.3" />
    </>,
  ),
  workflows: svg(
    <>
      <rect x="3" y="4" width="6" height="5" rx="1" />
      <rect x="15" y="4" width="6" height="5" rx="1" />
      <rect x="9" y="15" width="6" height="5" rx="1" />
      <path d="M9 6.5h6M18 9v3H12v3" />
    </>,
  ),
  guide: svg(
    <>
      <path d="M5 4h10l4 4v12H5z" />
      <path d="M8 11h8M8 15h8M8 7h4" />
    </>,
  ),
  tools: svg(<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z" />),
  harness: svg(
    <>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M8 20h8M12 16v4M7.5 9.5l2 1.5-2 1.5M11.5 12.5h4" />
    </>,
  ),
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
