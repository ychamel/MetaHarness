import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeCtx } from '../src/adapters/fake.ts';
import { applyCanvas, branchCards, canvasMarkdown, castText, lensName, parseCanvasOps, parseCast, responsibilityOf, type Canvas } from '../src/rooms.ts';
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
const reply = (d: Daemon, goal: string, after = 0) => next(d, goal, e => e.seq > after && e.type === 'room.message' && e.data.kind === 'reply', 'a reply from the lead');
/** The lead between turns, with nothing waiting: a scripted lead only reads what starts a turn. */
const atRest = (d: Daemon, goal: string) =>
  until(() => {
    const lead = d.agent(goal, 'lead')!;
    return !lead.session?.busy() && !lead.inbox.length && [...d.goals.get(goal)!.agents.values()].every(a => a === lead || !a.session?.busy());
  }, 'the room at rest');

/**
 * The lead does what the test says with each message (by default: greets, and sends the lens a
 * message names with "→ name"); lenses answer with their name and what they were asked.
 */
function roomTeam(o: { lead?: (ctx: FakeCtx, text: string) => Promise<void>; scripts?: Record<string, (ctx: FakeCtx, text: string) => Promise<void>> } = {}) {
  const leadTexts: string[] = [];
  const answer = async (ctx: FakeCtx, text: string) => {
    const first = text.replace(/^\[MetaHarness\] Message from [^:]+:\s*/, '').split('\n')[0];
    await ctx.tool('done', { note: `${ctx.spec.agent} on: ${first}` });
  };
  const lead = async (ctx: FakeCtx, text: string) => {
    leadTexts.push(text);
    if (o.lead) return o.lead(ctx, text);
    const to = /Message from human: .*→ ([\w.-]+)/.exec(text)?.[1];
    if (to) {
      ctx.say(await ctx.tool('spawn', { role: to, brief: text.split('\n').at(-1)!.replace(/^\[MetaHarness\] Message from human: /, '') }));
      return;
    }
    const lens = /\[MetaHarness\] ([\w.-]+) finished: (.*)/.exec(text);
    ctx.say(lens ? `${lens[1]} says: ${lens[2]}` : 'Hello.');
  };
  const turns: Record<string, (ctx: FakeCtx, text: string) => Promise<void>> = { scout: answer, designer: answer, reviewer: answer, model: answer, cartographer: answer, 'room-lead': lead, ...o.scripts };
  const scripts = Object.fromEntries(Object.entries(turns).map(([k, f]) => [k, (ctx: FakeCtx) => f(ctx, ctx.spec.brief)]));
  const fake = new FakeAdapter(scripts, {}, turns);
  const d = makeTeam({
    roles: { scout: role(), designer: role(), reviewer: role(), 'room-lead': role(), cartographer: role('wake: landed\n') },
    adapters: { fake },
  });
  return { d, fake, leadTexts };
}

