import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CanvasCard, CardKind, Goal, Knob, Lens } from '../types.ts';
import { CARD_KINDS, demoKnobs, kindOf, MIX_MAKES, TAKES, type RoomView as Room } from '../roomData.ts';
import { CARD_W, edgePoint, frameAt, layoutBoard, type Box } from '../boardLayout.ts';
import { api, mediaUrl } from '../api.ts';
import { Dialog, Field, Markdown, useNow } from '../components/common.tsx';
import { oneLine } from '../format.ts';
import type { FileLinks } from '../fileLinks.tsx';

type Cmd = (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;

interface Props {
  goal: Goal;
  room: Room;
  live: boolean;
  color: (n?: string) => string;
  files: FileLinks;
  onCommand: Cmd;
  /** Your next message to the lead is about this card. */
  onAskLead: (id: string) => void;
  onBranch: (ids: string[]) => void;
  onRoom: (id: string) => void;
}

const FRESH_MS = 12_000;
const MIN_K = 0.25;
const MAX_K = 2;

type Drag = { kind: 'card' | 'frame' | 'pan'; id?: string; sx: number; sy: number; dx: number; dy: number; moved: boolean; add?: boolean };
type Mix = { cards: { id: string; take: string }[]; make: string };

/**
 * A room's board (design §21): cards you place where you like or group in frames, links between
 * them, and what each mix was made from. Drag a card to move it, onto a frame to put it there;
 * drag the background to pan, ctrl+wheel to zoom. Pick cards to mix them, ask a maker or the
 * lead about them, frame, branch, settle or drop them; open one to see it whole: an image, a
 * demo to play and tune, a source, a concept.
 */
export function Board({ goal, room, live, color, files, onCommand, onAskLead, onBranch, onRoom }: Props) {
  const now = useNow(2000);
  const vp = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 24, y: 24, k: 1 });
  const heights = useRef(new Map<string, number>());
  const [measured, setMeasured] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<string>();
  const [hover, setHover] = useState<string>();
  const [drag, setDrag] = useState<Drag>();
  const [mix, setMix] = useState<Mix>();
  const [asking, setAsking] = useState<{ cards: string[] }>();
  const [adding, setAdding] = useState<{ kind: CardKind; title: string; url: string }>();
  const [framing, setFraming] = useState<string>();
  const op = (...ops: Record<string, unknown>[]) => void onCommand({ cmd: 'room.canvas', goal: goal.id, ops });

  useEffect(() => {
    // Cards that went away aren't picked or open any more.
    setPicked(p => p.filter(id => room.cards.some(c => c.id === id)));
    if (open && !room.cards.some(c => c.id === open)) setOpen(undefined);
  }, [room.cards, open]);

  // Cards are as tall as what they show: measured, and laid out again when that changes.
  const ro = useMemo(
    () =>
      new ResizeObserver(entries => {
        let changed = false;
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.card!;
          const h = Math.round((e.target as HTMLElement).offsetHeight);
          if (heights.current.get(id) !== h) {
            heights.current.set(id, h);
            changed = true;
          }
        }
        if (changed) setMeasured(m => m + 1);
      }),
    [],
  );
  useEffect(() => () => ro.disconnect(), [ro]);
  const layout = useMemo(() => layoutBoard(room.cards, room.frames, id => heights.current.get(id) ?? 96), [room.cards, room.frames, measured]);

  const toBoard = (cx: number, cy: number) => {
    const r = vp.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };
  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const r = vp.current!.getBoundingClientRect();
    const px = cx === undefined ? r.width / 2 : cx - r.left;
    const py = cy === undefined ? r.height / 2 : cy - r.top;
    setView(v => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };
  const fit = (b: Box) => {
    const r = vp.current?.getBoundingClientRect();
    if (!r || !b.w) return;
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min((r.width - 60) / b.w, (r.height - 60) / b.h, 1.1)));
    setView({ k, x: (r.width - b.w * k) / 2 - b.x * k, y: Math.max(16, (r.height - b.h * k) / 2) - b.y * k });
  };
  // The whole board in view the first time there's something on it.
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !room.cards.length || !measured) return;
    fitted.current = true;
    fit(layout.bounds);
  });

  // Plain wheel pans, ctrl (or a pinch) zooms. Not passive, so the page doesn't scroll instead.
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.board-panel, iframe')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
      else setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  const pick = (id: string, add: boolean) => {
    if (add) setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
    else {
      setPicked([id]);
      setOpen(id);
    }
  };
  const down = (e: React.PointerEvent, kind: Drag['kind'], id?: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, textarea, select, a, iframe, .no-drag')) return;
    if (kind !== 'pan') e.stopPropagation();
    vp.current!.setPointerCapture(e.pointerId);
    setDrag({ kind, id, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false, add: e.shiftKey || e.ctrlKey || e.metaKey });
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    const moved = drag.moved || Math.hypot(dx, dy) > 4;
    if (drag.kind === 'pan' && moved) {
      setView(v => ({ ...v, x: v.x + dx - drag.dx, y: v.y + dy - drag.dy }));
    }
    setDrag({ ...drag, dx, dy, moved });
  };
  const up = (e: React.PointerEvent) => {
    const d = drag;
    setDrag(undefined);
    if (!d) return;
    if (!d.moved) {
      if (d.kind === 'card') pick(d.id!, !!d.add);
      if (d.kind === 'pan') setPicked([]);
      return;
    }
    if (!live) return;
    const dx = d.dx / view.k;
    const dy = d.dy / view.k;
    if (d.kind === 'frame') {
      const b = layout.frames.get(d.id!)!;
      op({ op: 'move', id: d.id, x: b.x + dx, y: b.y + dy });
    } else if (d.kind === 'card') {
      const card = room.cards.find(c => c.id === d.id)!;
      const b = layout.cards.get(d.id!)!;
      const target = frameAt(layout, toBoard(e.clientX, e.clientY));
      if (target && target !== card.frame) op({ op: 'move', id: card.id, frame: target });
      else if (!target) op({ op: 'move', id: card.id, frame: '', x: b.x + dx, y: b.y + dy });
    }
  };
  const offset = (id: string, frame?: string) =>
    drag?.moved && ((drag.kind === 'card' && drag.id === id) || (drag.kind === 'frame' && drag.id === frame)) ? { x: drag.dx / view.k, y: drag.dy / view.k } : undefined;

  const lit = hover ?? (picked.length === 1 ? picked[0] : undefined);
  const near = useMemo(() => {
    if (!lit) return undefined;
    const s = new Set([lit]);
    for (const l of room.links) {
      if (l.from === lit) s.add(l.to);
      if (l.to === lit) s.add(l.from);
    }
    const card = room.cards.find(c => c.id === lit);
    for (const i of card?.from ?? []) s.add(i.id);
    for (const c of room.cards) if (c.from?.some(i => i.id === lit)) s.add(c.id);
    return s;
  }, [lit, room.links, room.cards]);

  // Links, and what each card was made from (dashed), between where the cards are now.
  const wires = useMemo(() => {
    const at = (id: string): Box | undefined => {
      const b = layout.cards.get(id);
      const c = room.cards.find(x => x.id === id);
      const o = b && offset(id, c?.frame);
      return b && (o ? { ...b, x: b.x + o.x, y: b.y + o.y } : b);
    };
    const line = (from: string, to: string) => {
      const a = at(from);
      const z = at(to);
      if (!a || !z) return undefined;
      const p = edgePoint(a, { x: z.x + z.w / 2, y: z.y + z.h / 2 });
      const q = edgePoint(z, { x: a.x + a.w / 2, y: a.y + a.h / 2 });
      return `M ${p.x} ${p.y} L ${q.x} ${q.y}`;
    };
    const out: { key: string; d: string; from: string; to: string; label?: string; made?: boolean }[] = [];
    for (const l of room.links) {
      const d = line(l.from, l.to);
      if (d) out.push({ key: `l${l.from}-${l.to}`, d, from: l.from, to: l.to, label: l.label });
    }
    for (const c of room.cards)
      for (const i of c.from ?? []) {
        const d = line(i.id, c.id);
        if (d) out.push({ key: `m${i.id}-${c.id}`, d, from: i.id, to: c.id, label: i.take, made: true });
      }
    return out;
    // offset reads the drag; the wires follow it.
  }, [layout, room.links, room.cards, drag, view.k]);

  const sel = room.cards.filter(c => picked.includes(c.id));
  const openCard = room.cards.find(c => c.id === open);
  const makers = room.lenses.filter(l => !l.off);
  const startMix = (ids: string[], make?: string) =>
    setMix({ cards: ids.map(id => ({ id, take: '' })), make: make ?? (makers.some(m => m.makes === 'image') ? 'image' : 'text') });

  return (
    <div className="board-wrap">
      <div className="canvas-tools">
        {sel.length ? (
          <>
            <span className="muted small">
              {sel.length} picked
            </span>
            {live && (
              <>
                <button className="btn small primary" onClick={() => startMix(picked)} title="Make something new from these cards: say what to take from each">
                  ⚗ Mix…
                </button>
                <button className="btn small" onClick={() => setAsking({ cards: picked })} title="Ask a maker directly about these cards">
                  Ask a maker…
                </button>
                {sel.length === 1 && (
                  <button className="btn small" onClick={() => onAskLead(sel[0].id)} title="Your next message to the lead is about this card">
                    Ask the lead
                  </button>
                )}
                <button className="btn ghost small" onClick={() => setFraming('')} title="Put these cards in a frame (a new one, or one there is)">
                  ▢ Frame
                </button>
              </>
            )}
            <button className="btn ghost small" onClick={() => onBranch(picked)} title="A room of its own for this topic: it starts with these cards and the ones linked to them">
              ⑂ Branch
            </button>
            {live && (
              <>
                <button className="btn ghost small" onClick={() => op(...sel.map(c => ({ op: c.status === 'settled' ? 'reopen' : 'settle', id: c.id })))} title="Settled: answered, done or agreed. Again: open">
                  ✓
                </button>
                <button className="btn ghost small" onClick={() => op(...sel.map(c => ({ op: c.status === 'dropped' ? 'reopen' : 'drop', id: c.id })))} title="Dropped: turned down, or proved wrong. Again: open">
                  ✗
                </button>
                {sel.length === 2 && (
                  <button className="btn ghost small" onClick={() => op({ op: 'link', from: picked[0], to: picked[1] })} title={`Link ${picked[0]} to ${picked[1]}`}>
                    ⟶
                  </button>
                )}
              </>
            )}
            <button className="btn ghost small" onClick={() => setPicked([])}>
              Clear
            </button>
          </>
        ) : (
          <span className="muted small">{room.cards.length ? 'Click a card to open it, shift-click to pick more. Drag to move; drop on a frame to put it there.' : ''}</span>
        )}
        <span className="grow" />
        {framing !== undefined && (
          <span className="card-add">
            <input
              type="text"
              autoFocus
              list="board-frames"
              value={framing}
              onChange={e => setFraming(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && framing.trim()) {
                  op({ op: 'frame', title: framing.trim(), cards: picked });
                  setFraming(undefined);
                }
                if (e.key === 'Escape') setFraming(undefined);
              }}
              placeholder="Frame name, e.g. Combat"
              aria-label="Frame"
            />
            <datalist id="board-frames">
              {room.frames.map(f => (
                <option key={f.id} value={f.title} />
              ))}
            </datalist>
          </span>
        )}
        {live &&
          (adding ? (
            <span className="card-add">
              <select value={adding.kind} onChange={e => setAdding({ ...adding, kind: e.target.value as CardKind })} aria-label="Kind">
                {CARD_KINDS.filter(k => !['image', 'demo', 'finding'].includes(k.kind)).map(k => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                autoFocus
                value={adding.title}
                onChange={e => setAdding({ ...adding, title: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter' && adding.title.trim()) {
                    op({ op: 'add', kind: adding.kind, title: adding.title.trim(), ...(adding.kind === 'source' && adding.url.trim() ? { url: adding.url.trim() } : {}) });
                    setAdding(undefined);
                  }
                  if (e.key === 'Escape') setAdding(undefined);
                }}
                placeholder="A few words"
              />
              {adding.kind === 'source' && <input type="url" value={adding.url} onChange={e => setAdding({ ...adding, url: e.target.value })} placeholder="https://…" aria-label="Link" />}
            </span>
          ) : (
            <>
              <button className="btn ghost small" onClick={() => setAdding({ kind: 'idea', title: '', url: '' })} title="Put a card on the board yourself">
                + Card
              </button>
              <button className="btn ghost small" onClick={() => setFraming('')} title="A frame to group cards in">
                + Frame
              </button>
            </>
          ))}
        {room.frames.length > 0 && (
          <select
            className="frame-jump"
            value=""
            onChange={e => {
              const b = layout.frames.get(e.target.value);
              if (b) fit(b);
            }}
            aria-label="Go to a frame"
          >
            <option value="">Frames…</option>
            {room.frames.map(f => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
          </select>
        )}
        {live && room.cards.length > 0 && (
          <button className="btn ghost small" onClick={() => op({ op: 'tidy' })} title="Lay out the cards and frames outside frames again, in the order they came">
            Tidy
          </button>
        )}
        <span className="zoom">
          <button className="btn ghost small" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out">
            −
          </button>
          <button className="btn ghost small mono" onClick={() => fit(layout.bounds)} title="Fit the whole board">
            {Math.round(view.k * 100)}%
          </button>
          <button className="btn ghost small" onClick={() => zoomAt(1.2)} aria-label="Zoom in">
            +
          </button>
        </span>
      </div>
      <div className="board-area">
        <div className={`board${drag?.moved ? ' dragging' : ''}`} ref={vp} onPointerDown={e => down(e, 'pan')} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(undefined)}>
          <div className="board-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            {room.frames.map(f => {
              const b = layout.frames.get(f.id);
              if (!b) return null;
              const o = offset('', f.id);
              const count = room.cards.filter(c => c.frame === f.id).length;
              return (
                <div key={f.id} className="board-frame" style={{ left: b.x + (o?.x ?? 0), top: b.y + (o?.y ?? 0), width: b.w, height: b.h }}>
                  <FrameHead goal={goal} live={live} frame={f} count={count} onDown={e => down(e, 'frame', f.id)} onFit={() => fit(b)} onCommand={onCommand} />
                </div>
              );
            })}
            <svg className="board-wires" width="1" height="1" aria-hidden>
              <defs>
                <marker id="board-end" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" className="wire-head" />
                </marker>
              </defs>
              {wires.map(w => (
                <path key={w.key} d={w.d} markerEnd="url(#board-end)" className={`wire${w.made ? ' made' : ''}${near ? (near.has(w.from) && near.has(w.to) && (w.from === lit || w.to === lit) ? ' lit' : ' dim') : ''}`}>
                  {w.label && <title>{w.made ? `take: ${w.label}` : w.label}</title>}
                </path>
              ))}
            </svg>
            {room.cards.map(c => {
              const b = layout.cards.get(c.id);
              if (!b) return null;
              const o = offset(c.id, c.frame);
              return (
                <CardTile
                  key={c.id}
                  card={c}
                  goal={goal}
                  room={room}
                  color={color}
                  at={{ x: b.x + (o?.x ?? 0), y: b.y + (o?.y ?? 0) }}
                  picked={picked.includes(c.id)}
                  open={open === c.id}
                  dim={!!near && !near.has(c.id)}
                  lifted={!!o}
                  fresh={now - (room.seen.get(c.id)?.added ?? 0) < FRESH_MS}
                  touched={now - (room.seen.get(c.id)?.changed ?? 0) < FRESH_MS}
                  stamp={room.seen.get(c.id)?.changed ?? 0}
                  refEl={el => {
                    if (el) ro.observe(el);
                  }}
                  onDown={e => down(e, 'card', c.id)}
                  onHover={on => setHover(on ? c.id : undefined)}
                />
              );
            })}
          </div>
          {!room.cards.length && <div className="canvas-empty">As you talk, the lead and the makers put ideas, references, images, demos and decisions here. Pick cards to mix them into something new.</div>}
        </div>
        {openCard && (
          <CardPanel
            key={openCard.id}
            card={openCard}
            goal={goal}
            room={room}
            live={live}
            color={color}
            files={files}
            stamp={room.seen.get(openCard.id)?.changed ?? 0}
            onClose={() => setOpen(undefined)}
            onOpen={id => {
              setOpen(id);
              setPicked([id]);
            }}
            onAskLead={() => onAskLead(openCard.id)}
            onRemix={() => setMix({ cards: (openCard.from ?? []).map(i => ({ id: i.id, take: i.take ?? '' })), make: openCard.kind === 'idea' ? 'ideas' : openCard.kind })}
            onRoom={onRoom}
            onCommand={onCommand}
          />
        )}
        {asking && live && <AskBar goal={goal} room={room} cards={asking.cards} makers={makers} onClose={() => setAsking(undefined)} onCommand={onCommand} />}
      </div>
      {mix && <MixDialog goal={goal} room={room} mix={mix} makers={makers} onClose={() => setMix(undefined)} onCommand={onCommand} />}
    </div>
  );
}

