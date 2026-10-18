import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, loadToken, setToken } from './api.ts';
import { useGoal } from './useGoal.ts';
import type { GoalSummary } from './types.ts';
import { Header } from './components/Header.tsx';
import { TeamTree } from './components/TeamTree.tsx';
import { Inbox } from './components/Inbox.tsx';
import { AgentDetail } from './components/AgentDetail.tsx';
import { SpawnDialog, StartGoalDialog } from './components/Dialogs.tsx';
import { useToast } from './components/common.tsx';
import { Activity } from './views/Activity.tsx';

// The flow views pull in React Flow; load them when first opened.
const Graph = lazy(() => import('./views/Graph.tsx'));
const Sequence = lazy(() => import('./views/Sequence.tsx'));
const Timeline = lazy(() => import('./views/Timeline.tsx'));

type Tab = 'activity' | 'graph' | 'sequence' | 'timeline';
const TABS: [Tab, string][] = [
  ['activity', 'Activity'],
  ['graph', 'Graph'],
  ['sequence', 'Sequence'],
  ['timeline', 'Timeline'],
];

/** Where you are, kept in the address so a reload or a shared link comes back to it. */
function readHash(): { goal?: string; agent?: string; tab?: Tab } {
  const p = new URLSearchParams(location.hash.slice(1));
  return { goal: p.get('goal') ?? undefined, agent: p.get('agent') ?? undefined, tab: (p.get('tab') as Tab) ?? undefined };
}

