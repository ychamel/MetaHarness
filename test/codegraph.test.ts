import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildGraph, CODE_READERS, godotProject, rootScript, type CodeGraph } from '../src/codegraph.ts';
import { DesignTracker } from '../src/design.ts';
import * as gitx from '../src/git.ts';
import { git } from '../src/git.ts';
import { loadLanguages, Outliner } from '../src/languages.ts';
import { between, canvasOf, classLinks, collapseWires, groupClasses, indexGraph, makeTree, railClasses, stacksTo, stepsDown, type LinkKind } from '../ui/src/codeData.ts';
import { marksOf } from '../ui/src/designData.ts';
import { parseSystems } from '../src/design.ts';
import { makeRepo } from './helpers.ts';

/** A small game: a main scene, an event bus, a world that ticks creatures and plants, an ecosystem that evolves genomes. */
const GAME: Record<string, string> = {
  'project.godot': '[application]\nrun/main_scene="res://scenes/main.tscn"\n\n[autoload]\nEvents="*res://scripts/events.gd"\nGameState="*res://scripts/game_state.gd"\n',
  'scenes/main.tscn': '[gd_scene format=3]\n[ext_resource type="Script" path="res://scripts/main.gd" id="1_a"]\n[node name="Main" type="Node"]\nscript = ExtResource("1_a")\n',
  'scripts/events.gd': 'extends Node\nsignal creature_died(c)\nsignal round_ended(result: Dictionary)\n',
  'scripts/game_state.gd': 'extends Node\nvar generation := 0\nvar species: Array[Species] = []\nfunc apply_round_result(r: Dictionary) -> void:\n\tgeneration += 1\n\tEcosystem.evolve(species)\n',
  'scripts/main.gd':
    'extends Node\nvar world: World\nfunc _ready() -> void:\n\tEvents.round_ended.connect(_on_round_ended)\n\tworld = World.new()\n\tadd_child(world)\n\tworld.start_round()\n' +
    'func _on_round_ended(result: Dictionary) -> void:\n\tGameState.apply_round_result(result)\n',
  'scripts/sim/world.gd':
    'class_name World\nextends Node2D\nvar creatures: Array[Creature] = []\nvar plants := PlantField.new()\n' +
    'func start_round() -> void:\n\tcreatures.append(Creature.new())\n' +
    'func _physics_process(delta: float) -> void:\n\tstep(delta)\n' +
    'func step(delta: float) -> void:\n\tplants.tick(delta)\n\tfor c in creatures:\n\t\tc.tick(delta)\n\tif creatures.is_empty():\n\t\tEvents.round_ended.emit({})\n',
  'scripts/sim/plant_field.gd': 'class_name PlantField\nextends RefCounted\nvar food := 0.0\nfunc tick(delta: float) -> void:\n\tfood += delta\n',
  'scripts/sim/creature.gd':
    'class_name Creature\nextends Node2D\nvar species: Species\nvar alive := true\n' +
    'func tick(delta: float) -> void:\n\tvar s := species.genome.stats()\n\tif s.is_empty():\n\t\tdie()\n' +
    'func die() -> void:\n\talive = false\n\tEvents.creature_died.emit(self)\n',
  'scripts/core/species.gd': 'class_name Species\nextends RefCounted\nvar genome: Genome\n',
  'scripts/core/genome.gd':
    'class_name Genome\nextends RefCounted\nvar traits: Array = []\nvar _cache := {}\nfunc stats() -> Dictionary:\n\treturn _cache\n' +
    'func adopt(t: String) -> void:\n\ttraits.append(t)\n\tmark_dirty()\nfunc mark_dirty() -> void:\n\t_cache = {}\n\n\nclass Part extends RefCounted:\n\tfunc grow() -> void:\n\t\tpass\n',
  'scripts/eco/ecosystem.gd': 'class_name Ecosystem\nextends RefCounted\nstatic func evolve(all: Array[Species]) -> void:\n\tfor s in all:\n\t\ts.genome.adopt("fins")\n\t\tvar p := Genome.Part.new()\n\t\tp.grow()\n',
  'scripts/render/fx.gd': 'class_name FX\nextends Node2D\nfunc _ready() -> void:\n\tEvents.creature_died.connect(_died)\n\tEvents.creature_died.connect(func(c): queue_redraw())\nfunc _died(c) -> void:\n\tc.die()\n',
  'tests/test_world.gd': 'extends SceneTree\nfunc _init():\n\tWorld.new().step(1.0)\n',
};

