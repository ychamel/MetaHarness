import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * settings.json in the personal and the repository's .metaharness folder (the repository's wins,
 * key by key): how approvals are decided, prompt-cache reminders, context handoffs, stall reports,
 * per-model prices and cache lifetimes, and which rules are on.
 */

/** Dollars per million tokens. */
export interface Prices {
  input: number;
  output: number;
  /** Reading the prompt cache; input's price when unset. */
  cacheRead?: number;
  /** Writing the prompt cache; input's price when unset (OpenAI and Google don't charge extra). */
  cacheWrite?: number;
}

export interface ModelSettings {
  prices?: Prices;
  /** How long the provider keeps an idle prompt cache, in minutes. */
  cacheMinutes?: number;
}

/**
 * ask: the human decides whatever the rules don't. gatekeeper: a model in the gatekeeper role
 * decides, and passes the risky ones to the human. harness: each harness's own automatic
 * approvals where it has them (Claude Code's auto mode), the gatekeeper for the rest.
 */
export type ApprovalMode = 'ask' | 'gatekeeper' | 'harness';
export const APPROVAL_MODES: ApprovalMode[] = ['ask', 'gatekeeper', 'harness'];

export interface Settings {
  approvals: ApprovalMode;
  /** The role that judges approvals. */
  gatekeeper: string;
  /** The role that answers the human's questions in the app. */
  assistant: string;
  /** Tell an agent's spawner when its prompt cache is about to expire. */
  cacheReminders: boolean;
  /** How long before expiry the reminder goes out, in seconds. */
  cacheRemindSec: number;
  /** Below this context size (tokens) an expiring cache isn't worth a reminder. */
  cacheRemindMinTokens: number;
  /** When a model has no cacheMinutes of its own. */
  defaultCacheMinutes: number;
  /** How often to ask each harness where its plan's limits stand, in minutes; 0: only when asked. */
  limitCheckMinutes: number;
  /** At this much of its context window, an agent continues in a fresh session from a handoff; 0: never. */
  contextHandoffPct: number;
  /** Agents waiting this long with nothing happening are reported to the lead; 0: never. */
  stallMinutes: number;
  /** By "harness/model", or just "model" for every harness that offers it. */
  models: Record<string, ModelSettings>;
  /** Rules turned off (false) or back on (true) by name, without a file (design §18). */
  rules: Record<string, boolean>;
  /** Skills turned off (false) or back on (true) by name. */
  skills: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  approvals: 'gatekeeper',
  gatekeeper: 'gatekeeper',
  assistant: 'assistant',
  cacheReminders: true,
  cacheRemindSec: 60,
  cacheRemindMinTokens: 30_000,
  defaultCacheMinutes: 5,
  limitCheckMinutes: 10,
  contextHandoffPct: 80,
  stallMinutes: 10,
  models: {},
  rules: {},
  skills: {},
};

const FILE = 'settings.json';

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

function readPrices(v: unknown): Prices | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const input = num(o.input);
  const output = num(o.output);
  if (input === undefined || output === undefined) return undefined;
  // prices.json (the older Codex-only file) calls a cache read "cachedInput".
  const cacheRead = num(o.cacheRead) ?? num(o.cachedInput);
  const cacheWrite = num(o.cacheWrite);
  return { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
}

function readModel(v: unknown): ModelSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: ModelSettings = {};
  const prices = readPrices(o.prices);
  if (prices) out.prices = prices;
  const cacheMinutes = num(o.cacheMinutes);
  if (cacheMinutes !== undefined) out.cacheMinutes = cacheMinutes;
  return out;
}

/** Applies one file's settings over `s`, keeping what it doesn't set. */
function apply(s: Settings, raw: Record<string, unknown>): void {
  if (typeof raw.approvals === 'string' && APPROVAL_MODES.includes(raw.approvals as ApprovalMode)) s.approvals = raw.approvals as ApprovalMode;
  if (typeof raw.gatekeeper === 'string' && raw.gatekeeper.trim()) s.gatekeeper = raw.gatekeeper.trim();
  if (typeof raw.assistant === 'string' && raw.assistant.trim()) s.assistant = raw.assistant.trim();
  if (typeof raw.cacheReminders === 'boolean') s.cacheReminders = raw.cacheReminders;
  for (const k of ['cacheRemindSec', 'cacheRemindMinTokens', 'defaultCacheMinutes', 'limitCheckMinutes', 'contextHandoffPct', 'stallMinutes'] as const) if (num(raw[k]) !== undefined) s[k] = num(raw[k])!;
  if (raw.models && typeof raw.models === 'object') {
    for (const [key, v] of Object.entries(raw.models)) s.models[key] = { ...s.models[key], ...readModel(v) };
  }
  for (const k of ['rules', 'skills'] as const) {
    const v = raw[k];
    if (v && typeof v === 'object') for (const [name, on] of Object.entries(v)) if (typeof on === 'boolean') s[k][name] = on;
  }
}

/** Settings from each directory in order; later ones override earlier ones. */
export function loadSettings(dirs: string[]): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, models: {}, rules: {}, skills: {} };
  for (const dir of dirs) {
    // The older prices.json: { "<model>": { input, cachedInput, output } }.
    const old = readJson(join(dir, 'prices.json'));
    if (old) for (const [model, p] of Object.entries(old)) if (readPrices(p)) s.models[model] = { ...s.models[model], prices: readPrices(p) };
    const raw = readJson(join(dir, FILE));
    if (raw) apply(s, raw);
  }
  return s;
}

/** What one folder's settings.json says, for editing it. */
export function readSettingsFile(dir: string): Record<string, unknown> {
  return readJson(join(dir, FILE)) ?? {};
}

/**
 * Writes one folder's settings.json. `patch` replaces the keys it names; a model set to null or
 * {} is removed, as is a top-level key set to null.
 */
export function writeSettingsFile(dir: string, patch: Record<string, unknown>): string {
  const cur = readSettingsFile(dir);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'models' && v && typeof v === 'object') {
      const models = { ...((cur.models as Record<string, unknown>) ?? {}) };
      for (const [m, ms] of Object.entries(v as Record<string, unknown>)) {
        const clean = ms === null ? {} : readModel(ms);
        if (Object.keys(clean).length) models[m] = clean;
        else delete models[m];
      }
      if (Object.keys(models).length) cur.models = models;
      else delete cur.models;
    } else if ((k === 'rules' || k === 'skills') && v && typeof v === 'object') {
      // One at a time: true or false sets it, null goes back to the folder before.
      const switches = { ...((cur[k] as Record<string, unknown>) ?? {}) };
      for (const [name, on] of Object.entries(v as Record<string, unknown>)) {
        if (typeof on === 'boolean') switches[name] = on;
        else delete switches[name];
      }
      if (Object.keys(switches).length) cur[k] = switches;
      else delete cur[k];
    } else if (v === null) delete cur[k];
    else cur[k] = v;
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, FILE);
  writeFileSync(path, JSON.stringify(cur, null, 2) + '\n');
  return path;
}

/** A model's settings: "harness/model" over "model". */
export function modelSettings(s: Settings, harness: string, model: string): ModelSettings {
  return { ...s.models[model], ...s.models[`${harness}/${model}`] };
}

export function cacheMinutes(s: Settings, harness: string, model: string): number {
  return modelSettings(s, harness, model).cacheMinutes ?? s.defaultCacheMinutes;
}
