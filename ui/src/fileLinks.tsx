import type { ReactNode } from 'react';
import type { MhEvent } from './types.ts';

/** The shared files to find in text, and what clicking one does. */
export interface FileLinks {
  re?: RegExp;
  open: (path: string) => void;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every shared file's path, as a pattern that finds them in text: with or without the `shared/`
 * in front, or as the full path agents are given (under `sharedDir`).
 */
export function fileMentions(events: MhEvent[], sharedDir?: string): RegExp | undefined {
  const paths = [...new Set(events.filter(e => e.type === 'shared.write').map(e => String(e.data.path)))];
  if (!paths.length) return undefined;
  // Longest first, so a path wins over a shorter one it ends with.
  const alts = paths.sort((a, b) => b.length - a.length).map(escape);
  const full = sharedDir ? `${escape(sharedDir.replace(/\/+$/, ''))}/|` : '';
  return new RegExp(`(?:${full}(?<![\\w./-])(?:shared/)?)(${alts.join('|')})(?![\\w/-]|\\.\\w)`, 'g');
}

/** Text with each shared file it names turned into a link that opens the file. */
export function withFileLinks(text: string, links?: FileLinks): ReactNode {
  if (!links?.re) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(links.re)) {
    out.push(text.slice(at, m.index));
    const path = m[1];
    out.push(
      // A full path shows as its place in the shared folder.
      <button key={m.index} className="file-link" onClick={() => links.open(path)} title={`Read ${m[0]}`}>
        {m[0].startsWith('/') ? path : m[0]}
      </button>,
    );
    at = m.index + m[0].length;
  }
  if (!out.length) return text;
  out.push(text.slice(at));
  return out;
}

/** The shared file a whole string names (a Markdown link's target), if it names one. */
export function fileAt(text: string, links?: FileLinks): string | undefined {
  if (!links?.re) return undefined;
  for (const m of text.matchAll(links.re)) if (m.index === 0 && m[0].length === text.length) return m[1];
  return undefined;
}

/** The shared files a text names, each once, in order. */
export function filesNamed(text: string, links?: FileLinks): string[] {
  if (!links?.re) return [];
  return [...new Set([...text.matchAll(links.re)].map(m => m[1]))];
}
