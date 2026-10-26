import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeCtx } from '../src/adapters/fake.ts';
import { applyBoard, castText, parseCast, parseCoordinator, responsibilityOf, seatName, type RoomState } from '../src/rooms.ts';
import { git } from '../src/git.ts';
import type { MhEvent } from '../src/types.ts';
import type { Daemon } from '../src/daemon.ts';
import { makeTeam, withTimeout } from './helpers.ts';

const role = (extra = '') => `---\nharness: fake\nmodel: m\n${extra}good_at: x\n---\nx\n`;

/** Resolves with the first event of the room that matches. */
function next(d: Daemon, goal: string, match: (e: MhEvent) => boolean, what: string, ms = 3000): Promise<MhEvent> {
  const seen = d.store.since(goal).find(match);
  if (seen) return Promise.resolve(seen);
  return withTimeout(
    new Promise<MhEvent>(resolve => {
      const stop = d.store.subscribe(e => {
        if (e.goal === goal && match(e)) {
          stop();
          resolve(e);
        }
      });
    }),
    ms,
    what,
  );
}
const said = (d: Daemon, goal: string, f: (data: Record<string, unknown>) => boolean) => d.store.since(goal).filter(e => e.type === 'room.message' && f(e.data));
const until = async (cond: () => boolean, what: string) => withTimeout((async () => { while (!cond()) await new Promise(r => setTimeout(r, 10)); })(), 3000, what);

/** The coordinator answers routes and decisions with what the test says; participants answer with their name and what they were asked. */
function roomTeam(o: { route?: (prompt: string) => object; decide?: (prompt: string) => object; scripts?: Record<string, (ctx: FakeCtx, text: string) => Promise<void>> } = {}) {
  const prompts: string[] = [];
  const answer = async (ctx: FakeCtx, text: string) => {
    const first = text.replace(/^\[MetaHarness\] Message from [^:]+:\s*/, '').split('\n')[0];
    await ctx.tool('done', { note: `${ctx.spec.agent} on: ${first}` });
  };
  const coordinate = async (ctx: FakeCtx, text: string) => {
    prompts.push(text);
    const r = /without picking anyone/.test(text) ? (o.route?.(text) ?? { route: { to: ['scout'], mode: 'ask', line: 'scout knows' } }) : (o.decide?.(text) ?? { next: { action: 'back', text: 'All answered.', line: 'answered' }, status: 'converging', line: 'done' });
    ctx.say(JSON.stringify(r));
  };
  const turns: Record<string, (ctx: FakeCtx, text: string) => Promise<void>> = { scout: answer, designer: answer, reviewer: answer, model: answer, coordinator: coordinate, cartographer: answer, ...o.scripts };
  const scripts = Object.fromEntries(Object.entries(turns).map(([k, f]) => [k, (ctx: FakeCtx) => f(ctx, ctx.spec.brief)]));
  const fake = new FakeAdapter(scripts, {}, turns);
  const d = makeTeam({
    roles: { scout: role(), designer: role(), reviewer: role(), coordinator: role('helper: true\n'), cartographer: role('wake: landed\n') },
    adapters: { fake },
    roomQuietMs: 20,
  });
  return { d, fake, prompts };
}

