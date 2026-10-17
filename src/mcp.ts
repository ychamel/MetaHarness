import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Daemon } from './daemon.ts';
import { TOOL_DOCS, TOOL_NAMES } from './hub.ts';

/** The name harnesses see us under; Claude Code calls our tools mcp__metaharness__<tool>. */
export const MCP_SERVER_NAME = 'metaharness';
/** Claude Code's --permission-prompt-tool points here. Agents never need to call it. */
export const APPROVAL_TOOL = 'approval';

// Loose schemas: every field optional, unknown fields kept, so the hub can read aliases
// ("message" for "text", "recipient" for "to") instead of the SDK rejecting the call.
const flexible = z.union([z.string(), z.number(), z.boolean()]);
const SCHEMAS: Record<(typeof TOOL_NAMES)[number], z.ZodType> = {
  team: z.looseObject({}),
  spawn: z.looseObject({ role: z.string().optional(), brief: z.string().optional(), quick: flexible.optional(), name: z.string().optional() }),
  send: z.looseObject({ to: z.string().optional(), text: z.string().optional(), urgent: flexible.optional() }),
  wait: z.looseObject({ timeout: flexible.optional() }),
  status: z.looseObject({ text: z.string().optional() }),
  done: z.looseObject({ note: z.string().optional() }),
};

function describe(name: (typeof TOOL_NAMES)[number]): string {
  const doc = TOOL_DOCS[name];
  const params = Object.entries(doc.params).map(([k, v]) => `- ${k}: ${v}`);
  return params.length ? `${doc.description}\n\nParameters:\n${params.join('\n')}` : doc.description;
}

type TextResult = { content: { type: 'text'; text: string }[] };
// The SDK's generic signature ties the callback type to the schema; ours takes anything and reads it leniently.
type Register = (name: string, config: { description: string; inputSchema: z.ZodType }, cb: (args: unknown) => Promise<TextResult>) => unknown;

function buildServer(d: Daemon, goal: string, agent: string): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.0.1' });
  const register = server.registerTool.bind(server) as unknown as Register;
  for (const name of TOOL_NAMES) {
    register(name, { description: describe(name), inputSchema: SCHEMAS[name] }, async args => ({
      content: [{ type: 'text', text: await d.hub.call(goal, agent, name, args) }],
    }));
  }
  register(
    APPROVAL_TOOL,
    {
      description: 'Used by the harness to ask the human for permission. You never need to call this yourself.',
      inputSchema: z.looseObject({ tool_name: z.string().optional(), input: z.unknown().optional() }),
    },
    async (args: unknown) => {
      const a = (args ?? {}) as { tool_name?: string; input?: unknown };
      const rec = d.agent(goal, agent);
      const tool = a.tool_name ?? 'a tool';
      const detail = summarizeInput(a.input);
      const decision = rec ? await d.requestApproval(rec, tool, detail) : { allow: false, message: 'Unknown agent.' };
      const body = decision.allow
        ? { behavior: 'allow', updatedInput: a.input ?? {} }
        : { behavior: 'deny', message: decision.message ?? 'The human denied this.' };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    },
  );
  return server;
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const main = o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern;
    if (main !== undefined) return String(main).slice(0, 300);
  }
  return JSON.stringify(input ?? {}).slice(0, 300);
}

/**
 * Handles POST /mcp/<token>. Each agent has its own token, so the tools know who is calling.
 * Stateless: a fresh server and transport per request, which also keeps long wait() calls independent.
 */
export async function handleMcp(d: Daemon, token: string, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const who = d.agentForToken(token);
  if (!who) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown agent token.' }, id: null }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  const server = buildServer(d, who.goal, who.agent);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
