import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Daemon } from './daemon.ts';
import { eventLine } from './format.ts';
import { MCP_SERVER_NAME } from './mcp.ts';

/**
 * The assistant's MetaHarness tools: everything it knows about goals and setup comes through
 * these, and only `propose` leads to a change (when the human applies it).
 */

type TextResult = { content: { type: 'text'; text: string }[] };
type Register = (name: string, config: { description: string; inputSchema: z.ZodType }, cb: (args: any) => Promise<TextResult>) => unknown;

const MAX = 24_000;
const text = (v: unknown): TextResult => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
  return { content: [{ type: 'text', text: s.length > MAX ? `${s.slice(0, MAX)}\n…(cut at ${MAX} characters; narrow the request)` : s }] };
};
const opt = z.string().optional();

/** Commands a proposal may run once applied: setup only, never goals or agents. */
const PROPOSABLE = ['role.update', 'settings.save', 'workflow.save', 'rule.save', 'guide.save', 'mcp.save'];

export const GUIDE_PATH = join(import.meta.dirname, '..', 'GUIDE.md');

export function buildAssistantServer(d: Daemon): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.0.1' });
  const register = server.registerTool.bind(server) as unknown as Register;
  const tool = (name: string, description: string, shape: Record<string, z.ZodType>, run: (a: any) => unknown) =>
    register(name, { description, inputSchema: z.looseObject(shape) }, async a => {
      d.assistantLog('assistant.tool', { tool: name, summary: JSON.stringify(a ?? {}).slice(0, 160) });
      try {
        return text(await run(a ?? {}));
      } catch (e) {
        return text(`Error: ${(e as Error).message}`);
      }
    });

  const goalOf = (id?: string) => {
    const g = id ? d.listGoals().find(x => x.id === id || x.id.startsWith(id)) : d.listGoals()[0];
    if (!g) throw new Error(id ? `There's no goal ${id}. The goals tool lists them.` : 'There are no goals yet.');
    return g;
  };

  tool('goals', 'Every goal, newest first: id, request, status, cost, team size, where it ran, and its outcome.', {}, () =>
    d.listGoals().map(g => ({ id: g.id, request: g.request.slice(0, 300), status: g.status, createdAt: g.createdAt, dir: g.dir, cost: g.cost, agents: g.agents, waitingOnHuman: g.needs, outcome: g.result?.slice(0, 600) ?? null })),
  );

  tool('goal', "One goal: its request, outcome, and team (each agent's role, harness, model, state, cost, tokens and result), and what waits for the human. Default: the latest goal.", { goal: opt }, a => {
    const id = goalOf(a.goal).id;
    const s = d.snapshot(id);
    const g = s.goals[0];
    return {
      ...g,
      agents: g.agents.map(x => ({ name: x.name, role: x.role, harness: x.harness, model: x.model, parent: x.parent, state: x.state, status: x.status, cost: x.cost, costSource: x.costSource, tokens: x.tokens, contextPct: x.contextPct, result: x.doneNote })),
      inbox: s.inbox.map(i => ({ agent: i.agent, kind: i.kind, text: i.text.slice(0, 500) })),
    };
  });

  tool(
    'events',
    "A goal's event log as lines (time, agent, what happened), oldest first. Narrow it with agent, a search (words or a regular expression, case-insensitive) and last (how many lines, default 80).",
    { goal: opt, agent: opt, search: opt, last: z.union([z.string(), z.number()]).optional() },
    a => {
      const id = goalOf(a.goal).id;
      let re: RegExp | undefined;
      if (a.search) {
        try {
          re = new RegExp(a.search, 'i');
        } catch {
          re = new RegExp(String(a.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }
      }
      const lines = d.store
        .since(id)
        .filter(e => !a.agent || e.agent === a.agent)
        .map(eventLine)
        .filter(l => l && (!re || re.test(l)));
      const n = Math.max(1, Math.min(400, Number(a.last) || 80));
      return lines.length ? `${lines.length > n ? `(${lines.length - n} earlier lines left out)\n` : ''}${lines.slice(-n).join('\n')}` : 'No events match.';
    },
  );

  tool('agent', "One agent: its brief (what it was asked), system prompt, where it worked, and its last words or result.", { goal: opt, agent: z.string() }, a => {
    const id = goalOf(a.goal).id;
    const detail = d.agentDetail(id, a.agent);
    const view = d.snapshot(id).goals[0]?.agents.find(x => x.name === a.agent);
    return { ...detail, systemPrompt: detail.systemPrompt?.slice(0, 4000) ?? null, state: view?.state, result: view?.doneNote, cost: view?.cost, tokens: view?.tokens };
  });

  tool('files', "A goal's shared folder (designs, reviews, notes, reports): without a path, the list of files; with one, the file's text.", { goal: opt, path: opt }, a => {
    const g = goalOf(a.goal);
    if (a.path) return d.sharedFile(g.id, a.path).text ?? '(not a text file)';
    const dir = d.snapshot(g.id).goals[0]?.sharedDir;
    if (!dir || !existsSync(dir)) return 'The shared folder is empty.';
    const out: string[] = [];
    const walk = (p: string) => {
      for (const f of readdirSync(p)) {
        if (f === '.history') continue;
        const full = join(p, f);
        if (statSync(full).isDirectory()) walk(full);
        else out.push(`${relative(dir, full)} (${statSync(full).size} bytes)`);
      }
    };
    walk(dir);
    return out.join('\n') || 'The shared folder is empty.';
  });

  tool('costs', "Where a goal's money went: each agent's cost (reported by its harness, or estimated from prices), and tokens by kind (input, cache reads, cache writes, output).", { goal: opt }, a => {
    const g = d.snapshot(goalOf(a.goal).id).goals[0];
    return {
      total: g.cost,
      gatekeeper: g.gatekeeperCost,
      agents: g.agents.map(x => ({ name: x.name, harness: x.harness, model: x.model, cost: x.cost, source: x.costSource, split: x.costSplit, tokens: x.tokens })),
    };
  });

  tool('config', 'The setup: roles (harness, model, backups, approvals), workflows, rules (notes agents get at moments: start, path, new-file, commit, done), skills (guides with files agents read through their skill tool; the skills: line of a role names those it carries, and a skill no role names goes to every role), settings (approvals, prices, cache), the harnesses on this machine and what they can do, and accounts near their limits.', {}, () => {
    const c = d.configView();
    return {
      folders: c.scopes,
      roles: c.roles.map(r => ({ name: r.name, savedIn: r.scope, harness: r.harness, model: r.model, fallback: r.fallback, goodAt: r.goodAt, helper: r.helper, approvals: r.approvals || 'as in settings', allow: r.allow })),
      builtInRoles: [d.config.settings.gatekeeper, d.config.settings.assistant].filter(n => !c.roles.some(r => r.name === n)),
      workflows: c.workflows.map(w => ({ name: w.name, savedIn: w.scope, goodAt: w.goodAt })),
      rules: c.rules.map(r => ({ name: r.name, savedIn: r.scope, on: r.on, when: r.when, roles: r.roles, paths: r.paths, description: r.description, body: r.body })),
      skills: c.skills.map(k => ({ name: k.name, folder: k.dir, from: k.source, on: k.on, carriedBy: k.carriedBy.length ? k.carriedBy : 'every role', pointedBy: k.pointedBy, harness: k.harness, description: k.description })),
      settings: c.settings.effective,
      harnesses: c.harnesses.map(h => ({ id: h.id, title: h.title, runsHere: h.runnable, models: h.models, can: h.manifest })),
      accounts: d.snapshot().accounts,
    };
  });

  tool('guide', "MetaHarness's user guide: setup, roles, workflows, approvals, costs, harnesses, troubleshooting. With search, only the sections that mention it.", { search: opt }, a => {
    const guide = readFileSync(GUIDE_PATH, 'utf8');
    if (!a.search) return guide;
    const sections = guide.split(/\n(?=## )/);
    const hits = sections.filter(s => s.toLowerCase().includes(String(a.search).toLowerCase()));
    return hits.join('\n\n') || `Nothing in the guide mentions "${a.search}".`;
  });

  tool(
    'propose',
    `Suggest a setup change; the human sees it in the app and applies it with one click. command is one of: ${PROPOSABLE.join(', ')}. ` +
      'role.update: { name, changes: { model?, harness?, fallback?: [..], goodAt?, approvals?, allow?: [..], skills?: [..], instructions? } }. ' +
      'settings.save: { scope: "personal" | "repo", patch: { approvals?, models?: { "harness/model": { prices?: { input, output, cacheRead?, cacheWrite? }, cacheMinutes? } } } } (prices in dollars per million tokens). ' +
      'workflow.save: { scope, name, goodAt, body }. ' +
      'rule.save: { scope, name, when: start|path|new-file|commit|done, description, body, roles?: [..], paths?: [..], sections?, include?, requires?, missing?, changes?: [..], unlessChanged?, edited?, skill? (a skill the note points at; then body may be empty) }; ' +
      'to turn a rule or skill off or on without a file, settings.save with patch: { rules: { "<name>": false|true } } or { skills: { … } }. Always give a one-line summary of the change and why.',
    { summary: z.string(), command: z.string(), args: z.record(z.string(), z.unknown()).optional() },
    a => {
      if (!PROPOSABLE.includes(a.command)) return `I can't propose ${a.command}. Proposable: ${PROPOSABLE.join(', ')}.`;
      const p = d.assistant.propose(String(a.summary), { cmd: a.command, ...(a.args ?? {}) });
      return `Proposed (${p.id}). The human sees it with an Apply button; it isn't applied until they click it.`;
    },
  );

  return server;
}