test('seats, casts, responsibilities and the board read and write plainly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-cast-'));
  const seats = [
    { role: 'reviewer', name: 'skeptic', on: 'codex/gpt-6.1-sol@high', stance: 'look for what breaks' },
    { on: 'claude-code/opus', responsibility: 'Think about the player: what feels good.', scout: true },
  ];
  writeFileSync(join(dir, 'hunt.md'), castText({ goodAt: 'bug hunts', participants: seats }));
  const cast = parseCast(join(dir, 'hunt.md'));
  assert.equal(cast.goodAt, 'bug hunts');
  assert.deepEqual(cast.participants, seats, 'a cast keeps role seats and model-only seats as they were');

  assert.equal(seatName({ on: 'codex/gpt-6.1-sol' }, []), 'sol', 'a model-only seat is named after its model');
  assert.equal(seatName({ on: 'claude-code/claude-opus-5-5' }, []), 'opus');
  assert.equal(seatName({ role: 'designer', on: 'codex/gpt-6.1-sol' }, ['designer']), 'designer-sol', 'a role sitting twice is told apart by its model');
  assert.equal(seatName({ role: 'room' }, []), 'room-2', "room is the room's branch");
  assert.match(responsibilityOf({ role: 'scout' }), /^Gather information/, "a role's usual responsibility");
  assert.match(responsibilityOf({ role: 'Creative-gemini' }), /^Come up with ideas/);
  assert.equal(responsibilityOf({ role: 'scout', responsibility: 'Only read the logs.' }), 'Only read the logs.');

  const st = { board: [], boardSeq: 0 } as unknown as RoomState;
  assert.ok(applyBoard(st, [{ op: 'add', kind: 'question', text: 'Wrap or wall?' }, { op: 'add', kind: 'finding', text: 'Clamp in Move.gd' }], 'human'));
  assert.equal(applyBoard(st, [{ op: 'add', kind: 'finding', text: 'clamp in move.gd' }], 'human'), false, 'the same item twice is skipped');
  assert.ok(applyBoard(st, [{ op: 'close', id: 'q1' }, { op: 'edit', id: 'f2', text: 'Clamp in Move.gd:40' }], 'x'));
  assert.deepEqual(st.board.map(i => [i.id, i.text, !!i.closed]), [['q1', 'Wrap or wall?', true], ['f2', 'Clamp in Move.gd:40', false]]);

  const r = parseCoordinator('Here:\n{"next": {"action": "forward", "to": ["@reviewer"], "text": "check it", "line": "reviewer checks"}, "status": "drifting", "line": "saves", "board": [{"op": "add", "kind": "decision", "text": "walls"}, {"op": "bogus"}], "ending": "design"}');
  assert.deepEqual(r?.status, { state: 'drifting', line: 'saves', ending: 'design' });
  assert.deepEqual(r?.board, [{ op: 'add', kind: 'decision', text: 'walls' }]);
  assert.deepEqual(r?.next, { action: 'forward', to: ['reviewer'], text: 'check it', line: 'reviewer checks' });
  assert.deepEqual(parseCoordinator('{"route": {"to": "scout", "mode": "chain", "line": "x"}}')?.route, { to: ['scout'], mode: 'chain', line: 'x' });
  assert.deepEqual(parseCoordinator('{"route": {"parts": [{"to": "scout", "ask": "find it"}, {"to": "designer", "ask": "judge it", "after": "scout"}], "line": "x"}}')?.route, {
    to: ['scout', 'designer'], mode: 'ask', line: 'x', parts: [{ to: 'scout', ask: 'find it', after: [] }, { to: 'designer', ask: 'judge it', after: ['scout'] }],
  });
  assert.equal(parseCoordinator('no json here'), undefined);
});

test('a message for nobody in particular is routed by the coordinator, who then hands the answer back', async () => {
  const { d, prompts } = roomTeam({
    route: () => ({ route: { to: ['scout'], mode: 'job', line: 'scout gathers the history first' }, status: 'developing', line: 'started', board: [{ op: 'add', kind: 'question', text: 'What changed after the demo?' }] }),
  });
  const room = d.startRoom({ topic: 'What changed after the demo?', cast: [{ role: 'scout' }, { role: 'designer', stance: 'keep it simple' }] });
  const g = d.goals.get(room)!;
  assert.equal(g.agents.size, 0, 'nobody starts before being asked');

  assert.match(d.roomPost(room, { text: 'What was applied after the demo?' }), /coordinator picks/);
  const routed = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'route', 'the route');
  assert.deepEqual(routed.data.to, ['scout']);
  assert.equal(routed.data.text, 'scout gathers the history first');
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'scout', 'scout answers');
  assert.equal(d.agent(room, 'designer'), undefined, 'only the routed seat was asked');
  const scout = d.agent(room, 'scout')!;
  assert.equal(scout.cwd, g.room!.worktree!.path, "participants read on the room's branch");
  assert.match(scout.systemPrompt, /Who is in the room:\n- scout \(scout: Gather\)  ← you\n- designer \(designer: Big picture\), not started yet/, 'it knows who else is in the room');
  assert.match(scout.systemPrompt, /## Your responsibility in this room\n\nGather information/);

  const back = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'back', 'handed back');
  assert.equal(back.data.text, 'All answered.');
  assert.match(prompts[0], /designer \(designer · its role’s model, not started\): Explain the bigger picture/, 'the coordinator routes by responsibility');
  assert.match(prompts[1], /New, to decide on:\n\[scout → coordinator, answer\] \(answering coordinator/);
  assert.deepEqual(g.room!.board.map(i => i.text), ['What changed after the demo?']);
  assert.equal(d.humanInbox.length, 0, "answers go to the thread, not the Inbox");
  await d.close();
});