test('lenses, casts and the canvas read and write plainly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-cast-'));
  const lenses = [
    { role: 'reviewer', name: 'skeptic', on: 'codex/gpt-6.1-sol@high', stance: 'look for what breaks' },
    { on: 'claude-code/opus', responsibility: 'Think about the player: what feels good.' },
  ];
  writeFileSync(join(dir, 'hunt.md'), castText({ goodAt: 'bug hunts', participants: lenses }));
  const cast = parseCast(join(dir, 'hunt.md'));
  assert.equal(cast.goodAt, 'bug hunts');
  assert.deepEqual(cast.participants, lenses, 'a cast keeps role lenses and model-only lenses as they were');

  assert.equal(lensName({ on: 'codex/gpt-6.1-sol' }, []), 'sol', 'a model-only lens is named after its model');
  assert.equal(lensName({ on: 'antigravity/gemini-3.8-flash-high' }, []), 'flash', 'effort and family words are left out');
  assert.equal(lensName({ role: 'designer', on: 'codex/gpt-6.1-sol' }, ['designer']), 'designer-sol', 'a role twice is told apart by its model');
  assert.equal(lensName({ role: 'lead' }, []), 'lead-2', 'lead is the room\'s lead');
  assert.match(responsibilityOf({ role: 'scout' }), /^Gather information/, "a role's usual responsibility");
  assert.equal(responsibilityOf({ role: 'scout', responsibility: 'Only read the logs.' }), 'Only read the logs.');

  const c: Canvas = { cards: [], links: [], seq: 0 };
  let r = applyCanvas(c, parseCanvasOps({ ops: [{ op: 'add', kind: 'question', title: 'Wrap or wall?', ref: 'q' }, { op: 'add', kind: 'option', title: 'Walls', links: [{ to: 'q', label: 'answers' }] }, { title: 'Clamp in Move.gd', kind: 'fact', refs: 'src/Move.gd:40' }] }), 'lead');
  assert.deepEqual(r.done, ['added c1 (question): Wrap or wall?', 'added c2 (idea): Walls, linked to c1', 'added c3 (finding): Clamp in Move.gd']);
  assert.deepEqual(c.links, [{ from: 'c2', to: 'c1', label: 'answers' }], 'a card added with a ref can be linked to in the same call');
  assert.deepEqual(c.cards[2].refs, ['src/Move.gd:40']);
  r = applyCanvas(c, [{ op: 'add', kind: 'question', title: 'wrap or wall?' }, { op: 'settle', id: 'c9' }], 'scout');
  assert.equal(r.changed, false);
  assert.deepEqual(r.skipped, ['"wrap or wall?" is already on the canvas as c1', "there's no card c9"]);
  r = applyCanvas(c, parseCanvasOps({ op: 'link', from: 'c3', to: 'c2', label: 'rules out' }), 'scout');
  applyCanvas(c, [{ op: 'note', id: 'c2', text: 'Saved games keep positions outside' }, { op: 'drop', id: 'c2' }, { op: 'settle', id: 'C1' }], 'reviewer');
  assert.deepEqual(c.cards.map(x => [x.id, x.status ?? 'open']), [['c1', 'settled'], ['c2', 'dropped'], ['c3', 'open']]);
  assert.deepEqual(c.cards[1].notes, [{ by: 'reviewer', text: 'Saved games keep positions outside' }]);
  const md = canvasMarkdown('Edges', c);
  assert.match(md, /## Ideas\n\n- \[c2\] \(dropped\) Walls  → c1 \(answers\)  — lead\n  · reviewer: Saved games/);
  assert.match(md, /- \[c3\] Clamp in Move.gd  → c2 \(rules out\)  — lead\n  files: src\/Move.gd:40/);

  applyCanvas(c, [{ op: 'add', kind: 'risk', title: 'Unrelated' }], 'lead');
  assert.deepEqual(branchCards(c, ['c3']).cards.map(x => x.id), ['c2', 'c3'], 'a branch takes the cards linked to the ones picked');
  applyCanvas(c, [{ op: 'remove', id: 'c2' }], 'human');
  assert.deepEqual(c.links, [], "a removed card's links go with it");
  assert.deepEqual(parseCanvasOps({ ops: '[{"op":"close","id":"c1"},{"op":"delete","id":"c3"}]' }), [{ op: 'settle', id: 'c1' }, { op: 'remove', id: 'c3' }], 'ops may come as JSON text, under other names');
});

