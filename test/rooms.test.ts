import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeCtx } from '../src/adapters/fake.ts';
import { applyCanvas, branchCards, canvasMarkdown, castText, demoKnobs, demoPage, lensName, makesOf, parseCanvasOps, parseCast, responsibilityOf, seedCanvas, type Canvas } from '../src/rooms.ts';
import { git } from '../src/git.ts';
import { agyToolRequest } from '../src/adapters/agy.ts';
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
  const turns: Record<string, (ctx: FakeCtx, text: string) => Promise<void>> = { scout: answer, designer: answer, reviewer: answer, illustrator: answer, model: answer, 'room-lead': lead, ...o.scripts };
  const scripts = Object.fromEntries(Object.entries(turns).map(([k, f]) => [k, (ctx: FakeCtx) => f(ctx, ctx.spec.brief)]));
  const fake = new FakeAdapter(scripts, {}, turns);
  const d = makeTeam({
    roles: { scout: role(), designer: role(), reviewer: role(), illustrator: role(), 'room-lead': role() },
    adapters: { fake },
  });
  return { d, fake, leadTexts };
}

test('makers, casts and the board read and write plainly', () => {
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
  assert.match(responsibilityOf({ role: 'scout' }), /^Find things out/, "a role's usual responsibility");
  assert.deepEqual(['researcher', 'illustrator', 'prototyper', 'writer', 'reviewer'].map(role => makesOf({ role })), ['source', 'image', 'demo', 'text', 'text'], 'what each maker makes');
  assert.equal(makesOf({ on: 'codex/x', responsibility: 'Something of my own' }), 'text');
  assert.equal(responsibilityOf({ role: 'scout', responsibility: 'Only read the logs.' }), 'Only read the logs.');

  const c: Canvas = { cards: [], links: [], frames: [], seq: 0 };
  let r = applyCanvas(c, parseCanvasOps({ ops: [{ op: 'add', kind: 'question', title: 'Wrap or wall?', ref: 'q' }, { op: 'add', kind: 'option', title: 'Walls', links: [{ to: 'q', label: 'answers' }] }, { title: 'Clamp in Move.gd', kind: 'fact', refs: 'src/Move.gd:40' }] }), 'lead');
  assert.deepEqual(r.done, ['added c1 (question): Wrap or wall?', 'added c2 (idea): Walls, linked to c1', 'added c3 (finding): Clamp in Move.gd']);
  assert.deepEqual(c.links, [{ from: 'c2', to: 'c1', label: 'answers' }], 'a card added with a ref can be linked to in the same call');
  assert.deepEqual(c.cards[2].refs, ['src/Move.gd:40']);
  r = applyCanvas(c, [{ op: 'add', kind: 'question', title: 'wrap or wall?' }, { op: 'settle', id: 'c9' }], 'scout');
  assert.equal(r.changed, false);
  assert.deepEqual(r.skipped, ['"wrap or wall?" is already on the board as c1', "there's no card c9"]);
  r = applyCanvas(c, parseCanvasOps({ op: 'link', from: 'c3', to: 'c2', label: 'rules out' }), 'scout');
  applyCanvas(c, [{ op: 'note', id: 'c2', text: 'Saved games keep positions outside' }, { op: 'drop', id: 'c2' }, { op: 'settle', id: 'C1' }], 'reviewer');
  assert.deepEqual(c.cards.map(x => [x.id, x.status ?? 'open']), [['c1', 'settled'], ['c2', 'dropped'], ['c3', 'open']]);
  assert.deepEqual(c.cards[1].notes, [{ by: 'reviewer', text: 'Saved games keep positions outside' }]);
  const md = canvasMarkdown('Edges', c);
  assert.match(md, /## Ideas\n\n- \[c2\] \(idea, dropped\) Walls  → c1 \(answers\)  — lead\n  · reviewer: Saved games/);
  assert.match(md, /- \[c3\] \(finding\) Clamp in Move.gd  → c2 \(rules out\)  — lead\n  files: src\/Move.gd:40/);

  applyCanvas(c, [{ op: 'add', kind: 'risk', title: 'Unrelated' }], 'lead');
  assert.deepEqual(branchCards(c, ['c3']).cards.map(x => x.id), ['c2', 'c3'], 'a branch takes the cards linked to the ones picked');
  applyCanvas(c, [{ op: 'remove', id: 'c2' }], 'human');
  assert.deepEqual(c.links, [], "a removed card's links go with it");
  assert.deepEqual(parseCanvasOps({ ops: '[{"op":"close","id":"c1"},{"op":"delete","id":"c3"}]' }), [{ op: 'settle', id: 'c1' }, { op: 'remove', id: 'c3' }], 'ops may come as JSON text, under other names');
});

test('the human talks with the lead; it sends makers, whose answers wake it, and keeps the board', async () => {
  const { d, leadTexts } = roomTeam();
  const room = d.startRoom({ topic: 'Creatures die at the map edge', lenses: [{ role: 'scout' }, { role: 'designer', stance: 'simplest fix' }] });
  const g = d.goals.get(room)!;
  assert.equal(g.lead, 'lead');
  let r = await reply(d, room);
  assert.equal(r.data.text, 'Hello.', "the lead's opening turn is its first reply");
  const lead = d.agent(room, 'lead')!;
  assert.match(lead.systemPrompt, /## A brainstorm room/);
  assert.match(lead.systemPrompt, /- scout \(scout; makes source cards; searches the web, makes images\): Find things out/, 'what each maker makes, and what its harness can do');
  assert.match(lead.systemPrompt, /- designer \(designer; makes text cards[^)]*\): Explain the bigger picture.* Stance: simplest fix/);
  assert.match(leadTexts[0], /Creatures die at the map edge\n\n\[Room\] The board is empty/);

  d.roomPost(room, { text: 'Where is the clamp? → scout' });
  const dispatch = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'dispatch', 'the lead sends the scout');
  assert.deepEqual([dispatch.data.from, dispatch.data.to], ['lead', ['scout']]);
  const lens = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'lens', "the scout's answer shows in the chat");
  assert.equal(lens.data.text, 'scout on: Where is the clamp? → scout');
  r = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'reply' && /scout says/.test(String(e.data.text)), 'the lead passes it on');
  assert.equal(d.agent(room, 'scout')!.parent, 'lead');
  assert.match(d.agent(room, 'scout')!.systemPrompt, /## A maker in a brainstorm room[\s\S]*You make source cards[\s\S]*Search the web/);
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
  assert.match(leadTexts.at(-1)!, /\[Room\] The human changed the board: added c1 \(idea\): Walls/, 'the lead hears what the human changed');
  assert.equal(d.listGoals().find(x => x.id === room)?.status, 'running', 'a room is open until the human ends it');
  assert.match(readFileSync(join(g.sharedDir, 'room', 'chat.md'), 'utf8'), /### You → lead\n\nWhere is the clamp\?/);
  await d.close();
});