test('the coordinator can split a question: parts that need nothing run in parallel, a part that needs them waits and gets their answers', async () => {
  const { d, prompts } = roomTeam({
    route: () => ({
      route: {
        mode: 'ask', line: 'scout finds the changes while reviewer checks the tests; then designer judges',
        parts: [
          { to: 'scout', ask: 'What changed around the Colossus spawn?' },
          { to: 'reviewer', ask: 'Do the tests cover the spawn?' },
          { to: 'designer', ask: 'Design problem or wiring bug?', after: ['scout', 'reviewer'] },
        ],
      },
    }),
  });
  const room = d.startRoom({ topic: 't', cast: [{ role: 'scout' }, { role: 'reviewer' }, { role: 'designer' }] });
  d.roomPost(room, { text: 'Why no Colossus, and is it design or wiring?' });
  await next(d, room, e => e.type === 'room.message' && e.data.kind === 'back', 'handed back', 4000);
  const parts = said(d, room, x => x.kind === 'part');
  assert.deepEqual(parts.map(e => [e.data.to, e.data.part]), [[['scout'], 1], [['reviewer'], 2], [['designer'], 3]]);
  const spawned = (n: string) => d.store.since(room).findIndex(e => e.type === 'agent.spawned' && e.agent === n);
  const answered = (n: string) => d.store.since(room).findIndex(e => e.type === 'room.message' && e.data.from === n);
  assert.ok(spawned('reviewer') < answered('scout') || spawned('reviewer') < answered('reviewer'), 'scout and reviewer were asked together');
  assert.ok(spawned('designer') > answered('scout') && spawned('designer') > answered('reviewer'), 'designer waited for both');
  const brief = d.agent(room, 'designer')!.brief;
  assert.match(brief, /^Design problem or wiring bug\?/);
  assert.match(brief, /The whole question, for context:\n"Why no Colossus, and is it design or wiring\?"/);
  assert.match(brief, /--- scout:\nscout on: What changed around the Colossus spawn\?[\s\S]*--- reviewer:\nreviewer on: Do the tests cover the spawn\?/);
  assert.match(d.agent(room, 'scout')!.brief, /^What changed around the Colossus spawn\?/, 'the scout got only its part');
  const decide = prompts.filter(p => /New, to decide on/.test(p));
  assert.equal(decide.length, 1, 'one decision once every part is in');
  assert.equal((decide[0].match(/, answer\]/g) ?? []).length, 3);
  await d.close();
});

test("a participant's message for another goes to the coordinator, who forwards it once and then hands back", async () => {
  let decisions = 0;
  const { d, prompts } = roomTeam({
    scripts: {
      scout: async (ctx, text) => {
        if (/Look into it/.test(text)) await ctx.tool('send', { to: 'designer', text: 'The clamp is off by one: is that a design choice?' });
        await ctx.tool('done', { note: `scout on: ${text.split('\n')[0]}\n→ designer: is the clamp a design choice?` });
      },
    },
    decide: () => (++decisions === 1 ? { next: { action: 'forward', to: ['designer'], text: 'scout says the clamp is off by one. A design choice?', line: 'designer checks the clamp' } } : { next: { action: 'back', text: 'Clamp is a bug; designer agrees.', line: 'answered' } }),
  });
  const room = d.startRoom({ topic: 't', cast: [{ role: 'scout' }, { role: 'designer' }] });
  d.roomPost(room, { text: 'Look into it', to: ['scout'] });
  await next(d, room, e => e.type === 'room.message' && e.data.kind === 'back', 'handed back', 4000);
  const aside = said(d, room, x => x.kind === 'aside')[0];
  assert.equal(aside.data.from, 'scout');
  const forward = said(d, room, x => x.kind === 'forward')[0];
  assert.deepEqual(forward.data.to, ['designer']);
  const designer = said(d, room, x => x.from === 'designer');
  assert.equal(designer.length, 1, 'the designer answered once, nothing ping-pongs');
  assert.equal(designer[0].data.re, forward.data.flow, 'its answer sits under the forward');
  assert.match(prompts.join('\n'), /→ designer: is the clamp a design choice\?/, 'the coordinator sees the hint');
  await d.close();
});

