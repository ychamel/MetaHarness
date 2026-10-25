import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * MCP servers a role names with `mcp:` (design §17). Names are resolved on each machine: first in
 * MetaHarness's own mcp.json (in a config directory), then among the servers the role's harness
 * already has under that name.
 */

/** One server, in the shape every harness shares: a command to run, or a URL. */
export interface McpServerDef {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** A server a role asked for; `def` is set when MetaHarness has its definition. */
export interface McpServerRef {
  name: string;
  def?: McpServerDef;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Definitions from mcp.json in each config directory ({"mcpServers": {...}}); later directories win. */
export function loadMcpDefs(dirs: string[]): Map<string, McpServerDef> {
  const out = new Map<string, McpServerDef>();
  for (const dir of dirs) {
    const servers = readJson(join(dir, 'mcp.json'))?.mcpServers;
    if (servers && typeof servers === 'object') for (const [name, def] of Object.entries(servers)) out.set(name, def as McpServerDef);
  }
  return out;
}

/**
 * A server as Claude Code has it configured: the project's .mcp.json, this project's entry in
 * ~/.claude.json, then the user's own servers there.
 */
export function claudeMcpDef(name: string, cwd: string, home = homedir()): McpServerDef | undefined {
  const fromProjectFile = readJson(join(cwd, '.mcp.json'))?.mcpServers?.[name];
  if (fromProjectFile) return fromProjectFile;
  const cfg = readJson(join(home, '.claude.json'));
  return cfg?.projects?.[cwd]?.mcpServers?.[name] ?? cfg?.mcpServers?.[name];
}

/** The names Claude Code knows, for `mh doctor`. */
export function claudeMcpNames(cwd: string, home = homedir()): string[] {
  const cfg = readJson(join(home, '.claude.json'));
  return [
    ...Object.keys(readJson(join(cwd, '.mcp.json'))?.mcpServers ?? {}),
    ...Object.keys(cfg?.projects?.[cwd]?.mcpServers ?? {}),
    ...Object.keys(cfg?.mcpServers ?? {}),
  ];
}

/** A server from the user's own Antigravity config, which agy itself doesn't see under MetaHarness (src/adapters/agy.ts). */
export function agyMcpDef(name: string, home = homedir()): McpServerDef | undefined {
  return readJson(join(home, '.gemini', 'config', 'mcp_config.json'))?.mcpServers?.[name];
}

export const mcpJsonExists =(dir: string) => existsSync(join(dir, 'mcp.json'));
