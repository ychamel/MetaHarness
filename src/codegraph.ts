import type { Node as TSNode } from 'web-tree-sitter';

/**
 * The Design view's Systems lens (design §14): how the code runs, not only which file imports
 * which. A code reader (named by a language pack's `code:`; GDScript for now) turns a file into
 * facts: its classes, what each extends, its members' types, its signals, and per function the
 * chains it evaluates as written (`w.grid.query(…)`, `Events.creature_died.emit(…)`), with the
 * types of its parameters and locals. buildGraph resolves the chains through the types the code
 * declares into one graph: functions calling functions, creating classes, emitting signals that
 * handlers listen to, and reading or writing other classes' state. The view walks it: from the
 * engine's entry points down, a function's calls as a tree, how a function is reached, and where
 * two systems meet.
 */

/* ---------------- facts: what a file says, unresolved ---------------- */

/** An argument, as far as the graph cares: a string, a name or chain, or a lambda. */
export interface Arg {
  s?: string;
  c?: Seg[];
  lam?: true;
}

/** One step of a chain: a name, a call of it (with its first arguments), or a subscript. */
export interface Seg {
  n: string;
  call?: true;
  sub?: true;
  args?: Arg[];
}

export interface VarFact {
  n: string;
  line: number;
  /** Its declared type, as written. */
  t?: string;
  /** Or the chain its value comes from (`:=`), `el` for a for-loop's element of it. */
  of?: Seg[];
  el?: true;
}

export interface FnFacts {
  name: string;
  line: number;
  end: number;
  static?: true;
  ret?: string;
  params: VarFact[];
  locals: VarFact[];
  chains: { segs: Seg[]; line: number; write?: true }[];
  /** Plain names it assigns (`x = …`, `x += …`): its own members, unless they're locals. */
  sets: string[];
  /** Its doc comment (`##` lines right above it). */
  doc?: string;
}

export interface ClassFacts {
  name?: string;
  /** For an inner class, the index of the class it's in. */
  outer?: number;
  ext?: string;
  extPath?: string;
  line: number;
  end: number;
  members: VarFact[];
  consts: VarFact[];
  signals: { n: string; line: number }[];
  fns: FnFacts[];
  /** Its doc comment: the `##` lines before its first member. */
  doc?: string;
}

/** A file's facts: its script class first, then any inner classes. */
export interface CodeFacts {
  classes: ClassFacts[];
}

/** The code readers, by the name a pack's `code:` gives. */
export const CODE_READERS: Record<string, (root: TSNode) => CodeFacts> = { gdscript: readGd };