test('seats can be just a model; what you say to one from its panel shows in the thread; a digest tells it what it missed', async () => {
  const { d } = roomTeam();
  const room = d.startRoom({ topic: 't', cast: [{ role: 'scout' }] });
  assert.throws(() => d.roomAdd(room, { on: 'fake/m2' }), /needs a responsibility/);
  assert.match(d.roomAdd(room, { on: 'fake/m2@high', responsibility: 'Think about the player.' }), /m2 has a seat/);
  d.roomPost(room, { text: 'First question', to: ['scout'] });
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'scout', 'scout answers');

  await d.command({ cmd: 'agent.message', goal: room, to: 'm2', text: 'What would a player notice?' });
  const asked = said(d, room, x => x.from === 'human' && x.text === 'What would a player notice?')[0];
  assert.deepEqual(asked.data.to, ['m2']);
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'm2', 'm2 answers');
  const m2 = d.agent(room, 'm2')!;
  assert.equal(m2.role.name, 'model');
  assert.equal(m2.effort, 'high');
  assert.doesNotMatch(m2.systemPrompt, /## Your role/);
  assert.match(m2.systemPrompt, /## Your responsibility in this room\n\nThink about the player\./);
  assert.match(m2.brief, /\[Room\] New in the room since you last spoke:\n- the human → scout: First question\n- scout → the human: scout on: First question/);
  await d.close();
});

test('views stay hidden until everyone has answered; a debate runs its rounds; a chain hands each answer on', async () => {
  const { d } = roomTeam({ decide: () => ({ next: { action: 'note' } }) });
  const room = d.startRoom({ topic: 'Wrap or wall?', cast: [{ role: 'designer' }, { role: 'reviewer' }, { role: 'scout' }] });

  d.roomPost(room, { text: 'Wrap or wall?', to: ['designer', 'reviewer'], mode: 'views' });
  const reveal = await next(d, room, e => e.type === 'room.reveal', 'views revealed');
  const views = said(d, room, x => x.kind === 'answer' && x.flow === reveal.data.flow);
  assert.equal(views.length, 2);
  assert.equal(views.filter(e => e.data.held).length, 1, 'the first view is held until the second is in');

  d.roomPost(room, { text: 'Argue it out', to: ['designer', 'reviewer'], mode: 'debate', rounds: 2 });
  await next(d, room, e => e.type === 'room.round' && e.data.round === 2, 'second round');
  await until(() => said(d, room, x => x.mode === 'debate' && x.kind === 'answer').length >= 4, 'four debate answers');

  d.roomPost(room, { text: 'Find it, then judge it', to: ['scout', 'designer'], mode: 'chain' });
  const chained = await next(d, room, e => e.type === 'room.message' && e.data.mode === 'chain' && e.data.from === 'designer', 'chain reaches the designer');
  assert.match(String(chained.data.text), /designer on: Find it, then judge it/);
  await d.close();
});

