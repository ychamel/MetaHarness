import { Component, createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Agent } from '../types.ts';
import { modelLabel } from '../format.ts';
import { fileAt, withFileLinks, type FileLinks } from '../fileLinks.tsx';

/**
 * Keeps a view that throws from blanking the whole app: it says what broke and offers to try
 * again. A chunk that no longer exists (the app was rebuilt while open) needs a reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error?: Error; key?: string }> {
  state: { error?: Error; key?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(p: { resetKey?: string }, s: { error?: Error; key?: string }) {
    // Another tab or goal: start clean.
    return p.resetKey !== s.key ? { error: undefined, key: p.resetKey } : null;
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(error.message);
    return (
      <div className="empty big">
        <div>{stale ? 'The app was rebuilt since this page loaded.' : 'This view ran into a problem.'}</div>
        <div className="muted small mono">{error.message}</div>
        <div className="row-gap">
          {!stale && (
            <button className="btn" onClick={() => this.setState({ error: undefined })}>
              Try again
            </button>
          )}
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export function Dot({ state }: { state: string }) {
  return <span className={`dot ${state}`} title={state === 'idle' ? 'Waiting for messages. Wakes automatically when a message arrives.' : state} />;
}

/** Context fill, when the harness reports it. */
/** The time, refreshed every `ms`, for things that count down. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const left = (ms: number) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}` : ms >= 120_000 ? `${Math.round(ms / 60_000)}m` : `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`);

/**
 * How long an agent's prompt cache stays warm while it isn't working. After that, its next turn
 * pays to read its whole context again.
 */
export function CacheClock({ agent, long }: { agent: Agent; long?: boolean }) {
  const now = useNow(long ? 1000 : 5000);
  if (!agent.cacheUntil || ['starting', 'working', 'ended', 'crashed'].includes(agent.state)) return null;
  const ms = agent.cacheUntil - now;
  const what = `${agent.cacheMinutes >= 60 ? `${agent.cacheMinutes / 60}-hour` : `${agent.cacheMinutes}-minute`} cache`;
  if (ms <= 0) return long ? <span className="muted" title={`Its ${what} has expired: its next turn reads its context at full price`}>cache expired</span> : null;
  return (
    <span className={`cache-clock${ms < 120_000 ? ' soon' : ''}`} title={`Its prompt cache (${what}) stays warm for ${left(ms)} more; a turn before then reads its context cheaply`}>
      {long ? `cache warm for ${left(ms)}` : left(ms)}
    </span>
  );
}

export function Ctx({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  return (
    <span className={`ctx${pct >= 75 ? ' high' : ''}`} title={`context ${pct}%`}>
      <i style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  );
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <code>{text}</code>
      <button
        className="btn small"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** A short line of where an agent runs: role · harness · model. */
export const where = (a: Pick<Agent, 'role' | 'harness' | 'model' | 'effort'>) => `${a.role} · ${a.harness} · ${modelLabel(a)}`;

/** Messages from the app's own actions: what the daemon answered, or what went wrong. */
export function useToast() {
  const [text, setText] = useState<string>();
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => setText(undefined), 4500);
    return () => clearTimeout(t);
  }, [text]);
  return { toast: text ? <div className="toast" role="status">{text}</div> : null, say: setText };
}

/* ---------------- asking before something that can't be undone ---------------- */