const line = (n: TSNode) => n.startPosition.row + 1;
const unquote = (s: string) => s.replace(/^(&|\^)?("""|'''|"|')([\s\S]*)\2$/, '$3');

export function readGd(root: TSNode): CodeFacts {
  const top: ClassFacts = { line: 1, end: root.endPosition.row + 1, members: [], consts: [], signals: [], fns: [] };
  const classes = [top];
  gdClass(root, top, classes);
  return { classes };
}

function gdExtends(c: ClassFacts, n: TSNode): void {
  for (const k of n.namedChildren) {
    if (!k) continue;
    if (k.type === 'string') c.extPath = unquote(k.text);
    else if (k.type === 'type' || k.type === 'identifier' || k.type === 'attribute') c.ext = k.text.trim();
  }
}

function gdClass(body: TSNode, c: ClassFacts, out: ClassFacts[]): void {
  const fields: FnFacts = { name: '(fields)', line: 0, end: 0, params: [], locals: [], chains: [], sets: [] };
  // `##` lines right above a function or inner class document it; before the first member, the rest document the class.
  let doc: string[] = [];
  let docEnd = -1;
  let head: string[] | undefined = [];
  for (const n of body.namedChildren) {
    if (!n) continue;
    if (n.type === 'comment') {
      const t = n.text.match(/^##(?!#)\s?(.*)$/);
      if (!t) continue;
      if (n.startPosition.row !== docEnd + 1) (head?.push(...doc), (doc = []));
      doc.push(t[1].trim());
      docEnd = n.startPosition.row;
      continue;
    }
    const above = docEnd === n.startPosition.row - 1 ? doc.join('\n').trim() : '';
    if (head && n.type !== 'class_name_statement' && n.type !== 'extends_statement' && n.type !== 'annotation' && n.type !== 'annotations') {
      const own = n.type === 'function_definition' || n.type === 'constructor_definition' || n.type === 'class_definition' || (above && head.length);
      const all = [...head, ...(own ? [] : doc)].join('\n').trim();
      if (all) c.doc = all;
      head = undefined;
    }
    switch (n.type) {
      case 'class_name_statement': {
        c.name = n.childForFieldName('name')?.text;
        const ext = n.descendantsOfType('extends_statement')[0];
        if (ext) gdExtends(c, ext);
        break;
      }
      case 'extends_statement':
        gdExtends(c, n);
        break;
      case 'signal_statement': {
        const name = n.childForFieldName('name')?.text;
        if (name) c.signals.push({ n: name, line: line(n) });
        break;
      }
      case 'variable_statement':
      case 'const_statement': {
        const v = gdVar(n);
        if (!v) break;
        (n.type === 'const_statement' ? c.consts : c.members).push(v);
        // What a member's value does runs when the object is made: kept as its "(fields)".
        const value = n.childForFieldName('value');
        if (value && n.type === 'variable_statement') {
          if (!fields.line) fields.line = line(n);
          fields.end = n.endPosition.row + 1;
          gdBody(value, fields);
        }
        break;
      }
      case 'function_definition':
      case 'constructor_definition': {
        const f = gdFn(n);
        if (f && above) f.doc = above;
        if (f) c.fns.push(f);
        break;
      }
      case 'class_definition': {
        const name = n.childForFieldName('name')?.text;
        const inner: ClassFacts = { name, outer: out.indexOf(c), line: line(n), end: n.endPosition.row + 1, members: [], consts: [], signals: [], fns: [], ...(above ? { doc: above } : {}) };
        const ext = n.childForFieldName('extends');
        if (ext) gdExtends(inner, ext);
        out.push(inner);
        const b = n.childForFieldName('body');
        if (b) gdClass(b, inner, out);
        break;
      }
    }
    head?.push(...doc);
    doc = [];
    docEnd = -1;
  }
  if (fields.chains.length) c.fns.push(fields);
}

function gdVar(n: TSNode): VarFact | undefined {
  const name = n.childForFieldName('name')?.text;
  if (!name) return undefined;
  const v: VarFact = { n: name, line: line(n) };
  const type = n.childForFieldName('type');
  const value = n.childForFieldName('value');
  if (type?.type === 'type') v.t = type.text.trim();
  else if (value) {
    const ch = chainOf(value);
    if (ch) v.of = ch;
  }
  return v;
}

function gdFn(n: TSNode): FnFacts | undefined {
  const name = n.type === 'constructor_definition' ? '_init' : n.childForFieldName('name')?.text;
  if (!name) return undefined;
  const f: FnFacts = { name, line: line(n), end: n.endPosition.row + 1, params: [], locals: [], chains: [], sets: [] };
  if (n.children.some(k => k?.type === 'static_keyword')) f.static = true;
  const ret = n.childForFieldName('return_type');
  if (ret && ret.text.trim() !== 'void') f.ret = ret.text.trim();
  for (const p of n.childForFieldName('parameters')?.namedChildren ?? []) {
    if (!p) continue;
    const id = p.type === 'identifier' ? p : p.namedChildren.find(k => k?.type === 'identifier');
    if (!id) continue;
    const type = p.childForFieldName('type');
    const value = p.childForFieldName('value');
    const v: VarFact = { n: id.text, line: line(p) };
    if (type?.type === 'type') v.t = type.text.trim();
    else if (value) {
      const ch = chainOf(value);
      if (ch) v.of = ch;
    }
    f.params.push(v);
  }
  const body = n.childForFieldName('body');
  if (body) gdBody(body, f);
  return f;
}

/** Walks a function's body for its locals, the names it assigns, and every chain it evaluates. */
function gdBody(body: TSNode, f: FnFacts): void {
  const stack: TSNode[] = [body];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'variable_statement' || n.type === 'const_statement') {
      const v = gdVar(n);
      if (v) f.locals.push(v);
    } else if (n.type === 'for_statement') {
      const left = n.childForFieldName('left');
      const type = n.childForFieldName('type');
      const right = n.childForFieldName('right');
      if (left?.type === 'identifier') {
        const v: VarFact = { n: left.text, line: line(n) };
        if (type?.type === 'type') v.t = type.text.trim();
        else if (right) {
          const ch = chainOf(right);
          if (ch) (v.of = ch), (v.el = true);
        }
        f.locals.push(v);
      }
    } else if (n.type === 'assignment' || n.type === 'augmented_assignment') {
      const left = n.childForFieldName('left');
      if (left?.type === 'identifier') f.sets.push(left.text);
    }
    if ((n.type === 'attribute' || n.type === 'call') && n.parent?.type !== 'attribute') {
      const segs = chainOf(n);
      if (segs && segs.length > 1 ? true : !!segs?.[0]?.call) {
        const p = n.parent;
        const write = !!p && (p.type === 'assignment' || p.type === 'augmented_assignment') && p.childForFieldName('left')?.id === n.id;
        f.chains.push({ segs: segs!, line: line(n), ...(write ? { write: true as const } : {}) });
      }
    }
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const k = n.namedChild(i);
      if (k) stack.push(k);
    }
  }
}

function argsOf(n: TSNode | null): Arg[] | undefined {
  if (!n) return undefined;
  const out: Arg[] = [];
  for (const a of n.namedChildren.slice(0, 2)) {
    if (!a) continue;
    if (a.type === 'string') out.push({ s: unquote(a.text) });
    else if (a.type === 'lambda') out.push({ lam: true });
    else {
      const c = chainOf(a);
      out.push(c ? { c } : {});
    }
  }
  return out.length ? out : undefined;
}

/** A chain as written: `w.grid.query(p)` → w, grid, query(); undefined for anything else. */
export function chainOf(n: TSNode): Seg[] | undefined {
  switch (n.type) {
    case 'identifier':
      return [{ n: n.text }];
    case 'get_node':
      return [{ n: '$' }];
    case 'call': {
      const callee = n.namedChild(0);
      if (callee?.type !== 'identifier') return undefined;
      const args = argsOf(n.childForFieldName('arguments') ?? n.namedChild(1));
      return [{ n: callee.text, call: true, ...(args ? { args } : {}) }];
    }
    case 'subscript': {
      const head = n.namedChild(0);
      const c = head ? chainOf(head) : undefined;
      return c ? [...c, { n: '[]', sub: true }] : undefined;
    }
    case 'parenthesized_expression': {
      const k = n.namedChild(0);
      return k ? chainOf(k) : undefined;
    }
    case 'attribute': {
      const kids = n.namedChildren.filter((k): k is TSNode => !!k);
      const head = kids[0] ? chainOf(kids[0]) : undefined;
      if (!head) return undefined;
      const segs = [...head];
      for (const k of kids.slice(1)) {
        if (k.type === 'identifier') segs.push({ n: k.text });
        else if (k.type === 'attribute_call') {
          const id = k.namedChild(0);
          if (!id) break;
          const args = argsOf(k.childForFieldName('arguments') ?? k.namedChild(1));
          segs.push({ n: id.text, call: true, ...(args ? { args } : {}) });
        } else if (k.type === 'attribute_subscript') {
          const id = k.namedChild(0);
          if (!id) break;
          segs.push({ n: id.text }, { n: '[]', sub: true });
        } else break;
      }
      return segs;
    }
  }
  return undefined;
}

/* ---------------- the graph ---------------- */

export type EdgeKind = 'call' | 'new' | 'emit' | 'listen' | 'read' | 'write';

export interface GraphClass {
  id: string;
  name: string;
  file: string;
  area: string;
  line: number;
  end: number;
  kind: 'class' | 'autoload' | 'script' | 'inner';
  /** The project class it extends. */
  ext?: string;
  /** The engine class at the bottom of what it extends (Node2D, RefCounted…). */
  base?: string;
  /** The main scene's script. */
  main?: true;
  /** Its doc comment. */
  doc?: string;
}

export interface GraphFn {
  id: string;
  cls: string;
  name: string;
  file: string;
  line: number;
  end: number;
  static?: true;
  /** Called by the engine: _ready, _process and the like. */
  engine?: true;
  /** Changes its own object's state, itself or through its own methods. */
  mut?: true;
  doc?: string;
}

export interface GraphSignal {
  id: string;
  cls: string;
  name: string;
  line: number;
}

export interface GraphField {
  id: string;
  cls: string;
  name: string;
  line: number;
  const?: true;
}

/**
 * f → t. call: function → function; new: function → class; emit: function → signal;
 * listen: signal → the function that handles it, connected in `via`; read/write: function → field.
 * `l` is the line in the file of f (of `via`, for listen); `n` how many times; `g` a guess, by a
 * method name only one class defines, where the receiver's type isn't declared.
 */
export interface GraphEdge {
  f: string;
  t: string;
  k: EdgeKind;
  l: number;
  n?: number;
  via?: string;
  g?: true;
  lam?: true;
}

export interface CodeStats {
  files: number;
  calls: number;
  resolved: number;
  guessed: number;
  /** Calls of a project method whose receiver's type couldn't be found. */
  unresolved: number;
  /** The receivers missed most, as written (`c.genome`), with how often: what to type to follow more. */
  missed: { chain: string; n: number }[];
}

export interface CodeGraph {
  version: number;
  classes: GraphClass[];
  fns: GraphFn[];
  signals: GraphSignal[];
  fields: GraphField[];
  edges: GraphEdge[];
  /** Functions the engine calls, the main scene's and the autoloads' first. */
  entries: string[];
  stats: CodeStats;
  /** Groups of classes the map's Systems section names, with what each does. */
  systems?: CodeSystem[];
}

export interface CodeSystem {
  name: string;
  classes: string[];
  text: string;
}

export const CODE_VERSION = 2;

/** Engine callbacks: where the engine calls into a script. */
export const ENGINE_CALLBACKS = new Set(['_ready', '_process', '_physics_process', '_input', '_unhandled_input', '_unhandled_key_input', '_shortcut_input', '_gui_input', '_draw', '_notification', '_enter_tree', '_exit_tree', '_init', '_integrate_forces']);

/** Engine methods common enough that a call of one is never guessed to be a project method of that name. */
const ENGINE_NAMES = new Set(
  'add_child remove_child queue_free free get_node get_parent get_tree get_children get_child connect disconnect emit emit_signal call call_deferred set get has size append push_back push_front pop_back pop_front erase clear duplicate keys values is_empty find has_method is_connected set_process set_physics_process queue_redraw show hide play stop start update setup reset init clamp min max abs lerp distance_to length normalized round floor ceil format join split begins_with ends_with to_lower to_upper substr is_instance_valid instance_from_id new instantiate add remove insert sort sort_custom filter map reduce any all count rand randf randi randf_range randi_range seed get_value set_value save load open close resize fill slice back front pick_random shuffle merge is_valid apply tick step draw refresh build compute rebuild query'.split(' '),
);

interface ClassInfo {
  id: string;
  facts: ClassFacts;
  file: string;
  area: string;
  kind: GraphClass['kind'];
  outer?: ClassInfo;
  base?: ClassInfo;
  baseName?: string;
  members: Map<string, VarFact>;
  consts: Map<string, VarFact>;
  methods: Map<string, FnFacts>;
  signals: Set<string>;
  inner: Map<string, ClassInfo>;
}

/** What a chain evaluates to: a project object or class, an array of them, a signal, a scene, or something of the engine's (`ext`). */
type T = { k: 'inst' | 'cls' | 'arr'; c: ClassInfo } | { k: 'sig'; c: ClassInfo; s: string } | { k: 'scene'; path: string } | { k: 'ext' } | undefined;

export interface CodeInput {
  path: string;
  area: string;
  facts: CodeFacts;
}

export interface GodotProject {
  /** Autoload names to the files they run. */
  autoloads: Map<string, string>;
  /** The main scene's root script. */
  mainScript?: string;
  /** The folder of project.godot, where res:// starts. */
  resRoot: string;
  /** Each scene's root script, by the scene's path. */
  sceneScripts?: Map<string, string>;
}

const stem = (p: string) => p.split('/').pop()!.replace(/\.[^.]*$/, '');
const pascal = (s: string) => s.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());

/** Resolves the files' facts into one graph. */
export function buildGraph(inputs: CodeInput[], project: GodotProject): CodeGraph {
  const resPath = (p: string) => (p.startsWith('res://') ? (project.resRoot === '.' ? '' : project.resRoot + '/') + p.slice(6) : p);
  const autoloadOf = new Map([...project.autoloads].map(([n, p]) => [resPath(p), n]));
  const infos: ClassInfo[] = [];
  const byPath = new Map<string, ClassInfo>();
  const global = new Map<string, { c: ClassInfo; inst: boolean }>();
  const taken = new Set<string>();
  for (const inp of inputs) {
    const made: ClassInfo[] = [];
    for (const cf of inp.facts.classes) {
      const outer = cf.outer !== undefined ? made[cf.outer] : undefined;
      let id: string;
      let kind: GraphClass['kind'];
      if (outer) (id = `${outer.id}.${cf.name ?? '?'}`), (kind = 'inner');
      else if (cf.name) (id = cf.name), (kind = 'class');
      else if (autoloadOf.has(inp.path)) (id = autoloadOf.get(inp.path)!), (kind = 'autoload');
      else (id = pascal(stem(inp.path))), (kind = 'script');
      if (!outer && autoloadOf.has(inp.path)) kind = 'autoload';
      while (taken.has(id)) id = `${id}'`;
      taken.add(id);
      const ci: ClassInfo = {
        id, facts: cf, file: inp.path, area: inp.area, kind, ...(outer ? { outer } : {}),
        members: new Map(cf.members.map(v => [v.n, v])), consts: new Map(cf.consts.map(v => [v.n, v])),
        methods: new Map(cf.fns.map(f => [f.name, f])), signals: new Set(cf.signals.map(s => s.n)), inner: new Map(),
      };
      if (outer && cf.name) outer.inner.set(cf.name, ci);
      made.push(ci);
      infos.push(ci);
    }
    const top = made[0];
    if (!top) continue;
    byPath.set(inp.path, top);
    if (top.facts.name && !global.has(top.facts.name)) global.set(top.facts.name, { c: top, inst: false });
  }
  for (const [name, p] of project.autoloads) {
    const c = byPath.get(resPath(p));
    if (c) global.set(name, { c, inst: true });
  }
  const typeName = (name: string, from?: ClassInfo): ClassInfo | undefined => {
    const [first, ...rest] = name.split('.');
    let c: ClassInfo | undefined;
    for (let s = from; s && !c; s = s.outer) c = s.inner.get(first);
    c ??= global.get(first)?.c;
    for (const r of rest) c = c?.inner.get(r);
    return c;
  };
  for (const ci of infos) {
    const f = ci.facts;
    if (f.extPath) {
      const p = resPath(f.extPath);
      ci.base = byPath.get(p) ?? byPath.get(p.replace(/^\.\//, ''));
    } else if (f.ext) {
      ci.base = typeName(f.ext, ci.outer);
      if (!ci.base) ci.baseName = f.ext;
    }
    if (ci.base === ci) delete ci.base;
  }
  const engineBase = (c: ClassInfo): string | undefined => {
    const seen = new Set<ClassInfo>();
    for (let x: ClassInfo | undefined = c; x && !seen.has(x); x = x.base) {
      seen.add(x);
      if (!x.base) return x.baseName ?? (x.facts.ext ? undefined : 'RefCounted');
    }
    return undefined;
  };
  const up = function* (c: ClassInfo) {
    const seen = new Set<ClassInfo>();
    for (let x: ClassInfo | undefined = c; x && !seen.has(x); x = x.base) yield (seen.add(x), x);
  };
  const findMethod = (c: ClassInfo, n: string) => {
    for (const x of up(c)) if (x.methods.has(n)) return { c: x, f: x.methods.get(n)! };
    return undefined;
  };
  const findVar = (c: ClassInfo, n: string) => {
    for (const x of up(c)) {
      const v = x.members.get(n) ?? x.consts.get(n);
      if (v) return { c: x, v, isConst: !x.members.has(n) };
    }
    return undefined;
  };
  const hasSignal = (c: ClassInfo, n: string) => {
    for (const x of up(c)) if (x.signals.has(n)) return x;
    return undefined;
  };
  const methodOwners = new Map<string, ClassInfo[]>();
  for (const ci of infos) for (const f of ci.facts.fns) if (f.name !== '(fields)') methodOwners.set(f.name, [...(methodOwners.get(f.name) ?? []), ci]);

  const fnId = (c: ClassInfo, f: FnFacts) => `${c.id}.${f.name}`;
  const edges = new Map<string, GraphEdge>();
  const fields = new Map<string, GraphField>();
  const stats: CodeStats = { files: inputs.length, calls: 0, resolved: 0, guessed: 0, unresolved: 0, missed: [] };
  const missed = new Map<string, number>();
  const mut = new Set<string>();
  const add = (e: GraphEdge) => {
    const k = `${e.k}\n${e.f}\n${e.t}`;
    const o = edges.get(k);
    if (o) o.n = (o.n ?? 1) + 1;
    else edges.set(k, e);
  };
  const fieldId = (c: ClassInfo, n: string, v: VarFact, isConst: boolean) => {
    const id = `${c.id}.${n}`;
    if (!fields.has(id)) fields.set(id, { id, cls: c.id, name: n, line: v.line, ...(isConst ? { const: true as const } : {}) });
    return id;
  };

  interface Ctx {
    c: ClassInfo;
    f: FnFacts;
    id: string;
    vars: Map<string, VarFact>;
    memo: Map<string, T>;
    busy: Set<string>;
  }
  const classCtx = new Map<ClassInfo, Ctx>();
  const ctxOf = (c: ClassInfo, f: FnFacts): Ctx => ({ c, f, id: fnId(c, f), vars: new Map([...f.params, ...f.locals].map(v => [v.n, v])), memo: new Map(), busy: new Set() });
  const fieldCtx = (c: ClassInfo) => {
    let x = classCtx.get(c);
    if (!x) classCtx.set(c, (x = ctxOf(c, { name: '(fields)', line: c.facts.line, end: c.facts.line, params: [], locals: [], chains: [], sets: [] })));
    return x;
  };
  const ofType = (text: string | undefined, c: ClassInfo): T => {
    if (!text) return undefined;
    const t = text.replace(/\s+/g, '');
    const arr = /^Array\[(.+)\]$/.exec(t) ?? /^Dictionary\[[^,]+,(.+)\]$/.exec(t);
    if (arr) {
      const e = typeName(arr[1], c);
      return e ? { k: 'arr', c: e } : undefined;
    }
    const x = typeName(t, c);
    return x ? { k: 'inst', c: x } : /^[A-Z]\w*(\[.*\])?$|^(int|float|bool)$/.test(t) ? { k: 'ext' } : undefined;
  };
  const varType = (ctx: Ctx, v: VarFact, owner: ClassInfo): T => {
    const key = `${owner.id}\n${v.n}\n${v.line}`;
    if (ctx.memo.has(key)) return ctx.memo.get(key);
    if (ctx.busy.has(key)) return undefined;
    ctx.busy.add(key);
    let t: T = v.t ? ofType(v.t, owner) : v.of ? walk(owner === ctx.c ? ctx : fieldCtx(owner), v.of, false) : undefined;
    if (v.el) t = t?.k === 'arr' ? { k: 'inst', c: t.c } : undefined;
    ctx.busy.delete(key);
    ctx.memo.set(key, t);
    return t;
  };
  const retType = (c: ClassInfo, f: FnFacts): T => (f.ret ? ofType(f.ret, c) : undefined);

  /** A connected handler: a method of this class (bound or not), a method of another object, or a lambda. */
  const handler = (ctx: Ctx, a: Arg | undefined): { id: string; lam?: true } | undefined => {
    if (!a) return undefined;
    if (a.lam) return { id: ctx.id, lam: true };
    const c = a.c;
    if (!c?.length) return undefined;
    let i = c.length;
    while (i > 1 && c[i - 1].call && (c[i - 1].n === 'bind' || c[i - 1].n === 'unbind')) i--;
    const segs = c.slice(0, i);
    if (segs.length === 1 && !segs[0].call && !ctx.vars.has(segs[0].n)) {
      const m = findMethod(ctx.c, segs[0].n);
      return m ? { id: fnId(m.c, m.f) } : undefined;
    }
    const last = segs.at(-1)!;
    if (last.call) return undefined;
    const recv = walk(ctx, segs.slice(0, -1), false);
    if (recv && (recv.k === 'inst' || recv.k === 'cls')) {
      const m = findMethod(recv.c, last.n);
      if (m) return { id: fnId(m.c, m.f) };
    }
    return undefined;
  };

  const signalId = (c: ClassInfo, s: string) => `${c.id}.${s}`;
  const signals = new Map<string, GraphSignal>();
  for (const ci of infos) for (const s of ci.facts.signals) signals.set(signalId(ci, s.n), { id: signalId(ci, s.n), cls: ci.id, name: s.n, line: s.line });

  const emitTo = (ctx: Ctx, c: ClassInfo, s: string, l: number) => {
    const owner = hasSignal(c, s);
    if (!owner) return false;
    add({ f: ctx.id, t: signalId(owner, s), k: 'emit', l });
    return true;
  };
  const listenTo = (ctx: Ctx, c: ClassInfo, s: string, a: Arg | undefined, l: number) => {
    const owner = hasSignal(c, s);
    const h = owner ? handler(ctx, a) : undefined;
    if (!owner || !h) return false;
    add({ f: signalId(owner, s), t: h.id, k: 'listen', l, via: ctx.id, ...(h.lam ? { lam: true as const } : {}) });
    return true;
  };

  /** Evaluates a chain to its type, recording what it calls, creates, emits, connects and touches when `rec`. */
  function walk(ctx: Ctx, segs: Seg[], rec: boolean, l = 0, write = false): T {
    const own = ctx.c;
    const callOf = (c: ClassInfo, n: string, guess = false): T => {
      const m = findMethod(c, n);
      if (!m) return undefined;
      if (rec) {
        add({ f: ctx.id, t: fnId(m.c, m.f), k: 'call', l, ...(guess ? { g: true as const } : {}) });
        if (guess) stats.guessed++;
        else stats.resolved++;
      }
      return retType(m.c, m.f);
    };
    const s0 = segs[0];
    let t: T;
    if (s0.call) {
      if (rec) stats.calls++;
      const a0 = s0.args?.[0];
      if ((s0.n === 'preload' || s0.n === 'load') && a0?.s) {
        const p = resPath(a0.s);
        const c = byPath.get(p);
        if (rec) stats.calls--;
        t = c ? { k: 'cls', c } : p.endsWith('.tscn') ? { k: 'scene', path: p } : undefined;
      } else if (s0.n === 'emit_signal' && a0?.s) {
        if (rec) emitTo(ctx, own, a0.s, l) ? stats.resolved++ : stats.calls--;
      } else if (s0.n === 'connect' && a0?.s) {
        if (rec) listenTo(ctx, own, a0.s, s0.args?.[1], l) ? stats.resolved++ : stats.calls--;
      } else if (ctx.vars.has(s0.n)) {
        // A Callable held in a variable.
        if (rec) stats.calls--;
      } else {
        t = callOf(own, s0.n);
        if (!t && !findMethod(own, s0.n) && rec) stats.calls--;
      }
    } else if (s0.n === 'self') t = { k: 'inst', c: own };
    else if (s0.n === 'super') t = own.base ? { k: 'inst', c: own.base } : undefined;
    else if (s0.n === '$') t = undefined;
    else if (ctx.vars.has(s0.n)) t = varType(ctx, ctx.vars.get(s0.n)!, own);
    else {
      const v = findVar(own, s0.n);
      const sig = !v && hasSignal(own, s0.n);
      if (v) {
        t = varType(ctx, v.v, v.c);
        if (segs.length === 1 && write && rec) mut.add(ctx.id);
      } else if (sig) t = { k: 'sig', c: sig, s: s0.n };
      else {
        let inner: ClassInfo | undefined;
        for (let x: ClassInfo | undefined = own; x && !inner; x = x.outer) inner = x.inner.get(s0.n);
        const g = global.get(s0.n);
        if (inner) t = { k: 'cls', c: inner };
        else if (g) t = { k: g.inst ? 'inst' : 'cls', c: g.c };
      }
    }
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i];
      const last = i === segs.length - 1;
      if (s.sub) {
        t = t?.k === 'arr' ? { k: 'inst', c: t.c } : undefined;
        continue;
      }
      if (s.call && rec) stats.calls++;
      if (!t) {
        if (!s.call) return undefined;
        const owners = methodOwners.get(s.n);
        if (owners?.length === 1 && !ENGINE_NAMES.has(s.n) && !s.n.startsWith('_')) {
          t = callOf(owners[0], s.n, true);
          continue;
        }
        if (rec && owners?.length && !ENGINE_NAMES.has(s.n)) {
          stats.unresolved++;
          const k = `${ctx.c.id}: ${segs.slice(0, i).map(x => x.n + (x.call ? '()' : '')).join('.').replace(/\.\[\]/g, '[]')}.${s.n}()`;
          missed.set(k, (missed.get(k) ?? 0) + 1);
        } else if (rec) stats.calls--;
        return undefined;
      }
      if (t.k === 'scene') {
        if (s.call && rec) stats.calls--;
        if (s.call && s.n === 'instantiate') {
          const script = project.sceneScripts?.get(t.path);
          const c = script ? byPath.get(script) : undefined;
          if (c && rec) add({ f: ctx.id, t: c.id, k: 'new', l });
          t = c ? { k: 'inst', c } : undefined;
          continue;
        }
        return undefined;
      }
      if (t.k === 'sig') {
        if (!s.call) return undefined;
        if (rec) {
          const ok = s.n === 'emit' ? emitTo(ctx, t.c, t.s, l) : s.n === 'connect' ? listenTo(ctx, t.c, t.s, s.args?.[0], l) : false;
          if (ok) stats.resolved++;
          else stats.calls--;
        }
        return undefined;
      }
      if (t.k === 'arr' || t.k === 'ext') {
        if (s.call && rec) stats.calls--;
        return undefined;
      }
      const c = t.c;
      if (s.call) {
        if (s.n === 'new' && t.k === 'cls') {
          if (rec) (add({ f: ctx.id, t: c.id, k: 'new', l }), stats.resolved++);
          t = { k: 'inst', c };
          continue;
        }
        const a0 = s.args?.[0];
        if (s.n === 'emit_signal' && a0?.s) {
          if (rec) emitTo(ctx, c, a0.s, l) ? stats.resolved++ : stats.calls--;
          return undefined;
        }
        if (s.n === 'connect' && a0?.s) {
          if (rec) listenTo(ctx, c, a0.s, s.args?.[1], l) ? stats.resolved++ : stats.calls--;
          return undefined;
        }
        if (!findMethod(c, s.n)) {
          if (rec) stats.calls--;
          return undefined;
        }
        t = callOf(c, s.n);
        continue;
      }
      const sig = hasSignal(c, s.n);
      if (sig && !findVar(c, s.n)) {
        t = { k: 'sig', c: sig, s: s.n };
        continue;
      }
      const v = findVar(c, s.n);
      if (v) {
        const mine = [...up(own)].includes(v.c);
        if (rec && !mine) add({ f: ctx.id, t: fieldId(v.c, s.n, v.v, v.isConst), k: last && write ? 'write' : 'read', l });
        if (rec && mine && last && write) mut.add(ctx.id);
        t = varType(ctx, v.v, v.c);
        continue;
      }
      const inner = c.inner.get(s.n);
      t = inner ? { k: 'cls', c: inner } : undefined;
    }
    return t;
  }

  const fns: GraphFn[] = [];
  const mainClass = project.mainScript ? byPath.get(project.mainScript) : undefined;
  for (const ci of infos) {
    for (const f of ci.facts.fns) {
      const ctx = ctxOf(ci, f);
      for (const ch of f.chains) walk(ctx, ch.segs, true, ch.line, !!ch.write);
      for (const n of f.sets) if (!ctx.vars.has(n) && findVar(ci, n)) mut.add(ctx.id);
      fns.push({
        id: ctx.id, cls: ci.id, name: f.name, file: ci.file, line: f.line, end: f.end,
        ...(f.static ? { static: true as const } : {}), ...(ENGINE_CALLBACKS.has(f.name) ? { engine: true as const } : {}), ...(f.doc ? { doc: f.doc } : {}),
      });
    }
  }
  // A method changes its object when it, or a method of the same object it calls, assigns a member.
  const fnCls = new Map(fns.map(f => [f.id, f.cls]));
  const own = [...edges.values()].filter(e => e.k === 'call' && fnCls.get(e.f) === fnCls.get(e.t));
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of own) if (mut.has(e.t) && !mut.has(e.f)) (mut.add(e.f), (grew = true));
  }
  for (const f of fns) if (mut.has(f.id)) f.mut = true;
  stats.missed = [...missed].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([chain, n]) => ({ chain, n }));
  const classes: GraphClass[] = infos.map(ci => {
    const base = engineBase(ci);
    return {
      id: ci.id, name: ci.facts.name ?? ci.id, file: ci.file, area: ci.area, line: ci.facts.line, end: ci.facts.end, kind: ci.kind,
      ...(ci.base ? { ext: ci.base.id } : {}), ...(base ? { base } : {}), ...(ci === mainClass ? { main: true as const } : {}), ...(ci.facts.doc ? { doc: ci.facts.doc } : {}),
    };
  });
  const rank = (f: GraphFn) => (mainClass && f.cls === mainClass.id ? 0 : infos.find(i => i.id === f.cls)?.kind === 'autoload' ? 1 : 2);
  const entries = fns.filter(f => f.engine && f.name !== '_init').sort((a, b) => rank(a) - rank(b)).map(f => f.id);
  return { version: CODE_VERSION, classes, fns, signals: [...signals.values()], fields: [...fields.values()], edges: [...edges.values()], entries, stats };
}

/* ---------------- a Godot project's settings ---------------- */

/** Autoloads and the main scene from project.godot; `scene` reads a scene's text, for its root script. */
export function godotProject(projectFile: string | undefined, projectPath: string | undefined, scene: (path: string) => string | undefined, scenes: string[] = []): GodotProject {
  const resRoot = projectPath ? (projectPath.includes('/') ? projectPath.slice(0, projectPath.lastIndexOf('/')) : '.') : '.';
  const res = (p: string) => (p.startsWith('res://') ? (resRoot === '.' ? '' : resRoot + '/') + p.slice(6) : p);
  const autoloads = new Map<string, string>();
  let main: string | undefined;
  let section = '';
  for (const raw of (projectFile ?? '').split('\n')) {
    const l = raw.trim();
    const sec = /^\[(\w+)\]$/.exec(l);
    if (sec) {
      section = sec[1];
      continue;
    }
    const kv = /^([\w/.]+)\s*=\s*"\*?([^"]*)"/.exec(l);
    if (!kv) continue;
    if (section === 'autoload' && kv[2].endsWith('.gd')) autoloads.set(kv[1], kv[2]);
    if (section === 'application' && kv[1] === 'run/main_scene') main = res(kv[2]);
  }
  const sceneScripts = new Map<string, string>();
  for (const s of new Set([...scenes, ...(main ? [main] : [])])) {
    const script = rootScript(scene(s));
    if (script) sceneScripts.set(s, res(script));
  }
  return { autoloads, resRoot, sceneScripts, ...(main && sceneScripts.has(main) ? { mainScript: sceneScripts.get(main)! } : {}) };
}

/** The res:// path of a scene's root node's script. */
export function rootScript(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const ids = new Map<string, string>();
  for (const m of text.matchAll(/^\[ext_resource\b([^\]]*)\]/gm)) {
    const id = /\bid="([^"]+)"/.exec(m[1])?.[1];
    const path = /\bpath="([^"]+)"/.exec(m[1])?.[1];
    if (id && path) ids.set(id, path);
  }
  const root = /^\[node\b(?![^\]]*\bparent=)[^\]]*\]\n((?:(?!\[)[^\n]*\n?)*)/m.exec(text);
  const id = root && /^script\s*=\s*ExtResource\(\s*"([^"]+)"\s*\)/m.exec(root[1])?.[1];
  return id ? ids.get(id) : undefined;
}
