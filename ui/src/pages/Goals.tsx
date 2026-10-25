import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { ago, bytes, firstLine, money } from '../format.ts';
import type { ConfigView, GoalSummary } from '../types.ts';
import { useConfirm } from '../components/common.tsx';

interface Props {
  goals: GoalSummary[];
  /** Goals, or rooms: the list shows one kind at a time. */
  kind: 'goal' | 'room';
  loaded: boolean;
  config?: ConfigView;
  onKind: (k: 'goal' | 'room') => void;
  onNew: () => void;
  onOpen: (goal: string, tab?: 'story' | 'files') => void;
  onCommand: (b: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onChanged: () => void;
}

type Size = { id: string; bytes: number; known: boolean };
type Where = 'all' | 'here' | 'elsewhere';
type Sort = 'newest' | 'oldest' | 'largest' | 'cost';

/**
 * Every goal MetaHarness has, in any folder: open one, open its files, see what it keeps on
 * disk, and delete the ones you're done with (one or many at once).
 */
export function Goals({ goals, kind, loaded, config, onKind, onNew, onOpen, onCommand, onChanged }: Props) {
  const noun = kind === 'room' ? 'room' : 'goal';
  const confirm = useConfirm();
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [query, setQuery] = useState('');
  const [where, setWhere] = useState<Where>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const repo = config?.scopes.find(s => s.scope === 'repo')?.dir.replace(/[/\\]\.metaharness$/, '');
  const here = (g: GoalSummary) => !repo || g.dir === repo;

  const loadSizes = useCallback(async () => {
    try {
      const r = await api.command<{ sizes: Size[] }>({ cmd: 'goal.sizes' });
      setSizes(Object.fromEntries(r.sizes.map(s => [s.id, s])));
    } catch {
      // Sizes are a nicety; the list works without them.
    }
  }, []);
  useEffect(() => void loadSizes(), [loadSizes, goals.length]);

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    const list = goals.filter(g => (where === 'all' || (where === 'here') === here(g)) && (!q || `${g.request} ${g.result ?? ''} ${g.dir} ${g.id}`.toLowerCase().includes(q)));
    const by: Record<Sort, (a: GoalSummary, b: GoalSummary) => number> = {
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
      oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
      largest: (a, b) => (sizes[b.id]?.bytes ?? 0) - (sizes[a.id]?.bytes ?? 0),
      cost: (a, b) => (b.cost ?? 0) - (a.cost ?? 0),
    };
    return [...list].sort(by[sort]);
    // here() reads repo, which comes with config.
  }, [goals, query, where, sort, sizes, repo]);
  const orphans = Object.values(sizes).filter(s => !s.known);
  const total = Object.values(sizes).reduce((n, s) => n + s.bytes, 0);
  const deletable = (g: GoalSummary) => g.status !== 'running' || g.working === 0;
  const selected = shown.filter(g => picked.has(g.id));

  const toggle = (id: string) =>
    setPicked(p => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const remove = async (ids: string[], what: string) => {
    if (!ids.length) return;
    const size = ids.reduce((n, id) => n + (sizes[id]?.bytes ?? 0), 0);
    const ok = await confirm({
      title: `Delete ${what}?`,
      body: (
        <>
          <p>
            {ids.length > 1 ? 'Their' : 'Its'} shared files and their history, agents’ folders and the whole log go{size ? ` (${bytes(size)})` : ''}, and so do worktrees and branches whose work is merged. Commits on your branches stay.
          </p>
          <p>This can’t be undone.</p>
        </>
      ),
      confirm: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    let r = (await onCommand({ cmd: 'goal.delete', goals: ids })) as { deleted: string[]; kept: { goal: string; items: string[] }[]; refused: string[] } | undefined;
    if (r?.kept.length) {
      const items = r.kept.flatMap(k => k.items.map(i => `${label(k.goal)}: ${i}`));
      if (await confirm({ title: 'Some work was never saved', body: <><p>These hold uncommitted or unmerged work:</p><ul>{items.map(i => <li key={i} className="mono small">{i}</li>)}</ul><p>Delete them too? That work is lost.</p></>, confirm: 'Delete them too', danger: true })) {
        const again = (await onCommand({ cmd: 'goal.delete', goals: r.kept.map(k => k.goal), force: true })) as typeof r;
        if (again) r = { deleted: [...r.deleted, ...again.deleted], kept: again.kept, refused: [...r.refused, ...again.refused] };
      }
    }
    setBusy(false);
    setPicked(p => new Set([...p].filter(id => !r?.deleted.includes(id))));
    onChanged();
    void loadSizes();
    if (r?.refused.length) await confirm({ title: 'Not deleted', body: <ul>{r.refused.map(x => <li key={x}>{x}</li>)}</ul>, confirm: 'OK' });
  };
  const label = (id: string) => firstLine(goals.find(g => g.id === id)?.request).slice(0, 50) || id;

  return (
    <div className="page goals-page">
      <div className="page-head">
        <div>
          <h1>{kind === 'room' ? 'Rooms' : 'Goals'}</h1>
          <div className="muted intro">
            {kind === 'room'
              ? 'Every discussion room, from any folder. Open one to read its thread and board again, or start a new room from it; delete the ones you’re done with.'
              : 'Every goal MetaHarness has, from any folder. Open one to read its story, files and costs again; delete the ones you’re done with.'}
            {total > 0 && <> Goals and rooms keep {bytes(total)} on disk.</>}
          </div>
        </div>
        <div className="row">
          <span className="seg" role="group" aria-label="Show">
            <button className={`btn small${kind === 'goal' ? ' on' : ''}`} onClick={() => onKind('goal')}>
              Goals
            </button>
            <button className={`btn small${kind === 'room' ? ' on' : ''}`} onClick={() => onKind('room')}>
              Rooms
            </button>
          </span>
          <button className="btn primary" onClick={onNew}>
            New {noun}
          </button>
        </div>
      </div>

      <div className="goals-toolbar">
        <input type="search" className="search" placeholder="Search requests, outcomes, folders" value={query} onChange={e => setQuery(e.target.value)} />
        <select value={where} onChange={e => setWhere(e.target.value as Where)} aria-label="Folder">
          <option value="all">Every folder</option>
          <option value="here">This repository</option>
          <option value="elsewhere">Other folders</option>
        </select>
        <select value={sort} onChange={e => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="largest">Largest on disk</option>
          <option value="cost">Most spent</option>
        </select>
        <span className="spacer" />
        {selected.length > 0 && (
          <>
            <span className="muted small">{selected.length} selected</span>
            <button className="btn ghost small" onClick={() => setPicked(new Set())}>
              Clear
            </button>
            <button className="btn danger small" disabled={busy || !selected.every(deletable)} title={selected.every(deletable) ? '' : 'End the goals still at work first'} onClick={() => void remove(selected.map(g => g.id), `${selected.length} goal${selected.length > 1 ? 's' : ''}`)}>
              Delete selected
            </button>
          </>
        )}
      </div>

      <div className="goals-table" role="table">
        <div className="goals-row head" role="row">
          <span>
            <input
              type="checkbox"
              aria-label="Select every goal shown"
              checked={shown.length > 0 && shown.filter(deletable).every(g => picked.has(g.id))}
              onChange={e => setPicked(e.target.checked ? new Set(shown.filter(deletable).map(g => g.id)) : new Set())}
            />
          </span>
          <span>{kind === 'room' ? 'Room' : 'Goal'}</span>
          <span>Started</span>
          <span className="num">Agents</span>
          <span className="num">Cost</span>
          <span className="num">On disk</span>
          <span />
        </div>
        {shown.map(g => (
          <div key={g.id} className={`goals-row${picked.has(g.id) ? ' on' : ''}`} role="row">
            <span>
              <input type="checkbox" aria-label={`Select ${firstLine(g.request)}`} checked={picked.has(g.id)} disabled={!deletable(g)} onChange={() => toggle(g.id)} />
            </span>
            <button className="goals-title" onClick={() => onOpen(g.id)} title={g.request}>
              <span className="goals-title-top">
                <span className={`pill ${g.status}`}>{kind === 'room' && g.status === 'running' ? 'open' : g.status}</span>
                <span className="ellipsis">{firstLine(g.request)}</span>
              </span>
              <span className="muted small mono ellipsis">
                {g.id}
                {!here(g) ? ` · ${g.dir}` : ''}
                {g.workflow ? ` · ${g.workflow}` : ''}
              </span>
            </button>
            <span className="muted small" title={new Date(g.createdAt).toLocaleString()}>
              {ago(g.createdAt)}
            </span>
            <span className="num">{g.agents}</span>
            <span className="num">{money(g.cost)}</span>
            <span className="num muted">{sizes[g.id] ? bytes(sizes[g.id].bytes) : '—'}</span>
            <span className="goals-actions">
              <button className="btn ghost small" onClick={() => onOpen(g.id, 'files')} title="Its shared folder: designs, reviews, reports, with every version">
                Files
              </button>
              <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'goal.open_folder', goal: g.id })} title="Open its shared folder in your file manager">
                Folder
              </button>
              <button className="btn ghost small danger" disabled={busy || !deletable(g)} title={deletable(g) ? 'Delete this goal' : 'End it first: agents are still at work'} onClick={() => void remove([g.id], 'this goal')}>
                Delete
              </button>
            </span>
          </div>
        ))}
        {!shown.length && <div className="empty">{!loaded ? 'Loading…' : query || where !== 'all' ? `No ${noun} matches.` : `No ${noun}s yet.`}</div>}
      </div>

      {orphans.length > 0 && (
        <section>
          <h2 className="section-h">Folders without a goal</h2>
          <div className="muted small">Left in MetaHarness’s folder by goals the log no longer has.</div>
          <div className="goals-table">
            {orphans.map(o => (
              <div key={o.id} className="goals-row orphan">
                <span />
                <span className="mono">{o.id}</span>
                <span />
                <span />
                <span />
                <span className="num muted">{bytes(o.bytes)}</span>
                <span className="goals-actions">
                  <button className="btn ghost small danger" disabled={busy} onClick={() => void remove([o.id], `the folder ${o.id}`)}>
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