export function App() {
  const [token, setTok] = useState(() => loadToken());
  const [authFailed, setAuthFailed] = useState(false);
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const initial = useMemo(readHash, []);
  const [goalId, setGoalId] = useState<string | undefined>(initial.goal);
  const [agentName, setAgentName] = useState<string | undefined>(initial.agent);
  const [tab, setTab] = useState<Tab>(initial.tab ?? 'activity');
  const [dialog, setDialog] = useState<{ kind: 'goal' } | { kind: 'spawn'; parent?: string }>();
  const { toast, say } = useToast();

  const loadGoals = useCallback(async () => {
    try {
      const list = await api.goals();
      setGoals(list);
      setAuthFailed(false);
      setGoalId(id => id ?? (list.find(g => g.status === 'running') ?? list[0])?.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuthFailed(true);
    }
  }, []);
  useEffect(() => {
    if (!token) return;
    void loadGoals();
    const t = setInterval(() => void loadGoals(), 8000);
    return () => clearInterval(t);
  }, [token, loadGoals]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (goalId) p.set('goal', goalId);
    if (agentName) p.set('agent', agentName);
    if (tab !== 'activity') p.set('tab', tab);
    history.replaceState(null, '', `#${p}`);
  }, [goalId, agentName, tab]);

  const { snapshot, events, connected, error, refresh } = useGoal(token && !authFailed ? goalId : undefined);
  const goal = snapshot?.goals.find(g => g.id === goalId);
  const agent = goal?.agents.find(a => a.name === agentName) ?? goal?.agents.find(a => a.name === goal.lead);
  const inbox = useMemo(() => (snapshot?.inbox ?? []).filter(i => i.goal === goalId), [snapshot, goalId]);

  // A browser notification when something new needs you, if you've allowed them.
  const [seenInbox] = useState(() => new Set<string>());
  useEffect(() => {
    for (const i of inbox) {
      if (seenInbox.has(i.id)) continue;
      const first = seenInbox.size === 0 && inbox.length > 1;
      seenInbox.add(i.id);
      if (!first && document.hidden && 'Notification' in window && Notification.permission === 'granted' && ['approval', 'decision', 'question'].includes(i.kind)) {
        new Notification(`MetaHarness: ${i.agent}`, { body: i.text.slice(0, 200) });
      }
    }
  }, [inbox, seenInbox]);

  const command = useCallback(
    async (body: Record<string, unknown>, confirmText?: string) => {
      if (confirmText && !window.confirm(confirmText)) return undefined;
      try {
        const r = await api.command(body);
        if (typeof r.result === 'string' && body.cmd !== 'agent.message') say(r.result);
        void refresh();
        return r;
      } catch (e) {
        say((e as Error).message);
        return undefined;
      }
    },
    [refresh, say],
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

  return (
    <div className="app">
      <Header
        goals={goals}
        goal={goal}
        inboxCount={inbox.length}
        connected={connected}
        onPick={id => {
          setGoalId(id);
          setAgentName(undefined);
        }}
        onNewGoal={() => {
          if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
          setDialog({ kind: 'goal' });
        }}
        onSpawn={() => setDialog({ kind: 'spawn' })}
        onCommand={(b, c) => void command(b, c)}
      />
      {error && <div className="error-bar">{error}</div>}
      <div className="main">
        <aside className="col">
          <div className="section-title">Team</div>
          <div className="scroll">{goal ? <TeamTree goal={goal} selected={agent?.name} onSelect={setAgentName} /> : <div className="empty">{goals.length ? 'Pick a goal above.' : 'No goals yet. Start one with “New goal”.'}</div>}</div>
          <Inbox
            items={inbox}
            onResolve={(item, decision, reply) => void command({ cmd: 'inbox.resolve', item, decision, reply })}
            onSelectAgent={setAgentName}
          />
        </aside>

        <section className="col center">
          <nav className="tabs">
            {TABS.map(([t, label]) => (
              <button key={t} className={`tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </nav>
          {goal ? (
            <Suspense fallback={<div className="empty">Loading…</div>}>
              {tab === 'activity' && <Activity events={events} agents={goal.agents.map(a => a.name)} onSelectAgent={setAgentName} />}
              {tab === 'graph' && <Graph goal={goal} events={events} selected={agent?.name} onSelect={setAgentName} />}
              {tab === 'sequence' && <Sequence goal={goal} events={events} onSelect={setAgentName} />}
              {tab === 'timeline' && <Timeline goal={goal} events={events} onSelect={setAgentName} />}
            </Suspense>
          ) : (
            <div className="empty">No goal selected.</div>
          )}
        </section>

        <aside className="col">
          {goal && agent ? (
            <AgentDetail
              key={`${goal.id}/${agent.name}`}
              goal={goal}
              agent={agent}
              events={events}
              manifest={snapshot?.harnesses[agent.harness]}
              onCommand={command}
              onSpawnUnder={name => setDialog({ kind: 'spawn', parent: name })}
            />
          ) : (
            <div className="empty">Pick an agent to see what it's doing.</div>
          )}
        </aside>
      </div>

      {dialog?.kind === 'goal' && (
        <StartGoalDialog
          snapshot={snapshot}
          onClose={() => setDialog(undefined)}
          onStart={async b => {
            const r = (await command(b)) as { goal?: string } | undefined;
            if (r?.goal) {
              setDialog(undefined);
              setGoalId(r.goal);
              setAgentName(undefined);
              void loadGoals();
            }
          }}
        />
      )}
      {dialog?.kind === 'spawn' && goal && (
        <SpawnDialog
          snapshot={snapshot}
          goal={goal}
          parent={dialog.parent}
          onClose={() => setDialog(undefined)}
          onSpawn={async b => {
            const r = (await command(b)) as { agent?: string } | undefined;
            if (r?.agent) {
              setDialog(undefined);
              setAgentName(r.agent);
            }
          }}
        />
      )}
      {toast}
    </div>
  );
}

function SignIn({ failed, onToken }: { failed: boolean; onToken: (t: string) => void }) {
  const [t, setT] = useState('');
  return (
    <div className="welcome">
      <h1>MetaHarness</h1>
      <p>
        {failed ? "That token doesn't match this daemon's." : 'This page needs the daemon’s token.'} The easiest way in is to run <code>mh ui</code>, which opens it for you. Or paste the
        token from <code>~/.metaharness/token</code>:
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
