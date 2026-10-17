import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Daemon } from './daemon.ts';
import type { MhEvent, Role } from './types.ts';

/**
 * `mh test <harness>` (design §16): a short scripted run that checks what actually works with
 * this harness here, rather than what its profile claims. It costs a few small turns.
 */

export interface ProbeCheck {
  name: string;
  /** undefined: couldn't tell. */
  ok: boolean | undefined;
  detail: string;
}

export interface ProbeReport {
  harness: string;
  model: string;
  checks: ProbeCheck[];
  seconds: number;
  cost?: number;
}

export async function probeHarness(d: Daemon, harness: string, model: string, o: { stepMs?: number } = {}): Promise<ProbeReport> {
  const started = Date.now();
  const stepMs = o.stepMs ?? 120_000;
  const checks: ProbeCheck[] = [];
  const report = (): ProbeReport => ({ harness, model, checks, seconds: Math.round((Date.now() - started) / 1000), cost: d.agent(goal, 'probe')?.cost });
  const code1 = randomBytes(3).toString('hex').toUpperCase();
  const code2 = randomBytes(3).toString('hex').toUpperCase();
  const dir = mkdtempSync(join(tmpdir(), 'mh-probe-'));
  const role: Role = {
    name: 'probe', harness, model, fallback: [], goodAt: 'checking a harness', helper: false, allow: ['Bash(sleep*)'], autoApprove: 'read-only', mcp: [], worktree: false, file: '(built in)',
    instructions: 'You are a connectivity probe for MetaHarness. Follow each instruction exactly and briefly, in order. Do nothing else.',
  };
  const brief = [
    'This is a short connectivity test. Do these steps in order:',
    '1. Call the MetaHarness status tool with the text "probe started".',
    '2. Run the shell command: sleep 20',
    '3. Call the MetaHarness done tool. Its note must contain every codeword you have been sent so far, or "no codeword".',
  ].join('\n');

  let goal = '';
  const seen: MhEvent[] = [];
  const waiters = new Set<{ pred: (e: MhEvent) => boolean; resolve: (e: MhEvent | null) => void }>();
  const off = d.store.subscribe(e => {
    if (e.goal !== goal) return;
    seen.push(e);
    // The probe only ever needs its sleeps; anything else it asks for is refused.
    if (e.type === 'inbox.item' && e.data.kind === 'approval') {
      d.resolveInbox(String(e.data.id), /^Bash: sleep \d+$/.test(String(e.data.text)) ? 'approve' : 'deny', 'Not needed for the probe.');
    }
    for (const w of waiters) if (w.pred(e)) (waiters.delete(w), w.resolve(e));
  });
  const until = (pred: (e: MhEvent) => boolean, ms = stepMs): Promise<MhEvent | null> => {
    const hit = seen.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise(resolve => {
      const w = { pred, resolve };
      waiters.add(w);
      setTimeout(() => waiters.delete(w) && resolve(null), ms).unref();
    });
  };
  const isDone = (after: number) => (e: MhEvent) => e.type === 'agent.done' && e.seq > after;
  const via = (after: number) => seen.find(e => e.type === 'message.delivered' && e.seq > after)?.data.via as string | undefined;

  try {
    goal = d.startGoal({ request: brief, leadDef: role, dir });
  } catch (e) {
    off();
    rmSync(dir, { recursive: true, force: true });
    checks.push({ name: 'starts', ok: false, detail: (e as Error).message });
    return report();
  }

  try {
    // 1. Our MCP tools are reached.
    const status = await until(e => e.type === 'agent.status' || e.type === 'agent.crashed' || e.type === 'agent.idle');
    if (status?.type !== 'agent.status') {
      checks.push({ name: 'MetaHarness tools (MCP)', ok: false, detail: status ? `the agent ${status.type.slice(6)}: ${String(status.data.reason ?? status.data.note ?? '')}` : `no status call within ${stepMs / 1000}s` });
      return report();
    }
    checks.push({ name: 'MetaHarness tools (MCP)', ok: true, detail: `status call after ${Math.round((Date.parse(status.ts) - started) / 1000)}s` });

    // 2. A message sent while it works reaches the running turn.
    const sentAt = seen.at(-1)!.seq;
    d.deliver(goal, 'human', 'probe', `The codeword is ${code1}.`);
    const done1 = await until(isDone(sentAt));
    const how = via(sentAt);
    const got = !!done1 && String(done1.data.note).includes(code1);
    checks.push({
      name: 'Message during a turn',
      ok: got && (how === 'inject' || how === 'hook' || how === 'wait'),
      detail: !done1 ? 'no done call' : !got ? `delivered (${how ?? '?'}) but not in the done note` : how === 'inject' ? 'arrived in the running turn (native)' : how === 'hook' ? 'arrived in the running turn (through a hook)' : `only arrived between turns (${how})`,
    });
    if (!done1) return report();
    await until(e => e.type === 'agent.state' && e.data.state === 'done' && e.seq > done1.seq, 30_000);

    // 3. A finished agent takes a follow-up, and 4. an urgent message interrupts it.
    const followAt = seen.at(-1)!.seq;
    d.deliver(goal, 'human', 'probe', 'Follow-up: run the shell command "sleep 45", then call the MetaHarness done tool with the note "slept".');
    const sleeping = await until(e => e.type === 'agent.tool_call' && e.seq > followAt && /sleep 45/.test(String(e.data.summary)));
    const resumed = via(followAt);
    checks.push({ name: 'Follow-up after done', ok: !!sleeping, detail: sleeping ? `resumed (${resumed ?? '?'})` : 'the follow-up never started' });
    if (sleeping) {
      const urgentAt = seen.at(-1)!.seq;
      d.deliver(goal, 'human', 'probe', `Stop what you're doing: call the MetaHarness done tool now with the note "interrupted ${code2}".`, true);
      const done2 = await until(isDone(urgentAt), 60_000);
      const how2 = seen.find(e => e.type === 'agent.interrupted' && e.seq > urgentAt)?.data.how;
      const quick = !!done2 && String(done2.data.note).includes(code2) && Date.parse(done2.ts) - Date.parse(sleeping.ts) < 40_000;
      checks.push({
        name: 'Urgent message interrupts',
        ok: quick,
        detail: quick ? (how2 === 'restart' ? 'stopped by restarting the session from its ID' : 'stopped natively') : done2 ? 'it finished, but only after the command ran out' : 'no done call within 60s',
      });
    }

    // 5. Usage and rate limits reported along the way.
    const usage = seen.filter(e => e.type === 'usage');
    const last = usage.at(-1)?.data as { tokensIn?: number; costUsd?: number; contextPct?: number } | undefined;
    checks.push({
      name: 'Usage reported',
      ok: usage.length > 0,
      detail: last ? [last.tokensIn !== undefined && `${last.tokensIn} tokens in`, last.costUsd !== undefined && `$${last.costUsd.toFixed(4)}`, last.contextPct !== undefined && `context ${last.contextPct}%`].filter(Boolean).join(', ') || 'yes' : 'none',
    });
    const account = d.accountOf(harness, model);
    const limit = d.store.since(undefined, 0).filter(e => e.type === 'account.limit' && e.data.account === account).at(-1);
    checks.push({
      name: 'Rate limits reported',
      ok: limit ? true : undefined,
      detail: limit ? `${account}: ${limit.data.status}${limit.data.usedPct != null ? `, ${limit.data.usedPct}% used` : ''}` : 'nothing reported during the test (some harnesses only report near the limit)',
    });
    return report();
  } finally {
    off();
    d.stopAgent(goal, 'probe', 'the harness test');
    const g = d.goals.get(goal);
    if (g) g.status = 'ended';
    // The test's own notes to the human aren't news.
    for (let i = d.humanInbox.length - 1; i >= 0; i--) if (d.humanInbox[i].goal === goal) d.humanInbox.splice(i, 1);
    rmSync(dir, { recursive: true, force: true });
  }
}
