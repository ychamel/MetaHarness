/**
 * An Antigravity CLI hook: `node agy-hook.ts pre-invocation | pre-tool`. agy runs it with its own
 * payload on stdin; this asks the daemon (MH_HOOK_URL, inherited from the agy process) and answers
 * in agy's format. A tool is refused if the daemon can't be reached.
 */

const event = process.argv[2];
const url = process.env.MH_HOOK_URL;

async function stdin(): Promise<any> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

async function ask(body: unknown): Promise<any> {
  if (!url) throw new Error('MH_HOOK_URL is not set');
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`the daemon answered ${r.status}`);
  return r.json();
}

const payload = await stdin();
let out: unknown = {};
try {
  if (event === 'pre-invocation') {
    const r = await ask({ event: 'before_model' });
    if (r.messages) out = { injectSteps: [{ userMessage: r.messages }] };
  } else if (event === 'pre-tool') {
    const call = payload.toolCall ?? {};
    const r = await ask({ event: 'before_tool', tool: String(call.name ?? ''), args: call.args ?? {} });
    out = r.allow ? { decision: 'allow' } : { decision: 'deny', reason: r.reason ?? 'Denied by MetaHarness.' };
  }
} catch (e) {
  if (event === 'pre-tool') out = { decision: 'deny', reason: `MetaHarness couldn't be reached to approve this (${(e as Error).message}).` };
}
process.stdout.write(JSON.stringify(out));
