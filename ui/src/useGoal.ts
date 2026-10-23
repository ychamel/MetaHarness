import { useCallback, useEffect, useRef, useState } from 'react';
import { api, followEvents } from './api.ts';
import type { MhEvent, Snapshot } from './types.ts';

/** Events that change what /state shows: the snapshot is fetched again after them (at most a few times a second). */
const CHANGES = /^(agent\.|inbox\.|goal\.|usage|account\.|message\.delivered|git\.)/;

/**
 * One goal, live: the snapshot from /state, plus every event from /events for the streams and
 * views. The snapshot is refetched when events say something changed, so nothing is folded twice.
 */
export function useGoal(goalId: string | undefined) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [events, setEvents] = useState<MhEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const buffer = useRef<MhEvent[]>([]);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.state(goalId));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [goalId]);

  useEffect(() => {
    setEvents([]);
    buffer.current = [];
    void refresh();
    if (!goalId) return;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const add = buffer.current;
      buffer.current = [];
      if (!add.length) return;
      // A respawned agent's name passed to its replacement: its events so far, and messages sent to it, go by the new name (as in the log).
      const renames = add.filter(e => e.type === 'agent.renamed');
      setEvents(prev => {
        let all = prev.concat(add);
        for (const r of renames) {
          const { from, to } = r.data as { from: string; to: string };
          all = all.map(e =>
            e.seq > r.seq ? e
            : e.agent === from ? { ...e, agent: to }
            : e.type === 'message.sent' && e.data.to === from ? { ...e, data: { ...e.data, to } }
            : e,
          );
        }
        return all;
      });
    };
    const stop = followEvents(
      goalId,
      e => {
        buffer.current.push(e);
        frame ||= requestAnimationFrame(flush);
        if (CHANGES.test(e.type) && timer.current === undefined) {
          timer.current = window.setTimeout(() => {
            timer.current = undefined;
            void refresh();
          }, 250);
        }
      },
      setConnected,
    );
    // A slow refresh as well, for what no event marks (rate-limit countdowns and the like).
    const slow = window.setInterval(() => void refresh(), 10_000);
    return () => {
      stop();
      cancelAnimationFrame(frame);
      window.clearInterval(slow);
      window.clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [goalId, refresh]);

  return { snapshot, events, connected, error, refresh };
}
