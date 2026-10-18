import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, relative, sep } from 'node:path';

/**
 * The shared folder's history (design §6). Agents write ordinary files; a scan every few seconds
 * finds what changed, keeps every version in .history/<path>/, and leaves it to the daemon to
 * say who wrote it and tell the rest of the team.
 */

export const HISTORY = '.history';

/** Editor and system droppings that aren't anyone's document. */
const NOISE = /(^\.#|~$|\.sw[a-p]$|^\.DS_Store$|^#.*#$)/;

/** Larger files are still reported, but not copied into the history. */
const MAX_HISTORY_BYTES = 5 * 1024 * 1024;

export interface SharedFile {
  size: number;
  mtimeMs: number;
  hash: string;
  version: number;
  /** The first agent known to write it. By convention only the owner edits it. */
  owner?: string;
  /** Where its latest version is kept, if it was copied. */
  history?: string;
}

export interface SharedChange {
  /** Relative to the shared folder, with forward slashes. */
  path: string;
  deleted: boolean;
  /** What was known before this change; unset for a new file. */
  before?: SharedFile;
}

export class SharedFolder {
  readonly dir: string;
  readonly files = new Map<string, SharedFile>();
  /** Deleted files, so one written again carries on from its last version and owner. */
  private gone = new Map<string, SharedFile>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Takes what's on disk as known, without reporting it: after a restart. `known` carries each
   * file's version and owner from the event log.
   */
  seed(known: Map<string, { version: number; owner?: string }> = new Map()): void {
    for (const [path, st] of this.walk()) {
      const k = known.get(path);
      this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, hash: this.hash(path, st.size), version: k?.version ?? 1, owner: k?.owner });
    }
    for (const [path, k] of known) if (!this.files.has(path)) this.gone.set(path, { size: -1, mtimeMs: 0, hash: '', ...k });
  }

  /** Files written or deleted since the last scan. Call record() for each to keep its version. */
  scan(): SharedChange[] {
    const seen = new Set<string>();
    const out: SharedChange[] = [];
    for (const [path, st] of this.walk()) {
      seen.add(path);
      const known = this.files.get(path);
      const before = known ?? this.gone.get(path);
      this.gone.delete(path);
      if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;
      const hash = this.hash(path, st.size);
      if (known && known.hash === hash) {
        // Touched, not changed.
        known.mtimeMs = st.mtimeMs;
        continue;
      }
      out.push({ path, deleted: false, before: before && { ...before } });
      this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, hash, version: (before?.version ?? 0) + 1, owner: before?.owner });
    }
    for (const [path, known] of this.files) {
      if (seen.has(path)) continue;
      this.files.delete(path);
      this.gone.set(path, known);
      out.push({ path, deleted: true, before: known });
    }
    return out;
  }

  /**
   * Copies a file's new version into the history, as .history/<path>/<version>-<writer><ext>.
   * Sets the owner if it has none. Returns the copy's path, relative to the shared folder.
   */
  record(path: string, by: string | undefined): string | undefined {
    const f = this.files.get(path);
    if (!f) return undefined;
    if (by && !f.owner) f.owner = by;
    if (f.size > MAX_HISTORY_BYTES) return undefined;
    const name = `${String(f.version).padStart(3, '0')}-${by ?? 'unknown'}${extname(path)}`;
    const rel = `${HISTORY}/${path}/${name}`;
    try {
      mkdirSync(join(this.dir, HISTORY, path), { recursive: true });
      copyFileSync(join(this.dir, path), join(this.dir, rel));
      f.history = rel;
      return rel;
    } catch {
      // Deleted or replaced while we looked; the next scan sees what's there.
      return undefined;
    }
  }

  private hash(path: string, size: number): string {
    try {
      // Big files are compared by size alone; reading them every few seconds isn't worth it.
      if (size > MAX_HISTORY_BYTES) return `size:${size}`;
      return createHash('sha1').update(readFileSync(join(this.dir, path))).digest('hex');
    } catch {
      return '';
    }
  }

  private *walk(): Generator<[string, { size: number; mtimeMs: number }]> {
    if (!existsSync(this.dir)) return;
    const stack = [this.dir];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (NOISE.test(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!(dir === this.dir && e.name === HISTORY)) stack.push(full);
        } else if (e.isFile()) {
          try {
            const st = statSync(full);
            yield [relative(this.dir, full).split(sep).join('/'), { size: st.size, mtimeMs: st.mtimeMs }];
          } catch {
            // Gone already.
          }
        }
      }
    }
  }
}