test('opened, a participant messaging another goes straight there and the answer comes back', async () => {
  const replies: string[] = [];
  const { d } = roomTeam({
    decide: () => ({ next: { action: 'note' } }),
    scripts: {
      designer: async (ctx, text) => {
        if (/Ask the scout/.test(text)) replies.push(await ctx.tool('send', { to: 'scout', text: 'Where is the clamp?' }));
        await ctx.tool('done', { note: `designer on: ${text.split('\n')[0]}` });
      },
    },
  });
  const room = d.startRoom({ topic: 't', cast: [{ role: 'designer' }, { role: 'scout' }], open: true });
  d.roomPost(room, { text: 'Ask the scout', to: ['designer'] });
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'scout', 'scout answers the designer');
  assert.match(replies[0], /scout joined the room/);
  assert.deepEqual(said(d, room, x => x.kind === 'aside')[0].data.to, ['scout']);
  await next(d, room, e => e.type === 'message.delivered' && e.agent === 'designer' && e.data.from === 'scout', "the scout's answer reaches the designer");
  assert.equal(said(d, room, x => x.kind === 'forward').length, 0, 'in an open discussion the coordinator only watches');
  await d.close();
});

test('only a participant on a patch job may change files; the room branch merges once and the cartographer maps it', async () => {
  const { d } = roomTeam({
    decide: () => ({ next: { action: 'note' } }),
    scripts: {
      designer: async (ctx, text) => {
        if (/patch job/.test(text)) {
          writeFileSync(join(ctx.spec.cwd, 'fix.txt'), 'fixed\n');
          git(ctx.spec.cwd, 'add', 'fix.txt');
          git(ctx.spec.cwd, 'commit', '-qm', 'Fix the clamp');
        }
        await ctx.tool('done', { note: 'done' });
      },
    },
  });
  const room = d.startRoom({ topic: 't', cast: [{ role: 'designer' }, { role: 'scout' }] });
  const g = d.goals.get(room)!;
  d.roomPost(room, { text: 'Look', to: ['scout'] });
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'scout', 'scout');
  const scout = d.agent(room, 'scout')!;
  const inRepo = join(scout.cwd, 'x.txt');
  assert.equal((d.toolPolicy(scout, { kind: 'edit', tool: 'Write', detail: inRepo, path: inRepo }) as { allow: boolean }).allow, false);
  const report = join(g.sharedDir, 'reports', 'scout-1.md');
  assert.deepEqual(d.toolPolicy(scout, { kind: 'edit', tool: 'Write', detail: report, path: report }), { allow: true }, 'reports in the shared folder are fine');

  assert.throws(() => d.roomPost(room, { text: 'Fix it', to: ['designer', 'scout'], mode: 'patch' }), /one participant/);
  d.roomPost(room, { text: 'Fix it', to: ['designer'], mode: 'patch' });
  await next(d, room, e => e.type === 'room.writer' && e.data.on === false, 'write access ends with the answer');
  assert.equal(g.room!.writers.size, 0);

  const before = git(d.repo, 'rev-parse', 'HEAD');
  assert.match(d.roomMerge(room), /Merged 1 commit.*cartographer maps the result/);
  assert.notEqual(git(d.repo, 'rev-parse', 'HEAD'), before);
  assert.ok(existsSync(join(d.repo, 'fix.txt')));
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'cartographer', 'the cartographer maps the merge');
  assert.equal(d.agent(room, 'cartographer')!.cwd, d.repo, "it works in the human's checkout");
  assert.match(d.roomMerge(room), /Nothing to merge/);
  await d.close();
});

test('after four forwards without the human, the coordinator is told to hand back', async () => {
  let n = 0;
  const { d, prompts } = roomTeam({ decide: () => (++n <= 5 ? { next: { action: 'forward', to: [n % 2 ? 'designer' : 'reviewer'], text: `round ${n}`, line: 'again' } } : { next: { action: 'back', text: 'ok' } }) });
  const room = d.startRoom({ topic: 't', cast: [{ role: 'designer' }, { role: 'reviewer' }] });
  d.roomPost(room, { text: 'Start', to: ['designer'] });
  await next(d, room, e => e.type === 'room.message' && e.data.kind === 'back', 'handed back', 5000);
  const decide = prompts.filter(p => /New, to decide on/.test(p));
  assert.doesNotMatch(decide[3], /hand back now/);
  assert.match(decide[4], /passed things on 4 times since the human last spoke: hand back now/);
  await d.close();
});