test('the human talks with the lead; it sends lenses, whose answers wake it, and keeps the canvas', async () => {
  const { d, leadTexts } = roomTeam();
  const room = d.startRoom({ topic: 'Creatures die at the map edge', lenses: [{ role: 'scout' }, { role: 'designer', stance: 'simplest fix' }] });
  const g = d.goals.get(room)!;
  assert.equal(g.lead, 'lead');
  let r = await reply(d, room);
  assert.equal(r.data.text, 'Hello.', "the lead's opening turn is its first reply");
  const lead = d.agent(room, 'lead')!;
  assert.match(lead.systemPrompt, /## A brainstorm room/);
  assert.match(lead.systemPrompt, /- scout \(scout\): Gather information fast/);
  assert.match(lead.systemPrompt, /- designer \(designer\): Explain the bigger picture.* Stance: simplest fix/);
  assert.match(leadTexts[0], /Creatures die at the map edge\n\n\[Room\] The canvas is empty/);

  d.roomPost(room, { text: 'Where is the clamp? → scout' });
  const dispatch = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'dispatch', 'the lead sends the scout');
  assert.deepEqual([dispatch.data.from, dispatch.data.to], ['lead', ['scout']]);
  const lens = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'lens', "the scout's answer shows in the chat");
  assert.equal(lens.data.text, 'scout on: Where is the clamp? → scout');
  r = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'reply' && /scout says/.test(String(e.data.text)), 'the lead passes it on');
  assert.equal(d.agent(room, 'scout')!.parent, 'lead');
  assert.match(d.agent(room, 'scout')!.systemPrompt, /## A lens in a brainstorm room/);
  assert.match(d.agent(room, 'scout')!.systemPrompt, /Questions go to lead/);

  // Sent again, the same lens takes a new turn: it keeps its session.
  await atRest(d, room);
  d.roomPost(room, { text: 'And the wall? → scout' });
  await next(d, room, e => e.seq > r.seq && e.type === 'room.message' && e.data.kind === 'lens', 'the second answer');
  assert.equal(d.store.since(room).filter(e => e.type === 'agent.spawned' && e.agent === 'scout').length, 1);
  await next(d, room, e => e.seq > r.seq && e.type === 'room.message' && e.data.kind === 'reply' && /scout says/.test(String(e.data.text)), 'the lead passes it on');
  await atRest(d, room);

  // The human's message about a card says which.
  d.roomCanvas(room, [{ op: 'add', kind: 'idea', title: 'Walls' }], 'human');
  const before = d.store.since(room).at(-1)!.seq;
  d.roomPost(room, { text: 'Why not?', card: 'c1' });
  await reply(d, room, before);
  assert.match(leadTexts.at(-1)!, /\[About c1, idea: Walls\]\nWhy not\?/);
  assert.match(leadTexts.at(-1)!, /\[Room\] The human changed the canvas: added c1 \(idea\): Walls/, 'the lead hears what the human changed');
  assert.equal(d.listGoals().find(x => x.id === room)?.status, 'running', 'a room is open until the human ends it');
  assert.match(readFileSync(join(g.sharedDir, 'room', 'chat.md'), 'utf8'), /### You → lead\n\nWhere is the clamp\?/);
  await d.close();
});

