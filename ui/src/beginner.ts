import { createContext, useContext } from 'react';

/**
 * Beginner mode (settings.beginner): the human is new to coding, so the app explains its terms and
 * leads with what an approval does before the command itself. App provides it from the settings.
 */
export const BeginnerContext = createContext(false);
export const useBeginner = () => useContext(BeginnerContext);

export type Risk = 'low' | 'medium' | 'high';

/** What an approval would do, in plain words: the gist, how risky, and whether it can be undone. */
export interface Explained {
  summary: string;
  risk: Risk;
  undo: string;
}

const UNDO_GIT = 'Changes to files git tracks can be undone with git.';
const NO_UNDO = 'This can’t be undone easily.';

/** Programs and git subcommands, most specific first: [pattern, summary, risk, undo]. */
const COMMANDS: [RegExp, string, Risk, string][] = [
  [/^git\s+push\b/, 'Sends commits to the shared online repository', 'high', 'Others may see it at once; undoing it needs another push.'],
  [/^git\s+(reset\s+--hard|clean\b|checkout\s+--|restore\b)/, 'Throws away changes in the project that weren’t saved in a commit', 'high', NO_UNDO],
  [/^git\s+commit\b/, 'Saves the current changes as a snapshot (a commit)', 'low', 'A commit can be reverted later.'],
  [/^git\s+add\b/, 'Marks changed files to be saved in the next commit', 'low', 'Nothing is lost; it can be unmarked.'],
  [/^git\s+(merge|rebase|cherry-pick|pull)\b/, 'Combines work from another branch into this one', 'medium', 'Can be undone with git while nobody has built on it.'],
  [/^git\s+(switch|checkout|branch)\b/, 'Moves to or creates a line of work (a branch)', 'low', 'Nothing is lost.'],
  [/^git\s+stash\b/, 'Puts unsaved changes aside for later', 'low', 'They can be brought back with git stash pop.'],
  [/^git\b/, 'Runs a git command on the project’s history', 'medium', UNDO_GIT],
  [/^(rm|del|rmdir|Remove-Item|rd)\b/i, 'Deletes files or folders', 'high', 'Files git tracks can be restored; others are gone.'],
  [/^(mv|move|Move-Item|ren|rename)\b/i, 'Moves or renames files', 'medium', UNDO_GIT],
  [/^(cp|copy|Copy-Item|xcopy|robocopy)\b/i, 'Copies files', 'low', 'The copies can be deleted.'],
  [/^(mkdir|md|New-Item)\b/i, 'Creates a folder or file', 'low', 'It can be deleted.'],
  [/^(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b/, 'Installs code libraries the project uses', 'medium', 'Can be undone by removing them; it downloads code from the internet.'],
  [/^(pip|pip3|uv|poetry)\s+(install|add)\b/, 'Installs Python libraries', 'medium', 'Can be undone by uninstalling them; it downloads code from the internet.'],
  [/^(npm|pnpm|yarn|bun)\s+(test|run\s+test)\b|^(pytest|vitest|jest|go\s+test|cargo\s+test)\b|^node\s+--test\b/, 'Runs the project’s tests to check the code works', 'low', 'Tests only check; they don’t change your code.'],
  [/^(npm|pnpm|yarn|bun)\s+run\b/, 'Runs one of the project’s scripts', 'medium', UNDO_GIT],
  [/^(tsc|eslint|prettier|ruff|black|mypy)\b/, 'Checks or formats the code', 'low', UNDO_GIT],
  [/^(curl|wget|Invoke-WebRequest|iwr)\b/i, 'Downloads something from the internet', 'medium', 'Anything it saved can be deleted.'],
  [/^(node|python|python3|py|deno|bun|ruby|go\s+run|cargo\s+run)\b/, 'Runs a program', 'medium', UNDO_GIT],
  [/^(chmod|chown|icacls|sudo|runas)\b/i, 'Changes who can use files, or runs as another user', 'high', NO_UNDO],
];

/** Steps that only set up the ones after them. */
const SETUP = /^(cd|pushd|set|export|Set-Location)\b/i;

/** A script's commands, without steps that only set up (`cd …`, `export …`) or assign env vars. */
function commands(script: string): string[] {
  const parts = script.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean);
  const real = parts.filter(p => !SETUP.test(p)).map(p => p.replace(/^(\w+=\S*\s+)+/, ''));
  return real.length ? real : parts.slice(0, 1);
}

/**
 * An approval's text ("Bash: npm install", "Write: src/a.ts") in plain words. Errs towards
 * caution: anything it doesn't recognize is "medium" and says to read the command.
 */