test("a new room carries a past room's board over, and a goal started from a room points its lead at it", async () => {
  const { d } = roomTeam();
  const first = d.startRoom({ topic: 'First', cast: [{ role: 'designer' }] });
  d.roomBoard(first, [{ op: 'add', kind: 'decision', text: 'walls, not wrap' }, { op: 'add', kind: 'question', text: 'how thick?' }, { op: 'close', id: 'q2' }], 'human');
  d.endGoal(first);
  const second = d.startRoom({ topic: 'Second', from: first });
  assert.deepEqual(d.goals.get(second)!.room!.board.map(i => i.text), ['walls, not wrap'], 'answered questions stay behind');

  const goal = d.startGoal({ request: 'Build the walls', lead: 'designer', fromRoom: first });
  assert.match(d.agent(goal, 'designer')!.brief, /comes out of a discussion room/);
  assert.equal(d.listGoals().find(x => x.id === first)?.kind, 'room');
  await d.close();
});

test('a seat stopped mid-answer keeps what it said as its answer, the coordinator sees it, and it can be asked again', async () => {
  for (const interrupt of [true, false]) {
    const prompts: string[] = [];
    const { d, fake } = roomTeam({
      decide: p => (prompts.push(p), { next: { action: 'note' } }),
      scripts: {
        designer: async (ctx, text) => {
          if (/Think it through/.test(text)) {
            ctx.say('First thoughts: wrap around.');
            await ctx.run('sleep 30', 5000);
            return;
          }
          await ctx.tool('done', { note: `designer on: ${text.split('\n')[0]}` });
        },
      },
    });
    (fake.manifest as { interrupt: boolean }).interrupt = interrupt;
    const room = d.startRoom({ topic: 't', cast: [{ role: 'designer' }, { role: 'reviewer' }] });
    d.roomPost(room, { text: 'Think it through', to: ['designer', 'reviewer'] });
    await until(() => d.store.since(room).some(e => e.type === 'agent.text' && e.agent === 'designer'), 'the designer starts');
    await next(d, room, e => e.type === 'room.message' && e.data.from === 'reviewer', 'the reviewer answers');
    assert.match(d.roomStop(room, 'designer'), /Stopped designer/);
    const stopped = await next(d, room, e => e.type === 'room.message' && e.data.from === 'designer', 'the stopped answer');
    assert.equal(stopped.data.stopped, true);
    assert.equal(stopped.data.text, 'First thoughts: wrap around.', 'what it said so far is its answer');
    await until(() => d.agent(room, 'designer')!.state === 'idle', 'its turn is over');
    assert.equal(d.roomStop(room, 'designer'), "designer isn't working on anything.");

    d.roomPost(room, { text: 'Now just answer', to: ['designer'] });
    await next(d, room, e => e.type === 'room.message' && e.data.from === 'designer' && !e.data.stopped, 'it answers the next question');
    assert.equal(said(d, room, x => x.from === 'designer').length, 2, "the stopped turn's end isn't another answer");
    if (!interrupt) assert.ok(fake.started.some(s => s.spec.agent === 'designer' && s.resume), 'without an interrupt, its session resumed');
    await until(() => prompts.length > 0, 'the coordinator decides');
    assert.equal(prompts.length, 1, 'the stop itself asks the coordinator nothing');
    assert.match(prompts[0], /\[designer → human, stopped by the human mid-answer\] First thoughts/, 'the coordinator sees it was stopped');
    await d.close();
  }
});

