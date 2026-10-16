import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Role } from './types.ts';

export interface Config {
  roles: Map<string, Role>;
  methodology: string;
  helperMethodology: string;
  playbooks: Map<string, string>;
}

const DEFAULT_METHODOLOGY = `You're part of a team of AI agents from different providers working toward one goal.
Call \`team\` to see who's on it. Put long things in the shared folder and keep messages short.
Ask the person who knows (\`send\`) instead of guessing. Post a \`status\` line when you start
something new. When finished, call \`done\` with a short note on what you did and where it is.`;

const DEFAULT_HELPER_METHODOLOGY = `You're a quick helper for another AI agent. Answer the brief and nothing more.
Keep it short, then call \`done\` with the answer as the note.`;

/** Splits "---\nkey: value\n---\nbody" into metadata and body. Leading HTML comments are ignored. */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const t = text.replace(/^﻿/, '').replace(/^(\s*<!--[\s\S]*?-->\s*)+/, '');
  const meta: Record<string, string> = {};
  if (!t.startsWith('---')) return { meta, body: t.trim() };
  const end = t.indexOf('\n---', 3);
  if (end < 0) return { meta, body: t.trim() };
  for (const line of t.slice(3, end).split('\n')) {
    const m = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (m) meta[m[1].toLowerCase().replace(/-/g, '_')] = m[2].replace(/^["']|["']$/g, '');
  }
  const after = t.indexOf('\n', end + 4);
  return { meta, body: after < 0 ? '' : t.slice(after + 1).trim() };
}

function readIf(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => join(dir, f));
}

/** Loads config from each directory in order; later directories override earlier ones. */
export function loadConfig(dirs: string[]): Config {
  const cfg: Config = {
    roles: new Map(),
    methodology: DEFAULT_METHODOLOGY,
    helperMethodology: DEFAULT_HELPER_METHODOLOGY,
    playbooks: new Map(),
  };
  for (const dir of dirs) {
    cfg.methodology = readIf(join(dir, 'methodology.md')) ?? cfg.methodology;
    cfg.helperMethodology = readIf(join(dir, 'helper-methodology.md')) ?? cfg.helperMethodology;
    for (const file of markdownFiles(join(dir, 'roles'))) {
      const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'));
      const name = basename(file, '.md');
      cfg.roles.set(name, {
        name,
        harness: meta.harness ?? 'claude-code',
        model: meta.model ?? '',
        goodAt: meta.good_at ?? '',
        instructions: body,
        helper: /^(true|yes|1)$/i.test(meta.helper ?? ''),
        file,
      });
    }
    for (const file of markdownFiles(join(dir, 'playbooks'))) {
      cfg.playbooks.set(basename(file, '.md'), readFileSync(file, 'utf8').trim());
    }
  }
  return cfg;
}
