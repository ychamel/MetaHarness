/**
 * Is a shell command read-only? Used to approve such commands without asking the human, for
 * every harness (they all route approvals through the daemon). Errs towards "no": anything it
 * doesn't understand, or that could write, run other programs or change state, still asks.
 */

export interface Verdict {
  readOnly: boolean;
  /** Why not, for the event log. */
  reason?: string;
}

const no = (reason: string): Verdict => ({ readOnly: false, reason });
const YES: Verdict = { readOnly: true };

/** Programs that only read, whatever their arguments (output redirection is checked separately). */
const PLAIN = new Set([
  'cat', 'head', 'tail', 'wc', 'ls', 'tree', 'pwd', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'cut', 'tr',
  'diff', 'cmp', 'comm', 'file', 'stat', 'du', 'df', 'which', 'type', 'basename', 'dirname', 'realpath', 'readlink', 'date',
  'true', 'false', 'test', '[', '[[', 'nl', 'column', 'od', 'hexdump', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'printenv',
  'read', 'cd', 'sleep', 'jq', 'seq', 'rev', 'tac', 'fold', 'paste', 'join', 'strings', 'whoami', 'id', 'uname',
]);

/** Variables that change what later commands run. */
const DANGEROUS_VARS = /^(PATH|LD_\w+|DYLD_\w+|GIT_\w+|\w*PAGER|BASH_ENV|ENV|PROMPT_COMMAND|NODE_OPTIONS|PYTHON\w*)$/;

type Tok = { op: string } | { word: string };

/**
 * Where a $( … ) starting at `i` (pointing at "$(") ends, honouring quotes and nesting; -1 if
 * it doesn't.
 */
function closeParen(src: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "'") {
      j = src.indexOf("'", j + 1);
      if (j < 0) return -1;
    } else if (c === '\\') j++;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

/**
 * Splits a command line into words and operators. Returns a reason instead when it can't be
 * sure. A command substitution is fine when what it runs is read-only too (`inner` checks it).
 */
function lex(src: string, inner: (cmd: string) => Verdict): Tok[] | string {
  // $(( … )) is arithmetic, and $( … ) / ` … ` run a command: check it, then treat it as a word.
  const substitution = (j: number): { end: number } | string => {
    if (src[j] === '`') {
      const end = src.indexOf('`', j + 1);
      if (end < 0) return 'an unclosed backtick';
      const v = inner(src.slice(j + 1, end));
      return v.readOnly ? { end } : `a command substitution that isn't read-only (${v.reason})`;
    }
    if (src[j + 2] === '(') {
      const end = src.indexOf('))', j + 3);
      return end < 0 ? 'unclosed arithmetic' : { end: end + 1 };
    }
    const end = closeParen(src, j);
    if (end < 0) return 'an unclosed command substitution';
    const v = inner(src.slice(j + 2, end));
    return v.readOnly ? { end } : `a command substitution that isn't read-only (${v.reason})`;
  };
  const out: Tok[] = [];
  let word = '';
  let inWord = false;
  const push = () => {
    if (inWord) out.push({ word });
    word = '';
    inWord = false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return 'an unclosed quote';
      word += src.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\') j++;
        else if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '(')) {
          const sub = substitution(j);
          if (typeof sub === 'string') return sub;
          j = sub.end;
        }
      }
      if (j >= src.length) return 'an unclosed quote';
      word += src.slice(i + 1, j).replace(/\\(.)/g, '$1');
      inWord = true;
      i = j;
    } else if (c === '\\') {
      if (next === '\n') i++;
      else {
        word += next ?? '';
        inWord = true;
        i++;
      }
    } else if (c === '`' || (c === '$' && next === '(')) {
      const sub = substitution(i);
      if (typeof sub === 'string') return sub;
      word += src.slice(i, sub.end + 1);
      inWord = true;
      i = sub.end;
    } else if (c === '#' && !inWord) {
      // A comment runs to the end of the line.
      const nl = src.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1;
    } else if (c === '\n' || c === ';') {
      push();
      out.push({ op: ';' });
    } else if (c === '|' || c === '&') {
      push();
      if (next === c) {
        out.push({ op: c + c });
        i++;
      } else if (c === '&' && next === '>') return 'output redirection';
      else if (c === '&') return 'a background job';
      else out.push({ op: '|' });
    } else if (c === '>') {
      // Only throwing output away, or merging stderr into stdout, is harmless.
      const fd = inWord && /^\d$/.test(word) ? word : '';
      const rest = src.slice(i + 1);
      const m = /^(>?)\s*(\/dev\/null\b|&[12]\b)/.exec(rest);
      if (!m) return 'output redirection';
      if (fd) {
        word = '';
        inWord = false;
      } else push();
      i += m[0].length;
    } else if (c === '<') {
      if (next === '<') return 'a here-document';
      if (next === '(') return 'process substitution';
      // Input redirection reads a file; drop it and its target.
      push();
      let j = i + 1;
      while (src[j] === ' ') j++;
      const m = /^[^\s;|&<>]+/.exec(src.slice(j));
      if (!m) return 'input redirection without a file';
      i = j + m[0].length - 1;
    } else if (c === '(' || c === ')') {
      return 'a subshell';
    } else if (c === ' ' || c === '\t') {
      push();
    } else {
      word += c;
      inWord = true;
    }
  }
  push();
  return out;
}

export function readOnlyCommand(command: string, depth = 0): Verdict {
  if (depth > 3) return no('too deeply nested');
  const toks = lex(command, inner => readOnlyCommand(inner, depth + 1));
  if (typeof toks === 'string') return no(toks);
  const segments: string[][] = [[]];
  for (const t of toks) {
    if ('op' in t) segments.push([]);
    else segments.at(-1)!.push(t.word);
  }
  for (const seg of segments) {
    const v = simple(seg, depth);
    if (!v.readOnly) return v;
  }
  return YES;
}