test('a benched seat is skipped and rests (one at work finishes first); brought back, it resumes and hears what it missed', async () => {
  const prompts: string[] = [];
  const { d, fake } = roomTeam({
    route: p => (prompts.push(p), { route: { to: ['designer'], mode: 'ask', line: 'designer' } }),
    decide: () => ({ next: { action: 'note' } }),
    scripts: {
      designer: async (ctx, text) => {
        if (/Slowly/.test(text)) await ctx.run('sleep 1', 150);
        await ctx.tool('done', { note: `designer on: ${text.split('\n')[0]}` });
      },
    },
  });
  const room = d.startRoom({ topic: 't', cast: [{ role: 'designer' }, { role: 'scout' }] });
  d.roomPost(room, { text: 'Slowly, what do you think?', to: ['designer'] });
  await until(() => d.agent(room, 'designer')?.state === 'working', 'the designer works');
  assert.match(d.roomBench(room, 'designer', true), /finishes what it's doing/);
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'designer', 'it still answers');
  await until(() => !d.agent(room, 'designer')!.session, 'then it rests');
  assert.ok(d.agent(room, 'designer')!.resumeId, 'its session is kept to resume');
  assert.equal(d.goals.get(room)!.room!.cast.find(c => c.name === 'designer')!.benched, true);

  assert.throws(() => d.roomPost(room, { text: 'You there?', to: ['designer'] }), /designer is benched/);
  d.roomPost(room, { text: 'Anyone?' });
  await next(d, room, e => e.type === 'room.message' && e.data.kind === 'note' && /couldn't pick/.test(String(e.data.text)), 'the coordinator can’t route to it');
  assert.match(prompts[0], /- designer \(designer · fake\/m, benched: never route to it\)/);
  d.roomPost(room, { text: 'Scout, what changed?', to: ['scout'] });
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'scout', 'the scout answers');

  assert.match(d.roomBench(room, 'designer', false), /designer is back/);
  d.roomPost(room, { text: 'Welcome back', to: ['designer'] });
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'designer' && /Welcome back/.test(String(e.data.text)), 'it answers again');
  const resumed = fake.started.filter(s => s.spec.agent === 'designer');
  assert.equal(resumed.length, 2);
  assert.ok(resumed[1].resume, 'it resumed its session');
  assert.match(resumed[1].spec.brief, /New in the room since you last spoke:[^]*- scout → the human: scout on: Scout, what changed\?/, 'it hears what it missed');
  await d.close();
});

test("a seat's scout is the scout role, as a quick helper, only while the human has it on", async () => {
  const { d } = roomTeam({
    decide: () => ({ next: { action: 'note' } }),
    scripts: {
      designer: async (ctx, text) => {
        const role = /reviewer/.test(text) ? 'reviewer' : 'scout';
        await ctx.tool('done', { note: await ctx.tool('spawn', { role, quick: true, brief: 'Where is the clamp?' }) });
      },
    },
  });
  const room = d.startRoom({ topic: 't', cast: [{ role: 'designer' }] });
  d.roomPost(room, { text: 'Look it up', to: ['designer'] });
  let a = await next(d, room, e => e.type === 'room.message' && e.data.from === 'designer', 'answer without a scout');
  assert.match(String(a.data.text), /Your scout is off/);
  assert.doesNotMatch(d.agent(room, 'designer')!.systemPrompt, /You have a scout/);

  assert.match(d.roomScout(room, 'designer', true), /scout is on/);
  d.roomPost(room, { text: 'Look it up again', to: ['designer'] });
  a = await next(d, room, e => e.type === 'room.message' && e.data.from === 'designer' && e.seq > a.seq, 'answer with a scout');
  assert.match(String(a.data.text), /scout-1 answered:\nscout-1 on: Where is the clamp\?/);
  const spawned = d.store.since(room).find(e => e.type === 'agent.spawned' && e.data.quick);
  assert.equal(spawned?.parent, 'designer');
  assert.equal(d.store.since(room).filter(e => e.type === 'room.message' && e.data.from === spawned?.agent).length, 0, "the scout's answer is the seat's, not the room's");

  d.roomPost(room, { text: 'Ask the reviewer', to: ['designer'] });
  a = await next(d, room, e => e.type === 'room.message' && e.data.from === 'designer' && e.seq > a.seq, 'answer asking for another helper');
  assert.match(String(a.data.text), /your helper is the scout/);

  assert.match(d.roomAdd(room, { role: 'reviewer', scout: true }), /reviewer has a seat/);
  d.roomPost(room, { text: 'Hello', to: ['reviewer'] });
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'reviewer', 'the reviewer answers');
  assert.match(d.agent(room, 'reviewer')!.systemPrompt, /You have a scout for lookups: call `spawn` with role "scout", quick: true/);
  assert.match(d.agent(room, 'reviewer')!.systemPrompt, /Keep your answer simple and conversational/);
  await d.close();
});
