import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';

interface DaemonInfo {
  startedAt: string;
  codeChangedAt?: string;
  stale: boolean;
  canRestart: boolean;
}

/**
 * When MetaHarness's code on disk is newer than the running daemon (after an update), says so and
 * offers to restart it. A daemon runs the code it started with, so until then the update does
 * nothing. Checked every minute and when the window comes back into focus.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<DaemonInfo>();
  const [state, setState] = useState<'idle' | 'restarting' | 'failed'>('idle');
  const [error, setError] = useState('');
  const check = useCallback(() => void api.command<DaemonInfo>({ cmd: 'daemon.info' }).then(setInfo, () => {}), []);
  useEffect(() => {
    check();
    const t = setInterval(check, 60_000);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', check);
    };
  }, [check]);

  const restart = async () => {
    if (!info) return;
    setState('restarting');
    try {
      await api.command({ cmd: 'daemon.restart' });
    } catch (e) {
      setError((e as Error).message);
      setState('failed');
      return;
    }
    // Back once a daemon that started later answers; then the page reloads to match it.
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const next = await api.command<DaemonInfo>({ cmd: 'daemon.info' }).catch(() => undefined);
      if (next && next.startedAt !== info.startedAt) {
        location.reload();
        return;
      }
    }
    setError('MetaHarness didn’t come back within a minute. Check the terminal where it runs.');
    setState('failed');
  };

  if (!info?.stale) return null;
  return (
    <div className="update-banner" role="status">
      <span>
        <b>MetaHarness was updated.</b> Restart it to use the new version
        {info.canRestart ? '. Agents in the middle of a task pause and pick up where they left off.' : ': stop it (Ctrl+C where it runs) and start it again with mh daemon.'}
      </span>
      {state === 'failed' && <span className="bad">{error}</span>}
      {info.canRestart && (
        <button className="btn small primary" disabled={state === 'restarting'} onClick={() => void restart()}>
          {state === 'restarting' ? 'Restarting…' : 'Restart now'}
        </button>
      )}
    </div>
  );
}
