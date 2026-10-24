import type { AgentDetail, CodeGraph, ConfigView, DesignChange, DesignScopeView, DesignView, DiffView, GitView, GoalSummary, MhEvent, ScopeSel, SharedFileView, Snapshot } from './types.ts';

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
  file: (goal: string, path: string, version?: number) =>
    call<SharedFileView>(`/file?goal=${encodeURIComponent(goal)}&path=${encodeURIComponent(path)}${version != null ? `&version=${version}` : ''}`),
  config: () => call<ConfigView>('/commands', { method: 'POST', body: JSON.stringify({ cmd: 'config.get' }) }),
  git: (goal: string) => call<GitView>(`/git?goal=${encodeURIComponent(goal)}`),
  /** One commit (sha), a range (from, to), the whole goal, or an agent's uncommitted work. */
  diff: (goal: string, q: { sha?: string; from?: string; to?: string; agent?: string; whole?: boolean; paths?: string[] }) => {
    const p = new URLSearchParams({ goal });
    for (const [k, v] of Object.entries(q)) {
      if (Array.isArray(v)) for (const x of v) p.append('path', x);
      else if (v) p.set(k, v === true ? '1' : String(v));
    }
    return call<DiffView>(`/diff?${p}`);
  },
  /** The design after a scope of work, what it changed, its commits and its report. */
  designScope: (goal: string, s: ScopeSel) => {
    const p = new URLSearchParams({ goal, kind: s.kind });
    if (s.kind === 'goal' && s.branches) p.set('branches', '1');
    if (s.kind === 'commit') p.set('sha', s.sha);
    if (s.kind === 'branch') p.set('agent', s.agent);
    if (s.kind === 'range') for (const [k, v] of [['from', s.from], ['to', s.to], ['title', s.title]]) p.set(k, v);
    return call<DesignScopeView>(`/design/scope?${p}`);
  },
  design: (goal: string, rev?: string) => call<DesignView>(`/design?goal=${encodeURIComponent(goal)}${rev ? `&rev=${encodeURIComponent(rev)}` : ''}`),
  designCompare: (goal: string, from: string, to: string) =>
    call<DesignChange>(`/design/compare?goal=${encodeURIComponent(goal)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  /** The code graph at a commit or tree (the Systems lens). */
  designCode: (goal: string, rev: string) => call<{ sha: string; graph: CodeGraph }>(`/design/code?goal=${encodeURIComponent(goal)}&rev=${encodeURIComponent(rev)}`),
  designSource: (goal: string, rev: string, path: string) =>
    call<{ path: string; sha: string; text: string }>(`/design/source?goal=${encodeURIComponent(goal)}&rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}`),
  command: <T = { result?: string }>(body: Record<string, unknown>) => call<T & Record<string, unknown>>('/commands', { method: 'POST', body: JSON.stringify(body) }),
};

/** Follows a goal's events from the start; reconnects by itself (EventSource) and never repeats one. */
export function followEvents(goal: string, onEvent: (e: MhEvent) => void, onStatus: (connected: boolean) => void, since = 0): () => void {
  let last = since;
  const es = new EventSource(`/events?goal=${encodeURIComponent(goal)}&since=${since}&token=${encodeURIComponent(current)}`);
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
