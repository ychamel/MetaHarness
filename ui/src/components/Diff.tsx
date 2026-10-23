import { useMemo, useState } from 'react';
import type { DiffFile } from '../types.ts';

const STATUS: Record<DiffFile['status'], string> = { added: 'new', modified: '', deleted: 'deleted', renamed: 'renamed' };

/** A diff as a list of files, each folded to its +/- counts until opened; large diffs start folded. */
export function DiffFiles({ files, empty = 'No changes.' }: { files: DiffFile[]; empty?: string }) {
  const total = useMemo(() => files.reduce((n, f) => n + f.added + f.removed, 0), [files]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(total <= 400 ? files.map(f => f.path) : files.slice(0, 1).map(f => f.path)));
  if (!files.length) return <div className="empty">{empty}</div>;
  const toggle = (p: string) => setOpen(s => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });
  return (
    <div className="diff">
      <div className="diff-summary">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <span className="diff-add">+{files.reduce((n, f) => n + f.added, 0)}</span>
        <span className="diff-del">−{files.reduce((n, f) => n + f.removed, 0)}</span>
        <span className="spacer" />
        <button className="btn ghost small" onClick={() => setOpen(new Set(files.map(f => f.path)))}>
          Open all
        </button>
        <button className="btn ghost small" onClick={() => setOpen(new Set())}>
          Fold all
        </button>
      </div>
      {files.map(f => (
        <section key={f.path} className="diff-file">
          <button className="diff-file-head" onClick={() => toggle(f.path)} aria-expanded={open.has(f.path)}>
            <span className="muted">{open.has(f.path) ? '▾' : '▸'}</span>
            <span className="mono path">
              {f.from ? (
                <>
                  <span className="muted">{f.from} → </span>
                  {f.path}
                </>
              ) : (
                f.path
              )}
            </span>
            {STATUS[f.status] && <span className={`pill ${f.status === 'deleted' ? 'warn' : ''}`}>{STATUS[f.status]}</span>}
            <span className="spacer" />
            <span className="diff-add">+{f.added}</span>
            <span className="diff-del">−{f.removed}</span>
          </button>
          {open.has(f.path) && (f.binary ? <div className="empty">A binary file.</div> : <Hunks patch={f.patch} cut={f.cut} />)}
        </section>
      ))}
    </div>
  );
}

/** Unified hunks with old and new line numbers. */
export function Hunks({ patch, cut }: { patch: string; cut?: boolean }) {
  const rows = useMemo(() => {
    const out: { kind: 'hunk' | 'add' | 'del' | 'ctx'; text: string; a?: number; b?: number }[] = [];
    let a = 0;
    let b = 0;
    for (const line of patch.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (h) {
        a = Number(h[1]);
        b = Number(h[2]);
        out.push({ kind: 'hunk', text: line });
      } else if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1), b: b++ });
      else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1), a: a++ });
      else if (line.startsWith('\\')) continue;
      else out.push({ kind: 'ctx', text: line.slice(1), a: a++, b: b++ });
    }
    return out;
  }, [patch]);
  if (!patch) return <div className="empty">Only the file's mode or name changed.</div>;
  return (
    <div className="hunks" role="table">
      {rows.map((r, i) => (
        <div key={i} className={`hunk-row ${r.kind}`} role="row">
          <span className="ln">{r.a ?? ''}</span>
          <span className="ln">{r.b ?? ''}</span>
          <span className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
          <code>{r.text || ' '}</code>
        </div>
      ))}
      {cut && <div className="empty">The rest of this file's diff was cut: it's too large to show.</div>}
    </div>
  );
}
