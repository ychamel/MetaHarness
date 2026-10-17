import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../src/daemon.ts';
import { FakeAdapter, demoScripts, type FakeScript } from '../src/adapters/fake.ts';
import { git } from '../src/git.ts';

const configDir = join(import.meta.dirname, '..', '.metaharness');

/** A throwaway repository with one commit, for the agents to work on. */
export function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh-repo-'));
  for (const args of [['init', '-q', '-b', 'trunk'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.com']]) git(dir, ...args);
  writeFileSync(join(dir, 'README.md'), '# Test repo\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Initial commit');
  return dir;
}

export function makeDaemon(scripts: Record<string, FakeScript> = demoScripts, o: { quickTimeoutMs?: number; repo?: string } = {}) {
  return new Daemon({
    home: mkdtempSync(join(tmpdir(), 'mh-test-')),
    repo: o.repo ?? makeRepo(),
    dbPath: ':memory:',
    configDirs: [configDir],
    adapters: { fake: new FakeAdapter(scripts) },
    harnessOverride: 'fake',
    quickTimeoutMs: o.quickTimeoutMs,
    gitPollMs: 0,
  });
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms).unref())]);
}

export const settle = () => new Promise(r => setTimeout(r, 30));
