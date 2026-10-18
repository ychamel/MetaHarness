import type { AgentDetail, GoalSummary, MhEvent, Snapshot } from './types.ts';

/**
 * The daemon's API (design §13). `mh ui` opens the app with ?token=…; it's kept in this
 * browser's storage for the daemon's origin and taken out of the address bar.
 */
const KEY = 'metaharness-token';
let current = '';

export function loadToken(): string {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    url.searchParams.delete('token');
    history.replaceState(null, '', url);
    setToken(fromUrl);
    return fromUrl;
  }
  try {
    current = localStorage.getItem(KEY) ?? '';
  } catch {
    current = '';
  }
  return current;
}

export function setToken(t: string): void {
  current = t.trim();
  try {
    localStorage.setItem(KEY, current);
  } catch {
    /* private window: it lasts for this page */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { ...init, headers: { authorization: `Bearer ${current}`, 'content-type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(body.error ?? r.statusText, r.status);
  return body as T;
}

export const api = {
  state: (goal?: string) => call<Snapshot>(`/state${goal ? `?goal=${encodeURIComponent(goal)}` : ''}`),
  goals: () => call<{ goals: GoalSummary[] }>('/goals').then(r => r.goals),
  agent: (goal: string, name: string) => call<AgentDetail>(`/agent?goal=${encodeURIComponent(goal)}&name=${encodeURIComponent(name)}`),
  command: <T = { result?: string }>(body: Record<string, unknown>) => call<T & Record<string, unknown>>('/commands', { method: 'POST', body: JSON.stringify(body) }),
};

/** Follows a goal's events from the start; reconnects by itself (EventSource) and never repeats one. */
export function followEvents(goal: string, onEvent: (e: MhEvent) => void, onStatus: (connected: boolean) => void): () => void {
  let last = 0;
  const es = new EventSource(`/events?goal=${encodeURIComponent(goal)}&since=0&token=${encodeURIComponent(current)}`);
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  es.onmessage = m => {
    const e = JSON.parse(m.data) as MhEvent;
    if (e.seq <= last) return;
    last = e.seq;
    onEvent(e);
  };
  return () => es.close();
}