async function graphOf(files: Record<string, string>): Promise<CodeGraph> {
  const packs = loadLanguages([]);
  const o = new Outliner(packs);
  const gd = packs.get('gdscript')!;
  assert.equal(gd.code, 'gdscript');
  const inputs = [];
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.gd') || path.startsWith('tests/')) continue;
    inputs.push({ path, area: path.split('/').slice(0, -1).join('/'), facts: (await o.parse(gd, text, CODE_READERS.gdscript))! });
  }
  return buildGraph(inputs, godotProject(files['project.godot'], 'project.godot', p => files[p], ['scenes/main.tscn']));
}

const has = (g: CodeGraph, k: string, f: string, t: string) => g.edges.some(e => e.k === k && e.f === f && e.t === t);

test('the code graph follows calls through declared types, signals through the bus, and objects made', async () => {
  const g = await graphOf(GAME);
  const cls = new Map(g.classes.map(c => [c.id, c]));
  assert.equal(cls.get('Main')?.main, true, 'the main scene runs main.gd');
  assert.equal(cls.get('Events')?.kind, 'autoload');
  assert.equal(cls.get('World')?.base, 'Node2D');
  assert.ok(cls.has('Genome.Part'), 'an inner class');
  assert.ok(has(g, 'new', 'Main._ready', 'World'));
  assert.ok(has(g, 'call', 'Main._ready', 'World.start_round'), 'through a typed member');
  assert.ok(has(g, 'call', 'World._physics_process', 'World.step'));
  assert.ok(has(g, 'call', 'World.step', 'PlantField.tick'), 'a member typed by `:= PlantField.new()`');
  assert.ok(has(g, 'call', 'World.step', 'Creature.tick'), 'the element of an Array[Creature]');
  assert.ok(has(g, 'call', 'Creature.tick', 'Genome.stats'), 'down a chain of typed members');
  assert.ok(has(g, 'call', 'Ecosystem.evolve', 'Genome.adopt'));
  assert.ok(has(g, 'new', 'Ecosystem.evolve', 'Genome.Part') && has(g, 'call', 'Ecosystem.evolve', 'Genome.Part.grow'));
  assert.ok(has(g, 'call', 'GameState.apply_round_result', 'Ecosystem.evolve'), 'a static call on a class_name');
  assert.ok(has(g, 'call', 'Main._on_round_ended', 'GameState.apply_round_result'), 'an autoload by its name');
  assert.ok(has(g, 'emit', 'World.step', 'Events.round_ended') && has(g, 'emit', 'Creature.die', 'Events.creature_died'));
  const listen = g.edges.filter(e => e.k === 'listen' && e.f === 'Events.creature_died');
  assert.deepEqual(listen.map(e => [e.t, e.via, !!e.lam]).sort(), [['FX._died', 'FX._ready', false], ['FX._ready', 'FX._ready', true]]);
  assert.ok(has(g, 'listen', 'Events.round_ended', 'Main._on_round_ended'));
  assert.ok(has(g, 'call', 'FX._died', 'Creature.die') && g.edges.find(e => e.f === 'FX._died')!.g, 'an untyped receiver, guessed by the one method of that name');
  assert.ok(has(g, 'read', 'Creature.tick', 'Species.genome'), "another class's state read");
  const fns = new Map(g.fns.map(f => [f.id, f]));
  assert.ok(fns.get('Genome.adopt')?.mut && fns.get('Genome.mark_dirty')?.mut, 'changes its object, itself or through its own method');
  assert.ok(!fns.get('Genome.stats')?.mut);
  assert.ok(fns.get('GameState.apply_round_result')?.mut, '+= on a member');
  assert.ok(fns.get('Creature.die')?.mut);
  assert.ok(!g.fns.some(f => f.file.startsWith('tests/')), 'tests are left out');
  assert.deepEqual(g.entries[0], 'Main._ready', "the main scene's callbacks first");
  assert.ok(g.entries.includes('World._physics_process') && !g.entries.some(e => e.endsWith('._init')));
  assert.ok(g.stats.calls > 0 && g.stats.unresolved === 0, JSON.stringify(g.stats));
});

