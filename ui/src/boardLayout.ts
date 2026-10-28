import type { BoardFrame, CanvasCard } from './types.ts';

/**
 * Where everything sits on a room's board (design §21). What you placed stays where you put it;
 * the rest (new cards, frames never moved, everything after a tidy) flows into columns beside
 * it, in the order it came. A frame lays its cards out itself, in one to three columns.
 */

export const CARD_W = 232;
export const GAP = 14;
const PAD = 12;
const HEAD = 30;
/** Columns the flow fills before it starts a new row of its own. */
const FLOW_COLS = 4;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardLayout {
  cards: Map<string, Box>;
  frames: Map<string, Box>;
  /** Everything, for fitting the view. */
  bounds: Box;
}

/** A frame's columns: more as it fills. */
const frameCols = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : 3);

export function layoutBoard(cards: CanvasCard[], frames: BoardFrame[], height: (id: string) => number): BoardLayout {
  const out: BoardLayout = { cards: new Map(), frames: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  const known = new Set(frames.map(f => f.id));
  // Each frame's size, from its cards stacked in its columns.
  const inside = new Map<string, { id: string; x: number; y: number; h: number }[]>();
  const size = new Map<string, { w: number; h: number }>();
  for (const f of frames) {
    const members = cards.filter(c => c.frame === f.id);
    const cols = frameCols(members.length);
    const ys = Array<number>(cols).fill(HEAD + PAD);
    const placed = members.map(c => {
      const col = ys.indexOf(Math.min(...ys));
      const h = height(c.id);
      const at = { id: c.id, x: PAD + col * (CARD_W + GAP), y: ys[col], h };
      ys[col] += h + GAP;
      return at;
    });
    inside.set(f.id, placed);
    size.set(f.id, { w: cols * CARD_W + (cols - 1) * GAP + 2 * PAD, h: Math.max(HEAD + 56, Math.max(...ys) - GAP + PAD) });
  }

  // What you placed.
  const placedItems: Box[] = [];
  for (const f of frames) if (f.at) placedItems.push({ ...f.at, ...size.get(f.id)! });
  for (const c of cards) if (c.at && !(c.frame && known.has(c.frame))) placedItems.push({ ...c.at, w: CARD_W, h: height(c.id) });

  // The rest flows into columns to the right of it: frames take as many columns as they're wide.
  const x0 = placedItems.length ? Math.max(...placedItems.map(b => b.x + b.w)) + 60 : 0;
  const y0 = placedItems.length ? Math.min(...placedItems.map(b => b.y)) : 0;
  const colW = CARD_W + GAP;
  const ys = Array<number>(FLOW_COLS).fill(y0);
  const flow = (w: number, h: number): { x: number; y: number } => {
    const span = Math.min(FLOW_COLS, Math.ceil((w + GAP) / colW));
    let best = 0;
    let bestY = Infinity;
    for (let i = 0; i + span <= FLOW_COLS; i++) {
      const y = Math.max(...ys.slice(i, i + span));
      if (y < bestY) {
        best = i;
        bestY = y;
      }
    }
    for (let i = best; i < best + span; i++) ys[i] = bestY + h + GAP * 2;
    return { x: x0 + best * colW, y: bestY };
  };

  for (const f of frames) {
    const s = size.get(f.id)!;
    const at = f.at ?? flow(s.w, s.h);
    out.frames.set(f.id, { ...at, ...s });
    for (const c of inside.get(f.id)!) out.cards.set(c.id, { x: at.x + c.x, y: at.y + c.y, w: CARD_W, h: c.h });
  }
  for (const c of cards) {
    if (c.frame && known.has(c.frame)) continue;
    const h = height(c.id);
    out.cards.set(c.id, { ...(c.at ?? flow(CARD_W, h)), w: CARD_W, h });
  }

  const all = [...out.frames.values(), ...out.cards.values()];
  if (all.length) {
    const x = Math.min(...all.map(b => b.x));
    const y = Math.min(...all.map(b => b.y));
    out.bounds = { x, y, w: Math.max(...all.map(b => b.x + b.w)) - x, h: Math.max(...all.map(b => b.y + b.h)) - y };
  }
  return out;
}

/** Where the line from a box's centre towards a point leaves the box: arrows start and end at card edges. */
export function edgePoint(b: Box, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const s = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** The frame a point is in, if any: where a dragged card lands. */
export function frameAt(layout: BoardLayout, p: { x: number; y: number }): string | undefined {
  for (const [id, b] of layout.frames) if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return id;
  return undefined;
}