function FrameHead({ goal, live, frame, count, onDown, onFit, onCommand }: { goal: Goal; live: boolean; frame: Room['frames'][number]; count: number; onDown: (e: React.PointerEvent) => void; onFit: () => void; onCommand: Cmd }) {
  const [naming, setNaming] = useState<string>();
  const op = (o: Record<string, unknown>) => void onCommand({ cmd: 'room.canvas', goal: goal.id, ops: [o] });
  return (
    <div className="frame-head" onPointerDown={onDown} onDoubleClick={() => live && setNaming(frame.title)} title={live ? 'Drag to move the frame with its cards; double-click to rename' : undefined}>
      {naming !== undefined ? (
        <input
          type="text"
          className="no-drag"
          autoFocus
          value={naming}
          onChange={e => setNaming(e.target.value)}
          onBlur={() => setNaming(undefined)}
          onKeyDown={e => {
            if (e.key === 'Enter' && naming.trim()) {
              op({ op: 'frame', id: frame.id, title: naming.trim() });
              setNaming(undefined);
            }
            if (e.key === 'Escape') setNaming(undefined);
          }}
          aria-label="Frame name"
        />
      ) : (
        <span className="frame-title">{frame.title}</span>
      )}
      <span className="muted">{count}</span>
      <span className="grow" />
      <button className="btn ghost small" onClick={onFit} title="Zoom to this frame">
        ⤢
      </button>
      {live && (
        <button className="btn ghost small" onClick={() => op({ op: 'remove', id: frame.id })} title="Remove the frame; its cards stay on the board">
          ×
        </button>
      )}
    </div>
  );
}