test('the Systems lens: steps in order, stacks from the engine, and where two systems meet', async () => {
  const ix = indexGraph(await graphOf(GAME));
  assert.deepEqual(stepsDown(ix, 'World.step').map(s => `${s.kind} ${s.id}`), ['call PlantField.tick', 'call Creature.tick', 'emit Events.round_ended']);
  assert.deepEqual(stepsDown(ix, 'Events.round_ended').map(s => s.id), ['Main._on_round_ended'], 'a signal goes on to its handlers');
  const stacks = stacksTo(ix, 'Genome.stats').map(s => s.frames.join(' > '));
  assert.ok(stacks.includes('World._physics_process > World.step > Creature.tick > Genome.stats'), stacks.join('\n'));
  // Evolution reaches creatures through the genome: the ecosystem changes it, creatures read it.
  const links = classLinks(ix);
  const b = between(ix, links, new Set(['Ecosystem']), new Set(['Creature']));
  const genome = b.meetings.find(m => m.mid === 'Genome');
  assert.equal(genome?.how, 'a⇒b');
  assert.ok(links.some(l => l.kind === 'signal' && l.from === 'Creature' && l.to === 'FX' && l.names.has('creature_died')), 'a signal links emitter to listener');
});

test("a scene's root script, and the code graph kept per commit by the tracker", async () => {
  assert.equal(rootScript(GAME['scenes/main.tscn']), 'res://scripts/main.gd');
  assert.equal(rootScript('[gd_scene]\n[node name="A" type="Node"]\n[node name="B" parent="."]\nscript = ExtResource("1")\n'), undefined, "a child's script isn't the root's");
  const repo = makeRepo();
  for (const [p, text] of Object.entries(GAME)) {
    mkdirSync(dirname(join(repo, 'game', p)), { recursive: true });
    writeFileSync(join(repo, 'game', p), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'Game');
  const tracker = new DesignTracker(mkdtempSync(join(tmpdir(), 'mh-home-')), new Outliner(loadLanguages([])));
  const gg = gitx.setupGoal(repo, 'g') as gitx.GoalGit;
  const g = await tracker.code('g', gg, repo, git(repo, 'rev-parse', 'HEAD'));
  assert.ok(g.classes.find(c => c.id === 'Main')?.main, 'res:// starts at the folder of project.godot');
  assert.ok(has(g, 'call', 'World.step', 'Creature.tick'));
  assert.ok(!g.classes.some(c => c.file.includes('tests/')));
  const snap = await tracker.get('g', gg, repo, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(g.classes.find(c => c.id === 'World')?.area, snap.files.find(f => f.path === 'game/scripts/sim/world.gd')?.area, 'areas from the snapshot');
  assert.deepEqual(await tracker.code('g', gg, repo, git(repo, 'rev-parse', 'HEAD')), g, 'kept, and read back');
});

test('doc comments, and the map naming groups of classes', async () => {
  const g = await graphOf({
    ...GAME,
    'scripts/sim/creature.gd': '## One creature: moves, eats, dies.\nclass_name Creature\nextends Node2D\n## Whether it still lives.\nvar alive := true\n\n## Runs each tick.\nfunc tick(delta: float) -> void:\n\tpass\n',
    'scripts/core/genome.gd': 'class_name Genome\nextends RefCounted\n## Heritable traits.\n\n## The stats.\nfunc stats() -> Dictionary:\n\treturn {}\n',
  });
  const cls = new Map(g.classes.map(c => [c.id, c]));
  assert.equal(cls.get('Creature')?.doc, 'One creature: moves, eats, dies.', 'before class_name, the member doc kept apart');
  assert.equal(cls.get('Genome')?.doc, 'Heritable traits.', "after extends, not the first function's");
  assert.equal(g.fns.find(f => f.id === 'Creature.tick')?.doc, 'Runs each tick.');
  assert.equal(g.fns.find(f => f.id === 'Genome.stats')?.doc, 'The stats.');
  const map = '# Game\n\n## Systems\n\n- **Life** (`Creature`, world.gd) — creatures living in the world\n- Nothing (Missing) — no such class\n\n## Flows\n- A (Genome) — not a system\n';
  assert.deepEqual(parseSystems(map, g.classes), [{ name: 'Life', classes: ['Creature', 'World'], text: 'creatures living in the world' }]);
});

test('the canvas: groups in a large area, rails, and a focus with its neighbours and chips', () => {
  // An area of 12 classes in two tight clusters joined by one call, an autoload most of them use, another area.
  const cls: { id: string; area: string; kind?: 'autoload' }[] = [];
  const fns: { id: string; cls: string }[] = [];
  const edges: { f: string; t: string; k: 'call'; l: number }[] = [];
  const add = (id: string, area: string, kind?: 'autoload') => (cls.push({ id, area, ...(kind ? { kind } : {}) }), fns.push({ id: `${id}.f`, cls: id }));
  for (let i = 0; i < 6; i++) add(`A${i}`, 'sim', undefined), add(`B${i}`, 'sim', undefined);
  add('Hud', 'ui');
  add('State', 'auto', 'autoload');
  const call = (a: string, b: string) => edges.push({ f: `${a}.f`, t: `${b}.f`, k: 'call', l: 1 });
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) if (i !== j) (call(`A${i}`, `A${j}`), call(`B${i}`, `B${j}`));
  call('A0', 'B0');
  call('Hud', 'A1');
  for (const c of cls) if (c.id !== 'State') call(c.id, 'State');
  const g = {
    version: 2, classes: cls.map(c => ({ id: c.id, name: c.id, file: `${c.area}/${c.id}.gd`, area: c.area, line: 1, end: 9, kind: c.kind ?? 'class' })),
    fns: fns.map(f => ({ ...f, name: 'f', file: '', line: 1, end: 2 })), signals: [], fields: [], edges, entries: [],
    stats: { files: 0, calls: 0, resolved: 0, guessed: 0, unresolved: 0, missed: [] },
  };
  const ix = indexGraph(g as never);
  const links = classLinks(ix);
  const groups = groupClasses(ix, links).get('sim')!;
  assert.deepEqual(groups.map(x => x.classes.join()).sort(), ['A0,A1,A2,A3,A4,A5', 'B0,B1,B2,B3,B4,B5'], 'the clusters, apart');
  assert.ok(!groupClasses(ix, links).has('ui'), 'a small area keeps its classes');
  const rails = railClasses(ix, links);
  assert.deepEqual([...rails], ['State']);
  const t = makeTree(groupClasses(ix, links));
  const kinds = new Set<LinkKind>(['call']);
  const whole = canvasOf(ix, t, links, rails, { focus: [], expand: [], fold: [], show: [], hide: [], kinds });
  assert.deepEqual(whole.units.map(u => u.id).sort(), ['area:sim', 'area:ui'], 'with no focus, areas; the rail apart');
  assert.deepEqual(whole.rails.map(r => r.id), ['State']);
  assert.equal(whole.units.find(u => u.id === 'area:sim')!.taps.get('State')?.out, 12, 'a tap on the rail instead of a line');
  // Looking at A2: the classes beside it in its group, the other group, the area linking in; nothing else.
  const a2 = canvasOf(ix, t, links, rails, { focus: ['A2'], expand: [], fold: [], show: [], hide: [], kinds });
  const ids = new Set(a2.units.map(u => u.id));
  assert.equal(a2.units.find(u => u.id === 'A2')?.role, 'focus');
  assert.ok(ids.has('A0') && ids.has('A5'), 'its group\'s classes, one by one');
  assert.ok(!ids.has('B0') && !ids.has('area:ui') && !ids.has('Hud'), 'nothing two steps away');
  assert.deepEqual(a2.chips.map(c => c.area).sort(), ['sim', 'ui'], 'the rest as chips');
  assert.ok(a2.wires.every(w => w.from === 'A2' || w.to === 'A2'), 'lines touch the focus');
  assert.ok(a2.wires.some(w => w.from === 'A2' && w.fromPin === 'A2.f'), "a focus card's pins are its functions");
  // Looking at the A group: a frame of its classes; lines out of it leave from its edge.
  const ga = groups.find(x => x.classes.includes('A0'))!.id;
  const fa = canvasOf(ix, t, links, rails, { focus: [ga], expand: [], fold: [], show: [], hide: [], kinds });
  assert.equal(fa.units.find(u => u.id === ga)?.role, 'frame');
  assert.equal(fa.units.find(u => u.id === 'A0')?.parent, ga);
  const out = fa.wires.filter(w => w.from === ga || w.to === ga);
  assert.ok(out.some(w => w.from === ga && w.to.startsWith('group:')) && out.some(w => w.to === ga && w.from === 'area:ui'), JSON.stringify(out.map(w => [w.from, w.to])));
  assert.ok(fa.units.find(u => u.id === 'A0')!.outside > 0, 'the card inside counts what leaves');
  // Split the other group, fold it back, put an area away as a chip.
  const gb = groups.find(x => x.classes.includes('B0'))!.id;
  const split = canvasOf(ix, t, links, rails, { focus: ['A0'], expand: [gb], fold: [], show: [], hide: [], kinds });
  assert.ok(split.units.some(u => u.id === 'B0'), 'split into its classes');
  const folded = canvasOf(ix, t, links, rails, { focus: ['A0'], expand: [], fold: ['area:sim'], show: [], hide: [], kinds });
  assert.ok(folded.units.some(u => u.id === 'area:sim') && !folded.units.some(u => u.id === 'A1'), 'its group folded into the area');
  const hid = canvasOf(ix, t, links, rails, { focus: ['A1'], expand: [], fold: [], show: [], hide: ['area:ui'], kinds });
  assert.ok(!hid.units.some(u => u.id === 'area:ui') && hid.chips.some(c => c.area === 'ui'));
  const hidGroup = canvasOf(ix, t, links, rails, { focus: ['A0'], expand: [], fold: [], show: [], hide: [gb], kinds });
  assert.ok(!hidGroup.units.some(u => u.id === gb) && hidGroup.where.get('B0') === 'chip:sim', 'a group put away joins its area\'s chip');
  const back = canvasOf(ix, t, links, rails, { focus: ['A0'], expand: [], fold: [], show: ['area:sim'], hide: ['area:sim'], kinds });
  assert.ok(back.units.some(u => u.id === gb), 'drawn again from the chip');
  // Opened in place: a frame around its cards, lines to the card inside that makes them, nothing else changed.
  const opened = canvasOf(ix, t, links, rails, { focus: [], open: ['area:sim'], expand: [], fold: [], show: [], hide: [], kinds });
  assert.equal(opened.units.find(u => u.id === 'area:sim')?.role, 'open');
  assert.deepEqual(opened.units.filter(u => u.parent === 'area:sim').map(u => u.id).sort(), [ga, gb].sort());
  assert.ok(opened.wires.some(w => w.from === 'area:ui' && w.to === ga), 'from the other area straight to the group inside');
  assert.ok(opened.wires.some(w => (w.from === ga && w.to === gb) || (w.from === gb && w.to === ga)), 'between the cards inside');
  const hud = canvasOf(ix, t, links, rails, { focus: ['Hud'], open: ['area:sim'], expand: [], fold: [], show: [], hide: [], kinds });
  assert.deepEqual(hud.units.map(u => `${u.role}:${u.id}${u.parent ? '<' + u.parent : ''}`).sort(), ['focus:Hud', `near:${ga}<area:sim`, 'open:area:sim'].sort(), 'only what was there, opened');
  assert.ok(hud.wires.some(w => w.from === 'Hud' && w.to === ga));
  // Pinned inside, the rest folded: the pinned card stays, the others go on one card in the frame, their lines with them.
  const tucked = canvasOf(ix, t, links, rails, { focus: [], open: ['area:sim', ga], pins: ['A0'], tuck: ['area:sim', ga], expand: [], fold: [], show: [], hide: [], kinds });
  assert.deepEqual(tucked.units.filter(u => u.parent === ga).map(u => u.id).sort(), ['A0', `rest:${ga}`], 'the pin and the rest');
  assert.equal(tucked.units.find(u => u.id === `rest:${ga}`)?.classes.length, 5);
  assert.equal(tucked.where.get('B0'), `rest:area:sim`, 'a card holding no pin is folded too');
  assert.ok(tucked.units.some(u => u.id === ga && u.role === 'open'), 'a card holding the pin stays open');
  assert.ok(tucked.wires.some(w => w.from === 'A0' && w.to === `rest:${ga}`), 'lines reach the rest');
  // Too many lines to follow: they go to the card, but for the function kept.
  const merged = collapseWires(a2.wires, new Set(['A2']), () => false);
  assert.ok(merged.every(w => w.fromPin === '*' || w.from !== 'A2'));
});

test('edits marked on the code: added, changed with what each was, removed with where they sat', () => {
  const patch = ['@@ -1,6 +1,6 @@', ' a', '-b', '+B', '+new', ' c', '-gone1', '-gone2', ' d', '+tail'].join('\n');
  const m = marksOf(patch);
  assert.deepEqual([...m.line].sort((x, y) => x[0] - y[0]), [[2, { kind: 'chg', was: 'b' }], [3, { kind: 'add' }], [6, { kind: 'add' }]]);
  assert.deepEqual([...m.gone], [[5, ['gone1', 'gone2']]], 'removed lines sit before the line that follows them');
  const changedMore = marksOf(['@@ -3,3 +3,1 @@', '-x', '-y', '-z', '+X', ' w'].join('\n'));
  assert.deepEqual([...changedMore.line], [[3, { kind: 'chg', was: 'x' }]]);
  assert.deepEqual([...changedMore.gone], [[4, ['y', 'z']]], 'what is left over after pairing is removed');
  assert.equal(marksOf('diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+one\n+two').line.size, 2, 'headers before the first hunk are not lines');
});
