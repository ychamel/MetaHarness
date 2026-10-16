import { DatabaseSync } from 'node:sqlite';
import type { MhEvent, NewEvent } from './types.ts';

type Listener = (e: MhEvent) => void;

/** Append-only event log in SQLite. The single source of truth for what happened. */
export class EventStore {
  private db: DatabaseSync;
  private listeners = new Set<Listener>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        ts     TEXT NOT NULL,
        goal   TEXT NOT NULL,
        agent  TEXT,
        parent TEXT,
        type   TEXT NOT NULL,
        data   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_goal ON events (goal, seq);
    `);
  }

  append(e: NewEvent): MhEvent {
    const ts = new Date().toISOString();
    const data = e.data ?? {};
    const r = this.db
      .prepare('INSERT INTO events (ts, goal, agent, parent, type, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, e.goal, e.agent ?? null, e.parent ?? null, e.type, JSON.stringify(data));
    const ev: MhEvent = { seq: Number(r.lastInsertRowid), ts, goal: e.goal, type: e.type, data };
    if (e.agent) ev.agent = e.agent;
    if (e.parent) ev.parent = e.parent;
    for (const l of this.listeners) l(ev);
    return ev;
  }

  /** Events after `afterSeq`, for one goal or all goals. */
  since(goal?: string, afterSeq = 0): MhEvent[] {
    const rows = goal
      ? this.db.prepare('SELECT * FROM events WHERE goal = ? AND seq > ? ORDER BY seq').all(goal, afterSeq)
      : this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq').all(afterSeq);
    return rows.map(row => {
      const r = row as Record<string, string | number | null>;
      const ev: MhEvent = {
        seq: Number(r.seq),
        ts: String(r.ts),
        goal: String(r.goal),
        type: String(r.type),
        data: JSON.parse(String(r.data)),
      };
      if (r.agent) ev.agent = String(r.agent);
      if (r.parent) ev.parent = String(r.parent);
      return ev;
    });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.listeners.clear();
    this.db.close();
  }
}