function CardTile({ card: c, goal, room, color, at, picked, open, dim, lifted, fresh, touched, stamp, refEl, onDown, onHover }: {
  card: CanvasCard;
  goal: Goal;
  room: Room;
  color: (n?: string) => string;
  at: { x: number; y: number };
  picked: boolean;
  open: boolean;
  dim: boolean;
  lifted: boolean;
  fresh: boolean;
  touched: boolean;
  stamp: number;
  refEl: (el: HTMLElement | null) => void;
  onDown: (e: React.PointerEvent) => void;
  onHover: (on: boolean) => void;
}) {
  const k = kindOf(c.kind);
  const by = c.by === 'human' ? 'you' : c.by;
  const byColor = c.by === 'human' ? 'var(--you)' : /^(room|goal) /.test(c.by) ? 'var(--text-3)' : color(c.by);
  const title = (id: string) => room.cards.find(x => x.id === id)?.title;
  return (
    <div
      ref={refEl}
      data-card={c.id}
      className={`canvas-card board-card ${c.kind}${c.status ? ` ${c.status}` : ''}${c.pending ? ' pending' : ''}${picked ? ' picked' : ''}${open ? ' open' : ''}${dim ? ' dim' : ''}${lifted ? ' lifted' : ''}${fresh ? ' fresh' : touched ? ' touched' : ''}`}
      style={{ left: at.x, top: at.y, width: CARD_W }}
      onPointerDown={onDown}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      role="button"
      tabIndex={0}
      aria-label={`${k.label} ${c.id}: ${c.title}`}
    >
      <div className="card-top">
        <span className="card-kind">
          {k.icon} {k.label}
        </span>
        <span className="card-id">{c.id}</span>
        {c.status && <span className="card-status">{c.status}</span>}
        <span className="card-by" style={{ color: byColor }} title={`By ${by}`}>
          {by}
        </span>
      </div>
      {c.pending ? (
        <div className="card-pending">
          <span className="spinner" /> {c.pending} is making it…
        </div>
      ) : (
        <div className="card-title">{c.title}</div>
      )}
      {c.kind === 'image' && c.file && <img className="card-thumb" src={`${mediaUrl(goal.id, c.file)}&v=${stamp}`} alt={c.title} loading="lazy" draggable={false} />}
      {c.kind === 'demo' && c.file && <div className="card-play">▶ Open to play and tune</div>}
      {c.url && <div className="card-more ellipsis">↗ {hostOf(c.url)}</div>}
      {c.pillars?.length ? (
        <ul className="card-pillars">
          {c.pillars.slice(0, 5).map(p => (
            <li key={p.name}>
              <b>{p.name}</b> {oneLine(p.text, 60)}
            </li>
          ))}
        </ul>
      ) : null}
      {c.values && (
        <div className="card-values">
          {Object.entries(c.values)
            .slice(0, 4)
            .map(([n, v]) => (
              <span key={n} className="value-chip mono">
                {n} {v}
              </span>
            ))}
        </div>
      )}
      {c.from?.length ? <div className="card-more" title={c.from.map(i => `${i.id} ${title(i.id) ?? ''}${i.take ? ` (${i.take})` : ''}`).join('\n')}>⚗ from {c.from.map(i => i.id).join(' + ')}</div> : null}
      {!c.pending && (c.text || c.notes?.length) && c.kind !== 'concept' ? (
        <div className="card-more">
          {c.text && c.kind === 'text' ? oneLine(c.text, 90) : c.text ? '¶ ' : ''}
          {c.notes?.length ? ` ${c.notes.length} note${c.notes.length > 1 ? 's' : ''}` : ''}
        </div>
      ) : null}
      {c.branches?.length ? <div className="card-more">⑂ branched</div> : null}
    </div>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** A card in full, beside the board. */
function CardPanel({ card: c, goal, room, live, color, files, stamp, onClose, onOpen, onAskLead, onRemix, onRoom, onCommand }: {
  card: CanvasCard;
  goal: Goal;
  room: Room;
  live: boolean;
  color: (n?: string) => string;
  files: FileLinks;
  stamp: number;
  onClose: () => void;
  onOpen: (id: string) => void;
  onAskLead: () => void;
  onRemix: () => void;
  onRoom: (id: string) => void;
  onCommand: Cmd;
}) {
  const [editing, setEditing] = useState<{ title: string; text: string }>();
  const k = kindOf(c.kind);
  const op = (...ops: Record<string, unknown>[]) => void onCommand({ cmd: 'room.canvas', goal: goal.id, ops });
  const cardOf = (id: string) => room.cards.find(x => x.id === id);
  const links = room.links.filter(l => l.from === c.id || l.to === c.id);
  const madeInto = room.cards.filter(x => x.from?.some(i => i.id === c.id));
  const shared = goal.sharedDir.endsWith('/') ? goal.sharedDir : `${goal.sharedDir}/`;
  // A decision kept from a demo plays that demo with its values.
  const tunedFrom = c.values ? c.from?.map(i => cardOf(i.id)).find(x => x?.kind === 'demo' && x.file) : undefined;
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input, textarea, select') && !document.querySelector('.backdrop') && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  });
  const chip = (id: string, extra?: ReactNode) => (
    <button key={id} className="card-chip" onClick={() => onOpen(id)} title={cardOf(id)?.title}>
      {id} · {oneLine(cardOf(id)?.title ?? '(gone)', 40)}
      {extra}
    </button>
  );
  const save = () => {
    if (!editing) return;
    op({ op: 'edit', id: c.id, title: editing.title, text: editing.text });
    setEditing(undefined);
  };
  return (
    <aside className={`board-panel ${c.kind}`} aria-label={`${k.label} ${c.id}`}>
      <div className="panel-head">
        <span className="card-kind">
          {k.icon} {k.label}
        </span>
        <span className="card-id">{c.id}</span>
        {c.status && <span className="card-status">{c.status}</span>}
        <span className="card-by" style={{ color: c.by === 'human' ? 'var(--you)' : color(c.by) }}>
          {c.by === 'human' ? 'you' : c.by}
        </span>
        <span className="grow" />
        <button className="btn ghost small" onClick={onClose} aria-label="Close (Esc)">
          ×
        </button>
      </div>
      <div className="panel-body">
        {editing ? (
          <div className="card-edit" onKeyDown={e => e.key === 'Escape' && setEditing(undefined)}>
            <input type="text" autoFocus value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} onKeyDown={e => e.key === 'Enter' && save()} aria-label="Title" />
            <textarea rows={6} value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })} placeholder="More, if the title isn't enough" aria-label="Detail" />
            <div className="row end">
              <button className="btn ghost small" onClick={() => setEditing(undefined)}>
                Cancel
              </button>
              <button className="btn small primary" onClick={save} disabled={!editing.title.trim()}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <h3 className="panel-title">{c.pending ? `${c.pending} is making it…` : c.title}</h3>
        )}
        {c.kind === 'image' && c.file && (
          <a href={mediaUrl(goal.id, c.file)} target="_blank" rel="noreferrer" title="Open it full size">
            <img className="panel-image" src={`${mediaUrl(goal.id, c.file)}&v=${stamp}`} alt={c.title} />
          </a>
        )}
        {c.kind === 'demo' && c.file && <DemoPlayer goal={goal} card={c} live={live} stamp={stamp} onCommand={onCommand} />}
        {tunedFrom && <DemoPlayer goal={goal} card={tunedFrom} live={false} stamp={stamp} start={c.values} />}
        {c.url && (
          <a className="panel-link" href={c.url} target="_blank" rel="noreferrer">
            ↗ {c.url}
          </a>
        )}
        {c.text && !editing && <Markdown text={c.text} files={files} />}
        {c.values && (
          <table className="values-table">
            <tbody>
              {Object.entries(c.values).map(([n, v]) => (
                <tr key={n}>
                  <td className="mono">{n}</td>
                  <td className="mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {c.pillars?.length ? (
          <div className="pillars">
            {c.pillars.map(p => (
              <div key={p.name} className="pillar">
                <b>{p.name}</b> {p.text}
                {p.cards?.length ? <div className="card-chips">{p.cards.map(id => chip(id))}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
        {c.from?.length ? (
          <div className="panel-section">
            <div className="kicker">Made from</div>
            <div className="card-chips">{c.from.map(i => chip(i.id, i.take ? <i> — {i.take}</i> : null))}</div>
            {live && (
              <button className="btn small" onClick={onRemix} title="Mix again: change what's taken from each card, swap a card, make more takes">
                ⚗ Remix…
              </button>
            )}
          </div>
        ) : null}
        {madeInto.length ? (
          <div className="panel-section">
            <div className="kicker">Mixed into</div>
            <div className="card-chips">{madeInto.map(x => chip(x.id))}</div>
          </div>
        ) : null}
        {c.refs?.length ? (
          <div className="card-refs">
            {c.refs.map(r =>
              r.startsWith(shared) ? (
                <button key={r} className="file-chip" onClick={() => files.open(r.slice(shared.length))} title={r}>
                  📄 {r.slice(shared.length)}
                </button>
              ) : (
                <span key={r} className="ref-chip mono" title={r}>
                  {r.split('/').slice(-2).join('/')}
                </span>
              ),
            )}
          </div>
        ) : null}
        {c.notes?.map((n, i) => (
          <div key={i} className="card-note">
            <b style={{ color: n.by === 'human' ? 'var(--you)' : color(n.by) }}>{n.by === 'human' ? 'you' : n.by}</b> {n.text}
          </div>
        ))}
        {links.length > 0 && (
          <div className="card-links">
            {links.map(l => (
              <div key={`${l.from}-${l.to}`}>
                {l.from === c.id ? '→' : '←'} {l.label ? <i>{l.label}</i> : null} {chip(l.from === c.id ? l.to : l.from)}
              </div>
            ))}
          </div>
        )}
        {c.branches?.map(b => (
          <button key={b} className="btn ghost small" onClick={() => onRoom(b)} title="Open the room it branched into">
            ⑂ room {b}
          </button>
        ))}
      </div>
      {live && (
        <div className="panel-actions">
          <button className="btn small" onClick={onAskLead}>
            Ask the lead
          </button>
          <button className="btn ghost small" onClick={() => op({ op: c.status === 'settled' ? 'reopen' : 'settle', id: c.id })}>
            {c.status === 'settled' ? 'Reopen' : '✓ Settle'}
          </button>
          <button className="btn ghost small" onClick={() => op({ op: c.status === 'dropped' ? 'reopen' : 'drop', id: c.id })}>
            {c.status === 'dropped' ? 'Reopen' : '✗ Drop'}
          </button>
          <button className="btn ghost small" onClick={() => setEditing({ title: c.title, text: c.text ?? '' })}>
            ✎ Edit
          </button>
          {(c.frame || c.at) && (
            <button className="btn ghost small" onClick={() => op({ op: 'move', id: c.id, frame: '' }, { op: 'tidy', ids: [c.id] })} title="Out of its frame, back into the flow">
              Unframe
            </button>
          )}
          <button className="btn ghost small danger" onClick={() => op({ op: 'remove', id: c.id })}>
            Remove
          </button>
        </div>
      )}
    </aside>
  );
}

/**
 * A demo, played in a sandbox: its knobs as sliders, sent to the page as you move them. Keep
 * these values puts them on the board as a decision a goal can build to.
 */
function DemoPlayer({ goal, card, live, stamp, start, onCommand }: { goal: Goal; card: CanvasCard; live: boolean; stamp: number; start?: Record<string, number>; onCommand?: Cmd }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [knobs, setKnobs] = useState<Knob[]>();
  const [values, setValues] = useState<Record<string, number>>({});
  const [run, setRun] = useState(0);
  useEffect(() => {
    let gone = false;
    api
      .file(goal.id, card.file!)
      .then(f => {
        if (gone) return;
        const k = demoKnobs(f.text ?? '');
        setKnobs(k);
        setValues(Object.fromEntries(k.map(x => [x.name, start?.[x.name] ?? x.value])));
      })
      .catch(() => !gone && setKnobs([]));
    return () => {
      gone = true;
    };
  }, [goal.id, card.file, stamp]);
  const send = (v: Record<string, number>) => frame.current?.contentWindow?.postMessage({ type: 'mh-knobs', values: v }, '*');
  const set = (name: string, v: number) => {
    const next = { ...values, [name]: v };
    setValues(next);
    send(next);
  };
  const declared = Object.fromEntries((knobs ?? []).map(k => [k.name, k.value]));
  const changed = (knobs ?? []).some(k => values[k.name] !== k.value);
  return (
    <div className="demo-player">
      <iframe
        key={`${run}-${stamp}`}
        ref={frame}
        className="demo-frame"
        sandbox="allow-scripts"
        src={mediaUrl(goal.id, card.file!, start)}
        title={card.title}
        onLoad={() => send(values)}
      />
      {knobs && knobs.length > 0 && (
        <div className="knobs">
          {knobs.map(k => (
            <label key={k.name} className="knob">
              <span className="knob-name">{k.label ?? k.name}</span>
              <input type="range" min={k.min} max={k.max} step={k.step ?? (k.max - k.min) / 100} value={values[k.name] ?? k.value} onChange={e => set(k.name, Number(e.target.value))} />
              <span className={`knob-value mono${values[k.name] !== k.value ? ' changed' : ''}`}>
                {+(values[k.name] ?? k.value).toFixed(3)}
                {k.unit ? ` ${k.unit}` : ''}
              </span>
            </label>
          ))}
        </div>
      )}
      {knobs && !knobs.length && <div className="muted small">This demo declares no knobs.</div>}
      <div className="row start">
        <button className="btn ghost small" onClick={() => setRun(r => r + 1)} title="Start it over, with the values as they are">
          ↻ Restart
        </button>
        {changed && (
          <button
            className="btn ghost small"
            onClick={() => {
              setValues(declared);
              send(declared);
            }}
          >
            Reset
          </button>
        )}
        <a className="btn ghost small" href={mediaUrl(goal.id, card.file!, values)} target="_blank" rel="noreferrer" title="Play it in a tab of its own">
          ↗ Full
        </a>
        <span className="grow" />
        {live && onCommand && knobs && knobs.length > 0 && (
          <button
            className="btn small primary"
            onClick={() =>
              void onCommand({
                cmd: 'room.canvas', goal: goal.id,
                ops: [{ op: 'add', kind: 'decision', title: `${oneLine(card.title, 60)}: these values`, values, from: [{ id: card.id, take: 'its values' }], ...(card.frame ? { frame: card.frame } : {}) }],
              })
            }
            title="Put these values on the board as a decision: what a goal builds to"
          >
            Keep these values
          </button>
        )}
      </div>
    </div>
  );
}

/** Mixing cards: what to take from each, what to make, how many, and which maker. */
function MixDialog({ goal, room, mix, makers, onClose, onCommand }: { goal: Goal; room: Room; mix: Mix; makers: Lens[]; onClose: () => void; onCommand: Cmd }) {
  const [cards, setCards] = useState(mix.cards);
  const [make, setMake] = useState(mix.make);
  const [count, setCount] = useState(1);
  const [maker, setMaker] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const output = MIX_MAKES.find(m => m.make === make)?.output;
  const able = makers.filter(m => m.makes === output);
  const cardOf = (id: string) => room.cards.find(c => c.id === id);
  const submit = async () => {
    setBusy(true);
    const r = await onCommand({ cmd: 'room.mix', goal: goal.id, cards: cards.map(c => ({ id: c.id, take: c.take.trim() || undefined })), make, count, note: note.trim() || undefined, maker: maker || undefined });
    setBusy(false);
    if (r) onClose();
  };
  return (
    <Dialog title="Mix" onClose={onClose} wide>
      <div className="dialog-body muted small">Say what to take from each card; a maker makes something new from just that, and it goes on the board linked to what it came from.</div>
      <Field label="From">
        <div className="mix-list">
          {cards.map((c, i) => {
            const card = cardOf(c.id);
            return (
              <div key={c.id} className="mix-row">
                <span className="card-chip">
                  {card ? `${kindOf(card.kind).icon} ${c.id} · ${oneLine(card.title, 40)}` : c.id}
                </span>
                <span className="muted">take</span>
                <input type="text" list={`takes-${c.id}`} value={c.take} onChange={e => setCards(cs => cs.map((x, j) => (j === i ? { ...x, take: e.target.value } : x)))} placeholder={card ? (TAKES[card.kind]?.[0] ?? 'what matters in it') : ''} aria-label={`What to take from ${c.id}`} autoFocus={i === 0} />
                <datalist id={`takes-${c.id}`}>
                  {(card ? (TAKES[card.kind] ?? []) : []).map(t => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <button className="btn ghost small" onClick={() => setCards(cs => cs.filter((_, j) => j !== i))} aria-label={`Leave ${c.id} out`}>
                  ×
                </button>
              </div>
            );
          })}
          <select value={adding} onChange={e => {
            if (e.target.value) setCards(cs => [...cs, { id: e.target.value, take: '' }]);
            setAdding('');
          }} aria-label="Add a card to the mix">
            <option value="">+ another card…</option>
            {room.cards.filter(c => !cards.some(x => x.id === c.id) && !c.pending).map(c => (
              <option key={c.id} value={c.id}>
                {c.id} · {oneLine(c.title, 50)}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <Field label="Make">
        <div className="mix-make">
          {MIX_MAKES.map(m => (
            <button key={m.make} className={`btn small${make === m.make ? ' primary' : ''}`} onClick={() => setMake(m.make)} disabled={!makers.some(x => x.makes === m.output)} title={makers.some(x => x.makes === m.output) ? '' : `No maker here makes ${m.output} cards`}>
              {m.label}
            </button>
          ))}
          <span className="muted small">×</span>
          <select value={count} onChange={e => setCount(Number(e.target.value))} aria-label="How many takes">
            {[1, 2, 3, 4].map(n => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {able.length > 1 && (
            <select value={maker} onChange={e => setMaker(e.target.value)} aria-label="Maker">
              <option value="">{able[0].name}</option>
              {able.slice(1).map(m => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          {able.length === 1 && <span className="muted small">by {able[0].name}</span>}
        </div>
      </Field>
      <Field label="Anything else">
        <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. keep it readable at a glance, night time" />
      </Field>
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !cards.length || !able.length} onClick={() => void submit()}>
          {busy ? 'Sending…' : 'Mix'}
        </button>
      </div>
    </Dialog>
  );
}

/** Asking a maker directly, about some cards. */
function AskBar({ goal, room, cards, makers, onClose, onCommand }: { goal: Goal; room: Room; cards: string[]; makers: Lens[]; onClose: () => void; onCommand: Cmd }) {
  const [maker, setMaker] = useState(makers[0]?.name ?? '');
  const [text, setText] = useState('');
  const send = async () => {
    if (!text.trim() || !maker) return;
    if (await onCommand({ cmd: 'room.ask', goal: goal.id, maker, text: text.trim(), cards })) onClose();
  };
  return (
    <div className="ask-bar">
      <span className="muted small">Ask</span>
      <select value={maker} onChange={e => setMaker(e.target.value)} aria-label="Maker">
        {makers.map(m => (
          <option key={m.name} value={m.name}>
            {m.name} ({m.makes})
          </option>
        ))}
      </select>
      {cards.length > 0 && <span className="muted small">about {cards.map(id => `${id}${room.cards.find(c => c.id === id) ? '' : '?'}`).join(', ')}</span>}
      <input
        type="text"
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') void send();
          if (e.key === 'Escape') onClose();
        }}
        placeholder="e.g. three more takes, darker"
        aria-label="What to ask"
      />
      <button className="btn small primary" disabled={!text.trim() || !maker} onClick={() => void send()}>
        Send
      </button>
      <button className="btn ghost small" onClick={onClose} aria-label="Cancel">
        ×
      </button>
    </div>
  );
}
