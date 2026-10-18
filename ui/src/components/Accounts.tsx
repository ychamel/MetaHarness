import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { ago } from '../format.ts';
import type { Account, LimitCheck, Snapshot } from '../types.ts';
import { useNow } from './common.tsx';

/** Everything loaded on the daemon (all goals' Inbox items and the accounts), refreshed every few seconds. */
export function useOverview(ms = 4000) {
  const [snap, setSnap] = useState<Snapshot>();
  useEffect(() => {
    let alive = true;
    const load = () => void api.state().then(s => alive && setSnap(s), () => {});
    load();
    const t = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ms]);
  return snap;
}

/** "in 12 min", "in 3 h 05", or the day and time for a reset further off. */
export function resetsIn(ts: number, now = Date.now()): string {
  const ms = ts - now;
  if (ms <= 0) return 'reset due';
  if (ms < 3_600_000) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 86_400_000) return `in ${Math.floor(ms / 3_600_000)} h ${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}`;
  return new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** The harness an account belongs to: codex, or antigravity for antigravity:gemini. */
export const harnessOf = (account: string) => account.split(':')[0];

/** The windows to show: what the last check found, or the one window a turn reported. Shortest first. */
function windowsOf(a: Account) {
  const ws = a.windows?.length ? a.windows : a.usedPct != null ? [{ name: a.window ?? 'limit', usedPct: a.usedPct, resetsAt: a.resetsAt ?? undefined }] : [];
  return ws.slice().sort((x, y) => x.name.localeCompare(y.name));
}

const level = (pct: number) => (pct >= 100 ? 'full' : pct >= 90 ? 'high' : '');

/** One account: each window of its plan with how much is used and when it resets. */
export function AccountCard({ account: a, title }: { account: Account; title?: string }) {
  const now = useNow(30_000);
  const ws = windowsOf(a);
  return (
    <div className={`account ${a.status}`}>
      <div className="account-head">
        <b>{title ?? a.id}</b>
        {a.status !== 'ok' && <span className={`pill ${a.status === 'limited' ? 'urgent' : 'waiting'}`}>{a.status === 'limited' ? 'at its limit' : 'near its limit'}</span>}
        {a.checkedAt && <span className="muted small">checked {ago(a.checkedAt)}</span>}
      </div>
      {ws.map(w => (
        <div key={w.name} className="window">
          <span className="window-name">{w.name}</span>
          <span className={`meter ${level(w.usedPct)}`} title={`${w.usedPct}% used`}>
            <i style={{ width: `${Math.min(100, w.usedPct)}%` }} />
          </span>
          <span className="window-pct">{w.usedPct}%</span>
          <span className="muted small">{w.resetsAt ? `resets ${resetsIn(w.resetsAt, now)}` : ''}</span>
        </div>
      ))}
      {!ws.length && <span className="muted small">No usage reported yet.</span>}
      {a.note && <div className="muted small">{a.note}</div>}
    </div>
  );
}

/** Accounts with a button to ask the harnesses again, and any harness that couldn't say. */
export function AccountList({ accounts, checks, onCheck, empty }: { accounts: Account[]; checks: LimitCheck[]; onCheck?: () => Promise<unknown>; empty?: string }) {
  const [checking, setChecking] = useState(false);
  const failed = checks.filter(c => c.error);
  return (
    <div className="accounts">
      {accounts
        .slice()
        .sort((x, y) => x.id.localeCompare(y.id))
        .map(a => (
          <AccountCard key={a.id} account={a} />
        ))}
      {!accounts.length && <div className="muted small">{empty ?? 'No harness has reported its limits yet.'}</div>}
      {failed.map(c => (
        <div key={c.harness} className="warn-text small">
          Couldn’t read {c.harness}’s limits: {c.error}
        </div>
      ))}
      {onCheck && (
        <div className="row actions">
          <button
            className="btn small"
            disabled={checking || checks.some(c => c.checking)}
            onClick={() => {
              setChecking(true);
              void onCheck().finally(() => setChecking(false));
            }}
          >
            {checking || checks.some(c => c.checking) ? 'Checking…' : 'Check now'}
          </button>
          <span className="muted small">Asks each harness without running a turn: it costs nothing.</span>
        </div>
      )}
    </div>
  );
}

/** One chip per account, for a page header: its fullest window, the rest on hover. */
export function AccountChips({ accounts }: { accounts: Account[] }) {
  const now = useNow(30_000);
  return (
    <>
      {accounts.map(a => {
        const ws = windowsOf(a);
        const top = ws.slice().sort((x, y) => y.usedPct - x.usedPct)[0];
        if (!top) return null;
        const tip = ws.map(w => `${w.name}: ${w.usedPct}% used${w.resetsAt ? `, resets ${resetsIn(w.resetsAt, now)}` : ''}`).join('\n') + (a.note ? `\n${a.note}` : '');
        return (
          <span key={a.id} className={`account-chip ${a.status} ${level(top.usedPct)}`} title={tip}>
            {a.id} <b>{top.usedPct}%</b> <span className="muted">{top.name}</span>
          </span>
        );
      })}
    </>
  );
}