test("the lead's done is a reply, never an ending; it can't wait on a maker; makers talk only with it", async () => {
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
  assert.match(d.store.since(room).filter(e => e.type === 'agent.tool_result' && e.agent === 'designer')[0].data.summary as string, /Only lead sends makers/);
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
  assert.match(String((await reply(d, room, last)).data.text), /There's no maker called "poet". Makers you can send: designer\./);
  await d.close();
});

test('the board: frames, places, files, ingredients, values and pillars', () => {
  const shared = '/home/u/.metaharness/goals/r1/shared';
  const c: Canvas = { cards: [], links: [], frames: [], seq: 0 };
  let r = applyCanvas(c, parseCanvasOps({ ops: [
    { op: 'add', kind: 'image', title: 'Moody watercolor', file: `${shared}/room/media/a.png`, frame: 'Look' },
    { op: 'add', kind: 'reference', title: 'Hades combat', url: 'https://example.com/hades', frame: 'Combat' },
    { op: 'add', kind: 'image', title: 'Escaped', file: '/etc/passwd' },
  ] }), 'illustrator', shared);
  assert.deepEqual(c.frames.map(f => [f.id, f.title]), [['f1', 'Look'], ['f2', 'Combat']], 'a new frame title makes the frame');
  assert.deepEqual(c.cards.map(x => [x.id, x.kind, x.frame ?? '-', x.file ?? x.url ?? '-']), [['c1', 'image', 'f1', 'room/media/a.png'], ['c2', 'source', 'f2', 'https://example.com/hades'], ['c3', 'image', '-', '-']], 'files are kept relative to the shared folder');
  assert.match(r.skipped.join(), /c3's file \/etc\/passwd isn't in the room's shared folder/);

  r = applyCanvas(c, parseCanvasOps({ ops: [
    { op: 'add', kind: 'image', title: 'Mix', from: ['c1: its mood', { id: 'c2', take: 'combat' }] },
    { op: 'add', kind: 'decision', title: 'Jump values', values: { gravity: '1400', jump: 720, junk: 'x' } },
    { op: 'add', kind: 'concept', title: 'The game', pillars: [{ name: 'Look', text: 'Watercolor, dim', cards: ['c1'] }] },
    { op: 'frame', title: 'Look', cards: ['c4'] },
    { op: 'move', id: 'c2', frame: '', x: 300.4, y: 40 },
    { op: 'move', id: 'f1', x: 10, y: 20 },
  ] }), 'human', shared);
  assert.deepEqual(c.cards[3].from, [{ id: 'c1', take: 'its mood' }, { id: 'c2', take: 'combat' }]);
  assert.deepEqual(c.cards[4].values, { gravity: 1400, jump: 720 }, 'values are numbers');
  assert.deepEqual(c.cards[5].pillars, [{ name: 'Look', text: 'Watercolor, dim', cards: ['c1'] }]);
  assert.equal(c.cards[3].frame, 'f1', 'a frame op puts cards in an existing frame');
  assert.deepEqual([c.cards[1].frame, c.cards[1].at], [undefined, { x: 300, y: 40 }], 'moved out of its frame, to where it was dropped');
  assert.deepEqual(c.frames[0].at, { x: 10, y: 20 });

  const md = canvasMarkdown('A game', c, shared);
  assert.match(md, /## Frame f1: Look\n\n- \[c1\] \(image\) Moody watercolor  — illustrator\n  file: \/home\/u\/.metaharness\/goals\/r1\/shared\/room\/media\/a.png/);
  assert.match(md, /made from: c1 "Moody watercolor" \(its mood\), c2 "Hades combat" \(combat\)/);
  assert.match(md, /values: gravity = 1400, jump = 720/);
  assert.match(md, /◆ Look: Watercolor, dim \[c1\]/);

  applyCanvas(c, [{ op: 'tidy' }], 'human');
  assert.equal(c.cards[1].at, undefined, 'tidy lets cards be laid out again');
  applyCanvas(c, [{ op: 'remove', id: 'f1' }, { op: 'remove', id: 'c2' }], 'human');
  assert.deepEqual([c.frames.map(f => f.id), c.cards[0].frame], [['f2'], undefined], "a removed frame's cards stay, free");
  assert.deepEqual(c.cards.find(x => x.id === 'c4')!.from, [{ id: 'c1', take: 'its mood' }], 'a removed card leaves the mixes made from it');

  const next: Canvas = { cards: [], links: [], frames: [], seq: 0 };
  seedCanvas(next, branchCards(c, ['c4']), 'room r1');
  seedCanvas(next, { cards: c.cards.filter(x => x.id === 'c1' || x.id === 'c4'), links: [] }, 'room r1');
  assert.deepEqual(next.cards.at(-1)!.from, [{ id: 'c2', take: 'its mood' }], 'carried over, a mix still points at its ingredients');
  assert.equal(next.cards.some(x => x.frame), false, 'out of their frames');
});

test('a demo declares its knobs; the room plays it with window.knobs set before its scripts run', () => {
  const html = '<!doctype html><html><head><title>J</title><script type="application/json" id="knobs">[{"name":"gravity","min":0,"max":10,"value":4,"unit":"g"},{"name":"bad","min":"x"}]</script></head><body><script>run()</script></body></html>';
  assert.deepEqual(demoKnobs(html), [{ name: 'gravity', min: 0, max: 10, value: 4, unit: 'g' }]);
  const page = demoPage(html, { gravity: 7 });
  assert.match(page, /<head><script>\(function\(\)\{var k=window\.knobs=\{"gravity":7\}/, 'kept values start the knobs, first thing in the head');
  assert.ok(page.indexOf('window.knobs') < page.indexOf('run()'));
  assert.match(demoPage('<canvas></canvas>'), /^<script>.*window\.knobs=\{\}/, 'a page without a head still gets them');
});

test('nobody changes project files in a room; the human asks makers directly and mixes cards, and the lead only hears of it', async () => {
  const { d, leadTexts } = roomTeam({
    scripts: {
      illustrator: async (ctx, text) => {
        const fill = /Fill cards? ([c\d, ]+)/.exec(text)?.[1].split(/,\s*/).map(x => x.trim()).filter(Boolean) ?? [];
        ctx.writeShared('room/media/mix.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
        await ctx.tool('canvas', { ops: fill.map((id, n) => ({ op: 'edit', id, title: `Take ${n + 1}`, file: join(ctx.spec.sharedDir, 'room/media/mix.svg') })) });
        await ctx.tool('done', { note: `made ${fill.join(', ')}` });
      },
    },
  });
  const room = d.startRoom({ topic: 'A game', lenses: [{ role: 'illustrator' }, { role: 'scout' }] });
  const g = d.goals.get(room)!;
  await reply(d, room);

  // Reading, reports and images are fine; the project's files are not.
  const lead = d.agent(room, 'lead')!;
  const inRepo = join(d.repo, 'x.txt');
  assert.match(String((d.toolPolicy(lead, { kind: 'edit', tool: 'Write', detail: inRepo, path: inRepo }) as { reason: string }).reason), /nobody changes the project's files here/);
  const report = join(g.sharedDir, 'reports', 'lead-1.md');
  assert.deepEqual(d.toolPolicy(lead, { kind: 'edit', tool: 'Write', detail: report, path: report }), { allow: true });
  assert.deepEqual(d.toolPolicy(lead, { kind: 'image', tool: 'generate_image', detail: 'a cat' }), { allow: true }, 'images are made without asking in a room');
  assert.deepEqual(agyToolRequest('invoke_subagent', { TypeName: 'image-generator', Prompt: 'a crab' }), { kind: 'image', tool: 'invoke_subagent', detail: 'a crab' }, "Antigravity's image subagent is an image request");
  assert.equal(agyToolRequest('invoke_subagent', { TypeName: 'research' }).kind, 'delegate', 'its other subagents stay refused');
  const native = lead.session!.nativeId;
  assert.deepEqual(d.toolPolicy(lead, agyToolRequest('send_message', { Recipient: native, Message: 'Final image path: x.jpg' })), { allow: true }, 'the subagent reports back to the session that started it');
  assert.equal((d.toolPolicy(lead, agyToolRequest('send_message', { Recipient: 'someone-else', Message: 'hi' })) as { allow: boolean }).allow, false, 'other harness messages stay refused');
  const goal = d.startGoal({ request: 'x', lead: 'scout' });
  assert.equal(d.toolPolicy(d.agent(goal, 'scout')!, { kind: 'image', tool: 'generate_image', detail: 'a cat' }), 'ask', 'in a goal the human decides');

  d.roomCanvas(room, [{ op: 'add', kind: 'image', title: 'Moody' }, { op: 'add', kind: 'source', title: 'Hades combat' }], 'human');
  await atRest(d, room);
  const turns = leadTexts.length;
  assert.throws(() => d.roomMix(room, { cards: [{ id: 'c1' }], make: 'demo' }), /No maker here makes demo cards/);
  assert.match(d.roomMix(room, { cards: [{ id: 'c1', take: 'mood' }, { id: 'c2', take: 'combat' }], make: 'image', count: 2 }), /Sent illustrator/);
  const placeholders = g.room!.canvas.cards.slice(2);
  assert.deepEqual(placeholders.map(x => [x.id, x.kind, x.pending, x.from?.map(i => i.take).join('+')]), [['c3', 'image', 'illustrator', 'mood+combat'], ['c4', 'image', 'illustrator', 'mood+combat']], 'placeholders go on the board at once');
  assert.match(d.agent(room, 'illustrator')!.brief, /\[Mix\] The human wants 2 images made from these cards[\s\S]*c1 \(image\) "Moody" — take: mood[\s\S]*Fill cards c3, c4/);
  const answer = await next(d, room, e => e.type === 'room.message' && e.data.kind === 'lens' && e.data.from === 'illustrator', "the illustrator's answer");
  assert.deepEqual(answer.data.to, ['human'], 'it answers the human, who asked');
  assert.deepEqual(g.room!.canvas.cards.slice(2).map(x => [x.title, x.file, x.pending]), [['Take 1', 'room/media/mix.svg', undefined], ['Take 2', 'room/media/mix.svg', undefined]]);
  assert.equal(said(d, room, x => x.kind === 'dispatch' && x.from === 'human').length, 1);

  d.roomAsk(room, { maker: 'scout', text: 'Find references', cards: ['c3'] });
  await next(d, room, e => e.type === 'room.message' && e.data.kind === 'lens' && e.data.from === 'scout', "the scout's answer");
  assert.match(d.agent(room, 'scout')!.brief, /\[About c3 \(image\) "Take 1"\]\nFind references/);
  await atRest(d, room);
  assert.equal(leadTexts.length, turns, "makers the human asked don't wake the lead");
  d.roomPost(room, { text: 'What do you think?' });
  await until(() => leadTexts.length > turns, 'the lead hears the human');
  assert.match(leadTexts.at(-1)!, /The human mixed cards: Mix c1 \(mood\) \+ c2 \(combat\) → 2 images[\s\S]*illustrator answered the human: made c3, c4[\s\S]*The human asked scout directly about c3/, 'and of what the makers did, with it');

  // The room's images and demos, for the browser.
  writeFileSync(join(g.sharedDir, 'room', 'demos', 'j.html'), '<html><head></head><body><script type="application/json" id="knobs">[{"name":"g","min":0,"max":9,"value":3}]</script></body></html>');
  assert.match(String(d.roomMedia(room, 'room/demos/j.html', { g: 5 }).body), /window\.knobs=\{"g":5\}/);
  assert.equal(d.roomMedia(room, 'room/media/mix.svg').type, 'image/svg+xml');
  assert.throws(() => d.roomMedia(room, '../../../etc/passwd.png'), /isn't an image or a demo/);
  assert.throws(() => d.roomMedia(room, 'room/chat.md'), /isn't an image or a demo/);
  await d.close();
});

test('a room starts with the built-in makers when none are picked', async () => {
  const { d } = roomTeam();
  const room = d.startRoom({ topic: 't' });
  assert.deepEqual(d.goals.get(room)!.room!.lenses.map(l => l.name), ['researcher', 'illustrator', 'prototyper', 'writer']);
  await d.close();
});

test('cards branch into a room of their own; a new room carries a past board over; a goal from a room reads it', async () => {
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
  await until(() => leadTexts.some(t => /The board starts with 3 cards carried over/.test(t)), "the branch's lead reads the carried cards");

  d.endGoal(first);
  const again = d.startRoom({ topic: 'Second', from: first });
  assert.deepEqual(d.goals.get(again)!.room!.canvas.cards.map(c => c.title), ['Wrap or wall?', 'Walls', 'Saves'], 'dropped cards stay behind');

  const goal = d.startGoal({ request: 'Build the walls', lead: 'designer', fromRoom: first });
  assert.match(d.agent(goal, 'designer')!.brief, /comes out of a brainstorm room[\s\S]*canvas\.md/);
  assert.equal(d.listGoals().find(x => x.id === first)?.kind, 'room');
  assert.match(d.canvasTool(d.agent(goal, 'designer')!, []), /only|for brainstorm rooms/);
  await d.close();
});

test('the human can stop the lead or a maker mid-turn: what it said so far is its reply or answer', async () => {
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
