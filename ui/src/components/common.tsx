import { useEffect, useState, type ReactNode } from 'react';
import type { Agent } from '../types.ts';

export function Dot({ state }: { state: string }) {
  return <span className={`dot ${state}`} title={state} />;
}

/** Context fill, when the harness reports it. */
export function Ctx({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  return (
    <span className={`ctx${pct >= 75 ? ' high' : ''}`} title={`context ${pct}%`}>
      <i style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title}>
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
export const where = (a: Pick<Agent, 'role' | 'harness' | 'model'>) => `${a.role} · ${a.harness} · ${a.model}`;

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
