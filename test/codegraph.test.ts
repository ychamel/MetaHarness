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
import { between, classLinks, indexGraph, stacksTo, stepsDown } from '../ui/src/codeData.ts';
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