/** One simple command, after shell keywords and harmless assignments are taken off. */
function simple(words: string[], depth: number): Verdict {
  let w = [...words];
  while (w.length && ['do', 'then', 'else', 'done', 'fi', '!', '{', '}', 'if', 'elif', 'while', 'until'].includes(w[0])) w.shift();
  if (!w.length) return YES;
  if (w[0] === 'for') return w[2] === 'in' || w.length === 2 ? YES : no('an unusual for loop');
  while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) {
    const name = w[0].slice(0, w[0].indexOf('='));
    if (DANGEROUS_VARS.test(name)) return no(`setting ${name}`);
    w = w.slice(1);
  }
  if (!w.length) return YES;
  let [cmd, ...args] = w;
  if (cmd.includes('/')) {
    // Only system binaries by full path; ./script could be anything.
    if (!/^\/(usr\/(local\/)?)?bin\/[\w.+-]+$/.test(cmd)) return no(`running ${cmd}`);
    cmd = cmd.slice(cmd.lastIndexOf('/') + 1);
  }
  const positional = args.filter(a => !a.startsWith('-'));

  if (PLAIN.has(cmd)) return YES;
  switch (cmd) {
    case 'sed': {
      if (args.some(a => /^-[a-zA-Z]*i|^--in-place/.test(a))) return no('sed -i edits files');
      // Scripts limited to printing line ranges or patterns, so no w, e or s///w.
      // The scripts: each -e argument, or else the first non-option argument.
      const scripts: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-e' || args[i] === '--expression') scripts.push(args[++i] ?? '');
        else if (args[i].startsWith('--expression=')) scripts.push(args[i].slice(13));
        else if (!args[i].startsWith('-') && !scripts.length) scripts.push(args[i]);
      }
      const addr = String.raw`(\d+|\$|\/[^/]*\/)`;
      const printOnly = new RegExp(String.raw`^\s*(${addr}(\s*,\s*(${addr}|[+~]\d+))?\s*p\s*;?\s*)+$`);
      return scripts.length && scripts.every(s => printOnly.test(s)) ? YES : no('a sed script that may write');
    }
    case 'awk':
    case 'gawk':
    case 'mawk':
      return args.some(a => /system|getline|[|>]|close|fflush/.test(a)) ? no('an awk program that may write or run commands') : YES;
    case 'find':
      return args.some(a => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a)) ? no('find that runs or deletes') : YES;
    case 'sort':
      return args.some(a => /^-o|^--output/.test(a)) ? no('sort -o writes a file') : YES;
    case 'uniq':
    case 'xxd':
      return positional.length > 1 ? no(`${cmd} with an output file`) : YES;
    case 'env':
      return args.length ? no('env running a command') : YES;
    case 'command':
      return args[0] === '-v' || args[0] === '-V' ? YES : no('command running a program');
    case 'xargs': {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += /^-[nILPdsE]$/.test(args[i]) ? 2 : 1;
      return args.length > i ? simple(args.slice(i), depth) : no('xargs without a command');
    }
    case 'bash':
    case 'sh':
    case 'zsh': {
      const c = args.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a));
      return c >= 0 && args.length === c + 2 ? readOnlyCommand(args[c + 1], depth + 1) : no(`running ${cmd}`);
    }
    case 'git':
      return gitReadOnly(args);
    default:
      return no(`${cmd} isn't known to be read-only`);
  }
}

const GIT_READ = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'describe', 'shortlog', 'cat-file',
  'merge-base', 'name-rev', 'for-each-ref', 'rev-list', 'whatchanged', 'show-ref', 'count-objects', 'check-ignore', 'diff-tree',
]);

function gitReadOnly(args: string[]): Verdict {
  let i = 0;
  // Only options that don't change behaviour; -c could install an alias or a pager.
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') i += 2;
    else if (args[i] === '--no-pager' || args[i] === '-P') i++;
    else return no(`git ${args[i]}`);
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return no('git without a subcommand');
  if (rest.some(a => /^--(output|ext-diff)/.test(a))) return no('git writing output or running an external diff');
  if (GIT_READ.has(sub)) return YES;
  const onlyFlags = (ok: RegExp) => rest.every(a => ok.test(a));
  switch (sub) {
    case 'branch':
      return onlyFlags(/^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--show-current|--contains|--merged|--no-merged|--sort=.*|--format=.*|mh\/.*|[\w./-]+)$/) &&
        !rest.some(a => /^-[dDmMcC]$|^--(delete|move|copy|set-upstream|unset-upstream|edit-description|track|force)/.test(a)) &&
        (rest.length === 0 || rest.some(a => a.startsWith('-')))
        ? YES
        : no('git branch that may create or change branches');
    case 'tag':
      return rest.length === 0 || rest[0] === '-l' || rest[0] === '--list' ? YES : no('git tag that may create tags');
    case 'remote':
      return rest.length === 0 || (rest.length === 1 && rest[0] === '-v') ? YES : no('git remote that may change remotes');
    case 'stash':
      return rest[0] === 'list' || rest[0] === 'show' ? YES : no('git stash that changes the stash');
    case 'worktree':
      return rest[0] === 'list' ? YES : no('git worktree that changes worktrees');
    case 'config':
      return rest.length > 0 && /^(--get|--get-all|--get-regexp|--list|-l)$/.test(rest[0]) ? YES : no('git config that may set a value');
    case 'reflog':
      return rest.length === 0 || rest[0] === 'show' ? YES : no('git reflog that may expire entries');
    default:
      return no(`git ${sub} isn't known to be read-only`);
  }
}