export function explainApproval(text: string): Explained {
  const m = text.match(/^(\w[\w ]*?):\s*([\s\S]*)$/);
  const tool = m?.[1] ?? '';
  const detail = (m?.[2] ?? text).trim();
  if (/^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file|replace)$/i.test(tool)) {
    const file = detail.split('\n')[0].slice(0, 120);
    return { summary: `Changes a file: ${file}`, risk: 'low', undo: UNDO_GIT };
  }
  if (tool && !/^(Bash|shell|exec|run_shell_command|terminal|command)$/i.test(tool)) {
    return { summary: `Uses the ${tool} tool`, risk: 'medium', undo: 'Read the details below before you approve.' };
  }
  const [cmd = '', ...rest] = commands(detail);
  for (const [re, summary, risk, undo] of COMMANDS) {
    if (re.test(cmd)) return { summary: rest.length ? `${summary}, and more steps` : summary, risk, undo };
  }
  return { summary: 'Runs a command MetaHarness doesn’t recognize', risk: 'medium', undo: 'Read the command below, or ask the agent what it does.' };
}

/** One choice an agent offers: what the button says, and whether the agent recommends it. */
export interface Choice {
  label: string;
  recommended: boolean;
}

/**
 * The choices in a question or decision, when the agent listed them as the plain-language rule
 * asks: a line saying `Options:` followed by a numbered or bulleted list, the one it would pick
 * marked `(recommended)`. Fewer than two, or none: an empty list, and the card stays as it was.
 */
export function parseChoices(text: string): Choice[] {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^\s*(\*\*)?options:?(\*\*)?:?\s*$/i.test(l));
  if (start < 0) return [];
  const out: Choice[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/);
    if (!m) {
      if (out.length && line.trim()) break;
      continue;
    }
    const recommended = /\((recommended|my pick|suggested)\)/i.test(m[1]);
    const label = m[1].replace(/\s*\((recommended|my pick|suggested)\)\s*/i, ' ').replace(/\*\*/g, '').trim();
    if (label) out.push({ label, recommended });
  }
  return out.length >= 2 ? out : [];
}

/**
 * Plain explanations of the words the app uses, for beginner mode. Longer names first, so
 * "MCP servers" wins over "MCP" when a label is matched against them.
 */
export const GLOSSARY: [string, string][] = [
  ['prompt cache', 'The AI provider’s short-term memory of a conversation. Reusing it soon is much cheaper than starting over.'],
  ['plan limits', 'How much of your subscription you can use in a time window. When it runs out, agents wait or switch to a backup.'],
  ['shared folder', 'A folder every agent can read and write, where they leave documents for each other.'],
  ['mcp servers', 'Add-ons that give agents extra abilities, like reading a design tool or a database.'],
  ['mcp', 'A standard way to give AI tools extra abilities. MetaHarness uses it to give agents their team tools.'],
  ['harness', 'The AI coding tool an agent runs in, like Claude Code, Codex or Antigravity. Each uses your own subscription.'],
  ['model', 'The AI model doing the thinking. Bigger models are smarter, but slower and use more of your plan.'],
  ['effort', 'How hard the model thinks before it answers. Higher is slower and uses more of your plan.'],
  ['role', 'A kind of teammate (architect, implementer, reviewer): which AI tool and model it uses, and how it should work.'],
  ['lead', 'The agent in charge of a goal. It plans the work and brings in teammates.'],
  ['workflow', 'Step-by-step guidance for the lead on one kind of task, e.g. design first, then build.'],
  ['goal', 'One request you give the team, and everything the team does for it.'],
  ['spawn', 'When an agent brings in a teammate to do part of the work.'],
  ['worktree', 'A separate copy of the project for one agent, so its changes don’t clash with anyone else’s.'],
  ['branch', 'A separate line of changes in git, so work can be kept apart and combined later.'],
  ['commit', 'A saved snapshot of changes in git. Any commit can be looked at again or undone.'],
  ['gatekeeper', 'A small, cheap AI model that decides whether a command an agent wants to run is safe, and asks you about the rest.'],
  ['approvals', 'Before an agent runs something that could change things, someone says yes first: you, or the gatekeeper.'],
  ['backups', 'Other AI tools or models a role switches to when its own isn’t available or your plan’s limit is reached.'],
  ['skills', 'How-to guides an agent can read when it needs one.'],
  ['rules', 'Short notes MetaHarness gives agents at the right moment, like “check this doesn’t exist before you create it”.'],
  ['guidelines', 'House rules every agent gets: how to talk to each other, hand work over and ask for help.'],
  ['handoff', 'Notes that let a fresh session carry on exactly where another one stopped.'],
];

/**
 * The glossary entry a label is about: the term it names first, as a word (or a plural); of two
 * starting at the same place, the longer ("MCP servers" over "MCP").
 */
export function termIn(label: string): { term: string; meaning: string } | undefined {
  const l = label.toLowerCase();
  let best: { term: string; meaning: string; at: number } | undefined;
  for (const [term, meaning] of GLOSSARY) {
    // Terms are plain words and spaces, so they go into the pattern as they are.
    const m = new RegExp(`(^|[^a-z])(${term})s?(?=[^a-z]|$)`).exec(l);
    if (!m) continue;
    const at = m.index + m[1].length;
    if (!best || at < best.at || (at === best.at && term.length > best.term.length)) best = { term, meaning, at };
  }
  return best && { term: best.term, meaning: best.meaning };
}