type Ask = { title: string; body?: ReactNode; confirm: string; danger?: boolean };
const ConfirmContext = createContext<(a: Ask) => Promise<boolean>>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({...})) …` — a dialog instead of window.confirm. */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<Ask & { resolve: (ok: boolean) => void }>();
  const open = useCallback((a: Ask) => new Promise<boolean>(resolve => setAsk({ ...a, resolve })), []);
  const close = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(undefined);
  };
  return (
    <ConfirmContext.Provider value={open}>
      {children}
      {ask && (
        <Dialog title={ask.title} onClose={() => close(false)}>
          {ask.body && <div className="dialog-body">{ask.body}</div>}
          <div className="row">
            <button className="btn" onClick={() => close(false)}>
              Cancel
            </button>
            <button className={`btn ${ask.danger ? 'danger-solid' : 'primary'}`} autoFocus onClick={() => close(true)}>
              {ask.confirm}
            </button>
          </div>
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}

/* ---------------- long text ---------------- */

/** Shows the first few lines; the rest is behind “Show more”. Only offers it when the text is actually cut. */
export function More({ lines = 4, children, className = '' }: { lines?: number; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children]);
  return (
    <div className={`more ${className}`}>
      <div ref={ref} className={open ? 'more-body open' : 'more-body'} style={open ? undefined : { WebkitLineClamp: lines, maxHeight: `${lines * 1.5 + 0.2}em` }}>
        {children}
      </div>
      {(cut || open) && (
        <button className="more-toggle" onClick={() => setOpen(o => !o)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** A little markdown, rendered as elements (never as HTML): headings, lists, quotes, code, emphasis, links. */
/** `files`: shared files named in it become links that open them. */
export function Markdown({ text, className = '', files }: { text: string; className?: string; files?: FileLinks }) {
  return <div className={`md ${className}`}>{blocks(text, files)}</div>;
}

function blocks(text: string, files?: FileLinks): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const key = () => out.length;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(<pre key={key()} className="code">{body.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      const Tag = `h${level}` as 'h3';
      out.push(<Tag key={key()}>{inline(h[2], files)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) items.push(m[2]);
        else if (items.length) items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(<List key={key()}>{items.map((t, n) => <li key={n}>{inline(t, files)}</li>)}</List>);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(<blockquote key={key()}>{blocks(q.join('\n'), files)}</blockquote>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|').map(c => c.trim()));
        i++;
      }
      out.push(
        <div key={key()} className="table-wrap">
          <table>
            <tbody>
              {rows.map((r, n) => (
                <tr key={n}>{r.map((c, m) => (n === 0 ? <th key={m}>{inline(c, files)}</th> : <td key={m}>{inline(c, files)}</td>))}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(<p key={key()}>{para.map((l, n) => <Fragment key={n}>{n > 0 && <br />}{inline(l, files)}</Fragment>)}</p>);
  }
  return out;
}

function inline(s: string, files?: FileLinks): ReactNode[] {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|(?<![\w*])\*[^*\s][^*]*\*(?![\w*]))/g);
  return parts.map((p, n) => {
    if (!p) return null;
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return <code key={n}>{withFileLinks(p.slice(1, -1), files)}</code>;
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <b key={n}>{p.slice(2, -2)}</b>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
    const file = link && fileAt(link[2], files);
    if (link && file)
      return (
        <button key={n} className="file-link" onClick={() => files!.open(file)} title={`Read shared/${file}`}>
          {link[1]}
        </button>
      );
    if (link) return /^https?:\/\//.test(link[2]) ? <a key={n} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a> : <span key={n}>{link[1]}</span>;
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <i key={n}>{p.slice(1, -1)}</i>;
    return <Fragment key={n}>{withFileLinks(p, files)}</Fragment>;
  });
}

/* ---------------- forms ---------------- */

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
}

/** Where a role or workflow is saved: the project's .metaharness, or your own folder for every project. */
export function ScopeBadge({ scope }: { scope: string }) {
  return <span className={`scope ${scope}`}>{scope === 'repo' ? 'project' : scope === 'personal' ? 'personal' : scope}</span>;
}

/** A list of short strings edited as chips: type and press Enter, × to remove. */
export function ChipList({ values, onChange, placeholder, suggestions = [] }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; suggestions?: string[] }) {
  const [draft, setDraft] = useState('');
  const id = useRef(`chips-${Math.random().toString(36).slice(2)}`).current;
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="chips">
      {values.map(v => (
        <span key={v} className="chip">
          <span className="mono">{v}</span>
          <button aria-label={`Remove ${v}`} onClick={() => onChange(values.filter(x => x !== v))}>
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        list={suggestions.length ? id : undefined}
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={add}
      />
      {suggestions.length > 0 && (
        <datalist id={id}>
          {suggestions.filter(s => !values.includes(s)).map(s => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
