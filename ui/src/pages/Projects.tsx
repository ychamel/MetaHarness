import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { ago } from '../format.ts';
import type { FolderSetup, FolderView, OpenResult, ProjectSummary } from '../types.ts';
import { Dialog, useConfirm } from '../components/common.tsx';

interface Props {
  projects: ProjectSummary[];
  loaded: boolean;
  current?: string;
  onPick: (id: string) => void;
  onCommand: (b: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  onChanged: () => void;
}

/**
 * The projects: folders you opened, like folders opened in an editor (design §22). Pick one to
 * work in, open another folder on the daemon's machine, or start a new one. Each project's goals
 * and rooms work in it and nowhere else.
 */
export function Projects({ projects, loaded, current, onPick, onCommand, onChanged }: Props) {
  const confirm = useConfirm();
  const [browsing, setBrowsing] = useState(false);
  const opened = projects.filter(p => p.opened);
  const past = projects.filter(p => !p.opened && p.exists);

  /** Opens a folder; one with its own setup is shown to you first. */
  const open = useCallback(
    async (b: Record<string, unknown>) => {
      let r = (await onCommand(b)) as OpenResult | undefined;
      if (r?.needsTrust && r.setup) {
        const ok = await confirm({ title: 'Trust this folder?', body: <TrustBody dir={r.dir ?? ''} setup={r.setup} />, confirm: 'Trust and open' });
        if (!ok) return false;
        r = (await onCommand({ cmd: 'project.open', dir: r.dir, trust: true })) as OpenResult | undefined;
      }
      if (!r?.project) return false;
      const n = r.nested;
      if (n?.inside || n?.contains.length) {
        await confirm({
          title: 'A project inside a project',
          body: n.inside ? (
            <>This folder is inside <span className="mono">{n.inside}</span>. Agents working there can read this folder; agents here can't read the rest of it.</>
          ) : (
            <>This folder holds other projects ({n.contains.map(c => <span key={c} className="mono">{c} </span>)}). Agents working here are kept out of them.</>
          ),
          confirm: 'OK',
        });
      }
      onChanged();
      onPick(r.project.id);
      return true;
    },
    [confirm, onCommand, onChanged, onPick],
  );

  return (
    <div className="page projects">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <div className="muted intro">
            A project is a folder on {location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? 'this machine' : "the daemon's machine"}. Its goals and rooms work in it and nowhere else, and it can keep its own setup in a <span className="mono">.metaharness</span> folder. Several can run at once.
          </div>
        </div>
        <div className="row end">
          <button className="btn primary" onClick={() => setBrowsing(true)}>
            Open folder…
          </button>
        </div>
      </div>

      <div className="goal-cards">
        {opened.map(p => (
          <ProjectCard key={p.id} p={p} current={p.id === current} onPick={() => onPick(p.id)} onForget={async () => {
            if (await confirm({ title: `Take ${p.name} off the list?`, body: 'Its goals and files stay; open the folder again to come back to it.', confirm: 'Take it off' })) {
              await onCommand({ cmd: 'project.forget', project: p.id });
              onChanged();
            }
          }} />
        ))}
      </div>
      {loaded && !opened.length && (
        <div className="empty big">
          <div>Open a folder to start: a repository to work on, or an empty folder for something new.</div>
          <button className="btn primary" onClick={() => setBrowsing(true)}>
            Open folder…
          </button>
          <div className="muted small">
            From a terminal: <span className="mono">mh project</span> in the folder. To clone a repository, ask the assistant.
          </div>
        </div>
      )}

      {past.length > 0 && (
        <section>
          <h2 className="section-h">Where past goals worked</h2>
          <div className="goal-rows">
            {past.map(p => (
              <div key={p.id} className="goal-row" role="button" tabIndex={0} onClick={() => void open({ cmd: 'project.open', dir: p.dir })} onKeyDown={e => e.key === 'Enter' && void open({ cmd: 'project.open', dir: p.dir })}>
                <div className="goal-row-top">
                  <span className="goal-row-title">{p.name}</span>
                  <span className="muted small mono ellipsis">{p.dir}</span>
                  <span className="spacer" />
                  <span className="muted small">{count(p.goals, 'goal')}{p.lastAt ? ` · ${ago(p.lastAt)}` : ''}</span>
                  <span className="btn small">Open</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {browsing && <FolderBrowser onClose={() => setBrowsing(false)} onOpen={async b => (await open(b)) && setBrowsing(false)} />}
    </div>
  );
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

function ProjectCard({ p, current, onPick, onForget }: { p: ProjectSummary; current: boolean; onPick: () => void; onForget: () => void }) {
  return (
    <div className={`goal-card project-card${current ? ' current' : ''}`} role="button" tabIndex={0} onClick={onPick} onKeyDown={e => e.key === 'Enter' && onPick()}>
      <div className="goal-card-top">
        {p.running > 0 && <span className="pill running">{p.running} running</span>}
        {p.needs > 0 && <span className="badge warn" title="Waiting for you">{p.needs}</span>}
        {!p.exists && <span className="pill warn">folder gone</span>}
        {current && <span className="pill">open</span>}
        <span className="spacer" />
        <button className="btn ghost small" title="Take it off the list" onClick={e => (e.stopPropagation(), onForget())}>
          ×
        </button>
      </div>
      <div className="goal-card-title">{p.name}</div>
      <div className="muted small mono ellipsis" title={p.dir}>{p.dir}</div>
      <div className="muted small">
        {[count(p.goals, 'goal'), p.rooms ? count(p.rooms, 'room') : '', p.git ? '' : 'no git', p.lastAt ? `last ${ago(p.lastAt)}` : ''].filter(Boolean).join(' · ')}
      </div>
    </div>
  );
}

function TrustBody({ dir, setup }: { dir: string; setup: FolderSetup }) {
  const lists: [string, string[]][] = [['Roles', setup.roles], ['Workflows', setup.workflows], ['Rules', setup.rules], ['Harness profiles', setup.harnesses]];
  return (
    <>
      <p>
        <span className="mono">{dir}</span> has its own MetaHarness setup. Agents working there use it, and its MCP servers and harness profiles run programs on this machine.
      </p>
      <ul>
        {lists.filter(([, l]) => l.length).map(([what, l]) => (
          <li key={what}>
            {what}: {l.join(', ')}
          </li>
        ))}
        {setup.mcp.map(m => (
          <li key={m.name}>
            MCP server {m.name}: runs <span className="mono">{m.command}</span>
          </li>
        ))}
      </ul>
      <p>Trust it if you know where it comes from.</p>
    </>
  );
}

/** The daemon's folders, one at a time: go into one, open it as a project, or make a new one here. */
export function FolderBrowser({ onClose, onOpen }: { onClose: () => void; onOpen: (b: Record<string, unknown>) => Promise<unknown> }) {
  const [view, setView] = useState<FolderView>();
  const [typed, setTyped] = useState('');
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState('');
  const go = useCallback(
    async (path?: string) => {
      try {
        const v = await api.browse(path, hidden);
        setView(v);
        setTyped(v.path);
        setError(undefined);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [hidden],
  );
  useEffect(() => void go(view?.path), [hidden]); // eslint-disable-line react-hooks/exhaustive-deps
  const sep = view?.path.includes('\\') && !view.path.includes('/') ? '\\' : '/';
  const crumbs = view ? view.path.split(sep).filter(Boolean) : [];

  return (
    <Dialog title="Open folder" onClose={onClose} wide>
      <div className="folder-path">
        <input
          type="text"
          className="mono"
          value={typed}
          onChange={e => setTyped(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void go(typed.trim())}
          aria-label="Folder"
          placeholder="/path/to/folder"
        />
        <button className="btn small" onClick={() => void go(typed.trim())}>
          Go
        </button>
      </div>
      {view && (
        <div className="crumbs small">
          <button className="btn ghost small" onClick={() => void go(view.home)} title={view.home}>
            ~
          </button>
          {sep === '/' && (
            <button className="btn ghost small" onClick={() => void go('/')}>
              /
            </button>
          )}
          {crumbs.map((c, i) => (
            <button key={i} className="btn ghost small" onClick={() => void go((sep === '/' ? '/' : '') + crumbs.slice(0, i + 1).join(sep))}>
              {c}
            </button>
          ))}
        </div>
      )}
      {error && <div className="error-bar">{error}</div>}
      <div className="folder-list">
        {view?.parent && (
          <div className="folder-row" role="button" tabIndex={0} onClick={() => void go(view.parent!)} onKeyDown={e => e.key === 'Enter' && void go(view.parent!)}>
            <span className="folder-name">..</span>
          </div>
        )}
        {view?.dirs.map(d => (
          <div key={d.path} className="folder-row" role="button" tabIndex={0} onClick={() => void go(d.path)} onKeyDown={e => e.key === 'Enter' && void go(d.path)}>
            <span className="folder-name">{d.name}</span>
            {d.git && <span className="pill">git</span>}
            {d.setup && <span className="pill decision">.metaharness</span>}
            {d.project && <span className="pill done">project</span>}
            <span className="spacer" />
            <button className="btn small" onClick={e => (e.stopPropagation(), void onOpen({ cmd: 'project.open', dir: d.path }))}>
              Open
            </button>
          </div>
        ))}
        {view && !view.dirs.length && <div className="empty">No folders here.</div>}
      </div>
      <div className="row between">
        <label className="check small">
          <input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} /> Hidden folders
        </label>
        <span className="spacer" />
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="new-folder" aria-label="New folder name" className="new-folder" />
        <button
          className="btn"
          disabled={!view || !name.trim()}
          title="Make the folder here, with a git repository, and open it"
          onClick={() => view && void onOpen({ cmd: 'project.create', dir: `${view.path}${view.path.endsWith(sep) ? '' : sep}${name.trim()}` })}
        >
          New project
        </button>
        <button className="btn primary" disabled={!view} onClick={() => view && void onOpen({ cmd: 'project.open', dir: view.path })}>
          Open this folder
        </button>
      </div>
    </Dialog>
  );
}