test("the lead's done is a reply, never an ending; it can't wait on a lens; lenses talk only with it", async () => {
  const { d } = roomTeam({
    lead: async (ctx, text) => {
      if (/Open the room/.test(text)) return ctx.say('Hi.');
      if (/try quick/.test(text)) return ctx.say(await ctx.tool('spawn', { role: 'designer', brief: 'look', quick: true }));
      if (/try away/.test(text)) return ctx.say(await ctx.tool('spawn', { role: 'reviewer', brief: 'look' }));
      if (/try unknown/.test(text)) return ctx.say(await ctx.tool('spawn', { role: 'poet', brief: 'look' }));
      ctx.say('thinking out loud');
      await ctx.tool('done', { note: 'My answer.' });
    },
    scripts: {
      designer: async ctx => {
        ctx.say(await ctx.tool('spawn', { role: 'scout', brief: 'help' }));
        await ctx.tool('send', { to: 'human', text: 'Which map size?' });
        await ctx.tool('canvas', { ops: [{ op: 'add', kind: 'risk', title: 'Saved games' }] });
        await ctx.tool('done', { note: 'designed' });
      },
    },
  });
  const room = d.startRoom({ topic: 't', lenses: [{ role: 'designer' }, { role: 'reviewer' }] });
  const hi = await reply(d, room);
  d.roomPost(room, { text: 'Hello' });
  const r = await reply(d, room, hi.seq);
  assert.equal(r.data.text, 'My answer.');
  await until(() => d.agent(room, 'lead')!.state === 'idle', 'the lead rests');
  assert.equal(said(d, room, x => x.kind === 'reply' && x.text === 'thinking out loud').length, 0, 'what it said before done is not posted twice');

  d.roomPost(room, { text: 'try quick' });
  await next(d, room, e => e.type === 'room.message' && e.data.kind === 'lens' && e.data.from === 'designer', 'a quick spawn is sent as a lens');
  const designer = d.agent(room, 'designer')!;
  assert.equal(designer.quick, false);
  assert.match(d.store.since(room).filter(e => e.type === 'agent.tool_result' && e.agent === 'designer')[0].data.summary as string, /Only lead sends lenses/);
  await until(() => d.agent(room, 'lead')!.inbox.length === 0 && d.store.since(room).some(e => e.type === 'message.delivered' && e.agent === 'lead' && e.data.from === 'designer'), "the designer's question reaches the lead");
  assert.equal(d.store.since(room).filter(e => e.type === 'inbox.item').length, 0, 'a lens never asks the human directly');
  assert.equal(d.goals.get(room)!.room!.canvas.cards[0].by, 'designer', 'lenses put cards on the canvas themselves');
  await atRest(d, room);

  assert.match(d.roomLensOff(room, 'reviewer', true), /Put reviewer away/);
  let last = d.store.since(room).at(-1)!.seq;
  d.roomPost(room, { text: 'try away' });
  assert.match(String((await reply(d, room, last)).data.text), /reviewer is put away by the human/);
  last = d.store.since(room).at(-1)!.seq;
  d.roomPost(room, { text: 'try unknown' });
  assert.match(String((await reply(d, room, last)).data.text), /There's no lens called "poet". Lenses you can send: designer\./);
  await d.close();
});

test('a lens on a patch job may change files; the room branch merges once and the cartographer maps it', async () => {
  const { d } = roomTeam({
    lead: async (ctx, text) => {
      if (/from human: fix it/.test(text)) return ctx.say(await ctx.tool('spawn', { role: 'designer', brief: 'Fix the clamp', patch: true }));
      if (/from human: look/.test(text)) return ctx.say(await ctx.tool('spawn', { role: 'scout', brief: 'Look' }));
      ctx.say('ok');
    },
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
  const room = d.startRoom({ topic: 't', lenses: [{ role: 'designer' }, { role: 'scout' }] });
  const g = d.goals.get(room)!;
  await atRest(d, room);
  d.roomPost(room, { text: 'look' });
  await next(d, room, e => e.type === 'room.message' && e.data.from === 'scout', 'scout');
  const scout = d.agent(room, 'scout')!;
  const inRepo = join(scout.cwd, 'x.txt');
  assert.equal((d.toolPolicy(scout, { kind: 'edit', tool: 'Write', detail: inRepo, path: inRepo }) as { allow: boolean }).allow, false);
  assert.equal((d.toolPolicy(d.agent(room, 'lead')!, { kind: 'edit', tool: 'Write', detail: inRepo, path: inRepo }) as { allow: boolean }).allow, false, 'the lead never changes project files');
  const report = join(g.sharedDir, 'reports', 'scout-1.md');
  assert.deepEqual(d.toolPolicy(scout, { kind: 'edit', tool: 'Write', detail: report, path: report }), { allow: true }, 'reports in the shared folder are fine');

  await atRest(d, room);
  d.roomPost(room, { text: 'fix it' });
  await next(d, room, e => e.type === 'room.writer' && e.data.on === true, 'write access for the patch job');
  await next(d, room, e => e.type === 'room.writer' && e.data.on === false, 'write access ends with the answer');
  assert.equal(said(d, room, x => x.kind === 'dispatch' && x.patch === true).length, 1);

  const before = git(d.repo, 'rev-parse', 'HEAD');
  assert.match(d.roomMerge(room), /Merged 1 commit.*cartographer maps the result/);
  assert.notEqual(git(d.repo, 'rev-parse', 'HEAD'), before);
  assert.ok(existsSync(join(d.repo, 'fix.txt')));
  await next(d, room, e => e.type === 'room.message' && e.data.kind === 'note' && /^cartographer: /.test(String(e.data.text)), 'the cartographer maps the merge');
  assert.equal(d.agent(room, 'cartographer')!.cwd, d.repo, "it works in the human's checkout");
  assert.match(d.roomMerge(room), /Nothing to merge/);
  await d.close();
});

test('cards branch into a room of their own; a new room carries a past canvas over; a goal from a room reads it', async () => {
  const { d, leadTexts } = roomTeam();
  const first = d.startRoom({ topic: 'First', lenses: [{ role: 'designer' }] });
  d.roomCanvas(first, parseCanvasOps({ ops: [
    { op: 'add', kind: 'question', title: 'Wrap or wall?', ref: 'q' },
    { op: 'add', kind: 'idea', title: 'Walls', links: ['q'] },
    { op: 'add', kind: 'idea', title: 'Wrap' },
    { op: 'add', kind: 'risk', title: 'Saves', links: ['c2'] },
  ] }), 'human');
  d.roomCanvas(first, [{ op: 'drop', id: 'c3' }], 'human');

  const branch = d.startRoom({ topic: 'Walls', from: first, cards: ['c2'] });
  const b = d.goals.get(branch)!.room!.canvas;
  assert.deepEqual(b.cards.map(c => [c.id, c.title, c.by]), [['c1', 'Wrap or wall?', 'human'], ['c2', 'Walls', 'human'], ['c3', 'Saves', 'human']], 'the card and those linked to it, renumbered');
  assert.deepEqual(b.links, [{ from: 'c2', to: 'c1' }, { from: 'c3', to: 'c2' }]);
  assert.deepEqual(d.goals.get(first)!.room!.canvas.cards[1].branches, [branch], 'the card shows where it branched');
  await until(() => leadTexts.some(t => /The canvas starts with 3 cards carried over/.test(t)), "the branch's lead reads the carried cards");

  d.endGoal(first);
  const again = d.startRoom({ topic: 'Second', from: first });
  assert.deepEqual(d.goals.get(again)!.room!.canvas.cards.map(c => c.title), ['Wrap or wall?', 'Walls', 'Saves'], 'dropped cards stay behind');

  const goal = d.startGoal({ request: 'Build the walls', lead: 'designer', fromRoom: first });
  assert.match(d.agent(goal, 'designer')!.brief, /comes out of a brainstorm room[\s\S]*canvas\.md/);
  assert.equal(d.listGoals().find(x => x.id === first)?.kind, 'room');
  assert.match(d.canvasTool(d.agent(goal, 'designer')!, []), /only|for brainstorm rooms/);
  await d.close();
});

test('the human can stop the lead or a lens mid-turn: what it said so far is its reply or answer', async () => {
  for (const interrupt of [true, false]) {
    const { d, fake } = roomTeam({
      lead: async (ctx, text) => {
        if (/ramble/.test(text)) {
          ctx.say('Let me think about edges…');
          await ctx.run('sleep 30', 5000);
          return;
        }
        if (/send/.test(text)) return ctx.say(await ctx.tool('spawn', { role: 'designer', brief: 'Think it through' }));
        ctx.say(/finished/.test(text) ? `heard: ${text.split('finished: ')[1]}` : 'Hi.');
      },
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
    const room = d.startRoom({ topic: 't', lenses: [{ role: 'designer' }] });
    const hi = await reply(d, room);
    d.roomPost(room, { text: 'ramble' });
    await until(() => d.store.since(room).some(e => e.type === 'agent.text' && e.data.text === 'Let me think about edges…'), 'the lead starts');
    assert.match(d.roomStop(room, 'lead'), /Stopped lead/);
    const stopped = await reply(d, room, hi.seq);
    assert.deepEqual([stopped.data.text, stopped.data.stopped], ['Let me think about edges…', true]);
    await until(() => !d.agent(room, 'lead')!.session?.busy(), 'the lead rests');

    d.roomPost(room, { text: 'send' });
    await until(() => d.store.since(room).some(e => e.type === 'agent.text' && e.agent === 'designer'), 'the designer starts');
    await until(() => d.agent(room, 'lead')!.state === 'idle', 'the lead ends its turn');
    assert.match(d.roomStop(room, 'designer'), /Stopped designer/);
    const answer = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'lens', 'the stopped answer');
    assert.deepEqual([answer.data.text, answer.data.stopped], ['First thoughts: wrap around.', true]);
    await next(d, room, e => e.type === 'room.message' && e.data.kind === 'reply' && /heard: \(the human stopped it here\) First thoughts/.test(String(e.data.text)), 'the lead hears it');
    assert.equal(said(d, room, x => x.kind === 'lens').length, 1, "the stopped turn's end isn't another answer");
    await d.close();
  }
});
