import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { ago, who } from '../format.ts';
import type { Goal, MhEvent, SharedFileView } from '../types.ts';
import { CopyText, Markdown } from '../components/common.tsx';
import { Splitter } from '../components/Splitter.tsx';

interface FileInfo {
  path: string;
  version: number;
  owner?: string;
  lastBy?: string;
  ts: string;
  deleted: boolean;
  clashes: number;
}

/** The shared folder as the event log knows it: every file, its latest version, who owns and last wrote it. */
function filesOf(events: MhEvent[]): FileInfo[] {
  const files = new Map<string, FileInfo>();
  for (const e of events) {
    if (!e.type.startsWith('shared.')) continue;
    const path = String(e.data.path);
    const f = files.get(path) ?? { path, version: 0, ts: e.ts, deleted: false, clashes: 0 };
    if (e.type === 'shared.write') {
      f.version = Number(e.data.version) || f.version + 1;
      f.lastBy = e.agent;
      f.owner ??= e.agent;
      f.ts = e.ts;
      f.deleted = false;
    } else if (e.type === 'shared.delete') {
      f.deleted = true;
      f.ts = e.ts;
    } else if (e.type === 'shared.clash') f.clashes++;
    files.set(path, f);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function Files({ goal, events, selected, onSelect, onSelectAgent }: { goal: Goal; events: MhEvent[]; selected?: string; onSelect: (path: string) => void; onSelectAgent: (n: string) => void }) {
  const files = useMemo(() => filesOf(events), [events]);
  const current = files.find(f => f.path === selected) ?? files.find(f => !f.deleted && /report|design/i.test(f.path)) ?? files[0];
  return (
    <div className="files">
      <div className="file-list">
        <div className="file-list-head">
          <span className="muted">shared/</span>
          <span className="muted">{files.length} files</span>
        </div>
        {files.map(f => (
          <button key={f.path} className={`file-row${current?.path === f.path ? ' on' : ''}${f.deleted ? ' deleted' : ''}`} onClick={() => onSelect(f.path)}>
            <span className="path">{f.path}</span>
            <span className="sub">
              v{f.version} · {who(f.lastBy) || 'someone'} · {ago(f.ts)}
              {f.clashes > 0 && <span className="warn-text"> · {f.clashes} clash{f.clashes > 1 ? 'es' : ''}</span>}
            </span>
          </button>
        ))}
        {!files.length && <div className="empty">Nobody has written to the shared folder yet. Designs, reviews and reports land here.</div>}
      </div>
      <Splitter pane="files" grow="right" min={160} max={700} label="File list" />
      <div className="file-view">{current ? <Viewer key={current.path} goal={goal} file={current} onSelectAgent={onSelectAgent} /> : <div className="empty">Pick a file.</div>}</div>
    </div>
  );
}

function Viewer({ goal, file, onSelectAgent }: { goal: Goal; file: FileInfo; onSelectAgent: (n: string) => void }) {
  const [version, setVersion] = useState<number>();
  const [view, setView] = useState<SharedFileView>();
  const [error, setError] = useState<string>();
  const [raw, setRaw] = useState(false);
  const md = /\.(md|markdown|txt)$/i.test(file.path);
  useEffect(() => {
    let alive = true;
    api.file(goal.id, file.path, version).then(
      v => alive && (setView(v), setError(undefined)),
      e => alive && setError((e as Error).message),
    );
    return () => {
      alive = false;
    };
    // A new version reloads the latest.
  }, [goal.id, file.path, version, version === undefined ? file.version : 0]);

  return (
    <>
      <div className="file-head">
        <div className="file-title">
          <b className="mono">{file.path}</b>
          <span className="muted">
            {file.owner && (
              <>
                owner{' '}
                <button className="name-link" onClick={() => onSelectAgent(file.owner!)}>
                  {file.owner}
                </button>
              </>
            )}
            {file.deleted && ' · deleted'}
          </span>
        </div>
        <div className="row">
          {view && view.versions.length > 1 && (
            <select value={version ?? ''} onChange={e => setVersion(e.target.value ? Number(e.target.value) : undefined)} aria-label="Version">
              <option value="">Latest (v{file.version})</option>
              {[...view.versions].reverse().map(v => (
                <option key={v.version} value={v.version}>
                  v{v.version} by {who(v.by)}
                </option>
              ))}
            </select>
          )}
          {md && (
            <button className={`btn small${raw ? ' on' : ''}`} onClick={() => setRaw(r => !r)}>
              {raw ? 'Rendered' : 'Source'}
            </button>
          )}
        </div>
      </div>
      <div className="scroll file-body">
        {error && <div className="error-text">{error}</div>}
        {view && !view.exists && <div className="empty">This file isn't there any more{view.versions.length ? '; pick a kept version above.' : '.'}</div>}
        {view?.binary && <div className="empty">This isn't a text file ({Math.round(view.size / 1024)} KB).</div>}
        {view?.text != null && (md && !raw ? <Markdown text={view.text} className="doc" /> : <pre className="code">{view.text}</pre>)}
        {view && <CopyText text={`${goal.sharedDir}/${file.path}`} />}
      </div>
    </>
  );
}
