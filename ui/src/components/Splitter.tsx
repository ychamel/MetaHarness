import { useRef } from 'react';

const KEY = 'metaharness-panes';

function saved(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function keep(pane: string, width: number | undefined): void {
  try {
    const all = saved();
    if (width === undefined) delete all[pane];
    else all[pane] = Math.round(width);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Not kept, but it lasts for this visit.
  }
}

const cssVar = (pane: string) => `--pane-${pane}`;

/** Widths the human dragged panes to, back on the page's root as CSS variables. */
export function restorePanes(): void {
  for (const [pane, w] of Object.entries(saved())) document.documentElement.style.setProperty(cssVar(pane), `${w}px`);
}

/**
 * A handle on a pane's edge that resizes it. The width is a CSS variable (--pane-<name>) the
 * layout reads, so dragging reflows the page without re-rendering it. `grow`: the direction a
 * drag widens the pane. The pane is the element before the handle (grow right), after it (grow
 * left), or its parent when the handle sits inside it. Double-click puts it back.
 */
export function Splitter({ pane, grow, min, max, inside, label }: { pane: string; grow: 'left' | 'right'; min: number; max: number; inside?: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null);

  const target = () => {
    const el = ref.current!;
    return (inside ? el.parentElement : grow === 'right' ? el.previousElementSibling : el.nextElementSibling) as HTMLElement | null;
  };
  const set = (w: number) => {
    const width = Math.max(min, Math.min(max, w));
    document.documentElement.style.setProperty(cssVar(pane), `${width}px`);
    return width;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = e.clientX;
    const from = target()?.getBoundingClientRect().width ?? min;
    let last = from;
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (m: PointerEvent) => (last = set(from + (grow === 'right' ? m.clientX - start : start - m.clientX)));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      keep(pane, last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.key === 'ArrowRight') === (grow === 'right') ? 24 : -24;
    keep(pane, set((target()?.getBoundingClientRect().width ?? min) + step));
  };

  return (
    <div
      ref={ref}
      className={`splitter${inside ? ` inside ${grow === 'left' ? 'at-left' : 'at-right'}` : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title={`${label}: drag to resize, double-click to reset`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        document.documentElement.style.removeProperty(cssVar(pane));
        keep(pane, undefined);
      }}
    />
  );
}
