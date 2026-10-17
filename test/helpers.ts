import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon, type LimitPolicy } from '../src/daemon.ts';
import type { HarnessAdapter } from '../src/adapters/types.ts';
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

/**
 * A daemon with its own roles and adapters, no harness override: roles run where their files
 * say, so backups and accounts behave as they would for real. `roles` maps a role name to its file.
 */
export function makeTeam(o: { roles: Record<string, string>; adapters: Record<string, HarnessAdapter>; limits?: Partial<LimitPolicy> }) {
  const configDir = mkdtempSync(join(tmpdir(), 'mh-config-'));
  mkdirSync(join(configDir, 'roles'));
  for (const [name, text] of Object.entries(o.roles)) writeFileSync(join(configDir, 'roles', `${name}.md`), text);
  return new Daemon({
    home: mkdtempSync(join(tmpdir(), 'mh-test-')),
    repo: makeRepo(),
    dbPath: ':memory:',
    configDirs: [configDir],
    adapters: o.adapters,
    gitPollMs: 0,
    limits: o.limits,
  });
}
