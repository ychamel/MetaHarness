#!/usr/bin/env node
// A scripted ACP agent for tests. What it does depends on the prompt:
//   BRIEF:steps       three "sleep" tool calls with thinking time between them
//   BRIEF:permission  asks permission for `git push`, `git status` and an edit, and says what it got
//   BRIEF:terminal    runs `echo hi` through the client's terminal and repeats the output
//   anything else     answers "Got: <prompt>"
// Every message it receives (and its environment at start) goes to FAKE_ACP_LOG as JSON lines.
import { appendFileSync } from 'node:fs';

const LOG = process.env.FAKE_ACP_LOG;
const log = m => LOG && appendFileSync(LOG, JSON.stringify(m) + '\n');
log({ env: { GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS ?? null, MH_OWN_BRANCH: process.env.MH_OWN_BRANCH ?? null }, cwd: process.cwd() });

const MODELS = ['free/default', 'free/fast'];
let nextId = 1000;
const waiting = new Map();
let cancelled = false;
let model = 'free/default';
let thought = 'medium';

const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const request = (method, params) => {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise(resolve => waiting.set(id, resolve));
};
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: MODELS.map(value => ({ value, name: value })) },
  { id: 'thought', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: thought, options: ['low', 'medium', 'high'].map(value => ({ value, name: value })) },
];

async function prompt(p) {
  const s = p.sessionId;
  const text = p.prompt.filter(b => !b.annotations?.audience?.includes('assistant')).map(b => b.text).join('\n');
  cancelled = false;
  if (text.includes('BRIEF:steps')) {
    say(s, 'Working.');
    for (let i = 1; i <= 3; i++) {
      update(s, { sessionUpdate: 'tool_call', toolCallId: `c${i}`, title: `sleep ${i}`, kind: 'execute', status: 'in_progress', rawInput: { command: `sleep ${i}` } });
      await sleep(150);
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: `c${i}`, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'slept' } }] });
      // Thinking about the next step.
      await sleep(150);
      if (cancelled) return { stopReason: 'cancelled' };
    }
    say(s, 'All steps done.');
  } else if (text.includes('BRIEF:permission')) {
    const ask = async (toolCall) => {
      const r = await request('session/request_permission', {
        sessionId: s, toolCall,
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
      });
      return r.outcome.outcome === 'selected' ? r.outcome.optionId : 'cancelled';
    };
    const push = await ask({ toolCallId: 'p1', title: 'bash', kind: 'execute', rawInput: { command: 'git push origin main' } });
    const status = await ask({ toolCallId: 'p2', title: 'bash', kind: 'execute', rawInput: { command: 'git status' } });
    const edit = await ask({ toolCallId: 'p3', title: 'edit', kind: 'edit', locations: [{ path: `${process.cwd()}/a.txt` }] });
    say(s, `push:${push} status:${status} edit:${edit}`);
  } else if (text.includes('BRIEF:terminal')) {
    const { terminalId } = await request('terminal/create', { sessionId: s, command: 'echo', args: ['hi'] });
    update(s, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'echo hi', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hi' } });
    await request('terminal/wait_for_exit', { sessionId: s, terminalId });
    const out = await request('terminal/output', { sessionId: s, terminalId });
    await request('terminal/release', { sessionId: s, terminalId });
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    say(s, `Output: ${out.output}`);
  } else {
    say(s, `Got: ${text}`);
  }
  update(s, { sessionUpdate: 'usage_update', used: 5000, size: 100000, cost: { amount: 0.0123, currency: 'USD' } });
  return { stopReason: 'end_turn', usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } };
}

async function handle(m) {
  log({ method: m.method, params: m.params });
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      return { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: { resume: {} } }, authMethods: [] };
    case 'session/new':
      return { sessionId: `sess-${Date.now()}`, configOptions: configOptions() };
    case 'session/resume':
      return { configOptions: configOptions() };
    case 'session/set_config_option':
      if (p.configId === 'thought') {
        thought = p.value;
        return { configOptions: configOptions() };
      }
      if (!MODELS.includes(p.value)) throw new Error(`unknown model ${p.value}`);
      model = p.value;
      return { configOptions: configOptions() };
    case 'session/prompt':
      return prompt(p);
    default:
      throw new Error(`fake-acp: no ${m.method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'session/cancel') {
      log({ method: m.method, params: m.params });
      cancelled = true;
    } else if (m.method && m.id !== undefined) {
      handle(m).then(
        result => send({ jsonrpc: '2.0', id: m.id, result }),
        e => send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } }),
      );
    } else if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m.result);
      waiting.delete(m.id);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
