# MetaHarness

Run a team of AI agents from different providers, each in its own native harness (Claude Code,
Codex, Antigravity CLI), on one goal. Agents spawn and message each other through a small set of
tools, hand work over through a shared folder, and everything they do is logged so you can follow
and steer it.

New here? [GUIDE.md](GUIDE.md) takes you from install to a first goal. The design is in
[DESIGN.md](DESIGN.md).

## Status

Milestone 0: the core runs real teams. Agents reach their tools over MCP, messages reach running
turns, and permission requests land in your Inbox. Scripted agents (`--fake`) are there for
development.

Milestone 1 in progress:
- **ACP harnesses** (OpenCode built in; Gemini CLI, Goose, Qwen Code and others as a profile
  file) run through one adapter. Messages reach a busy agent mid-turn on every harness: natively,
  through a hook or a command's output, or by pausing the turn between steps, never mid-command.
- **Claude Code, Codex and Antigravity CLI** all run, and each passes every `mh test` check:
  mid-turn messages (native, or through a hook for Antigravity), urgent interrupts, resume,
  usage and rate limits.
- Roles can name backups. When a subscription nears its limit, agents are asked to write notes;
  at the limit they wait for a close reset or move to a backup, continuing from a handoff.
- **Workflows** guide the lead through a kind of task (`feature`, `feature-explore`,
  `implementation`), hand on to each other, and stop for your approval where they say so.
  **Specialist roles** can bring their own MCP servers (`mcp: blender`) and workflow.
- The team works **in your checkout**, like native subagents; worktrees (on `mh/<goal>/<agent>`)
  are only for code written in parallel, when a workflow asks for them. They get hard-linked
  copies of your ignored `node_modules`/`vendor`, merge conflicts show up in `mh tail`, and
  MetaHarness removes them and their merged branches when the goal ends.
- **Agents only add history:** git hooks (for agents only) refuse deleting branches, rewinding
  shared ones, and pushing. Agents commit; you push.
- The **shared folder** keeps every version of every file in `shared/.history/`, and agents are
  told when a teammate changes a file (and when someone edits a document that isn't theirs).

See [TRACKER.md](TRACKER.md).

## Try it

Needs Node 24 or newer (it runs the TypeScript sources directly), and at least one of Claude
Code, Codex or Antigravity CLI, signed in.

```sh
npm install                    # the MCP SDK; TypeScript, React and Vite for the web app
npm run ui:build               # build the web app the daemon serves (ui/dist)
node src/cli.ts doctor         # which harnesses are here, signed in, with which models; can each role run?
node src/cli.ts daemon         # terminal 1 (add --fake for scripted agents, no model calls).
                               # Restarted, it picks up the goals left running (--no-resume: don't)
node src/cli.ts test codex     # optional: check what works with a harness, on a cheap model

node src/cli.ts run "Add per-user rate limiting to /api/upload" --workflow feature   # terminal 2
node src/cli.ts tail           # follow everything live
node src/cli.ts status         # who's doing what
node src/cli.ts send implementer-1 "Did you add tests?"
node src/cli.ts approve <id>   # answer a permission request or a decision listed by status
node src/cli.ts pause impl-1   # stop after its current step; mh resume impl-1 lets it go on
node src/cli.ts ui             # the web app: goals, what needs you, the team's story, files, setup
node src/cli.ts clean <goal> --force   # remove worktrees or branches kept for unsaved work
```

Run the daemon from the repository the agents should work on: it reads roles from that
repository's `.metaharness/` folder. Codex reports tokens but not cost; to see cost, add
`.metaharness/prices.json` mapping each model to its USD price per million tokens:
`{"<model>": {"input": …, "cachedInput": …, "output": …}}`.

A role names its harness and model, and can name backups for when that model is unavailable or
its subscription is at its limit:

```markdown
---
harness: claude-code
model: opus
fallback: antigravity/claude-opus-5-5-high, codex/gpt-6-sol
---
```

A specialist role names the MCP servers it needs (`mcp: blender, figma`). Each name is looked up
on the machine: in `~/.metaharness/mcp.json` (`{"mcpServers": {...}}`, the format every harness
uses), else among the servers the role's harness already has. `mh doctor` lists names that
don't resolve.

Another harness on a transport MetaHarness already speaks is a profile, not code:
`.metaharness/harnesses/<id>.md` (see DESIGN.md §16).

`npm link` puts `mh` on your path instead of `node src/cli.ts`.

## Layout

| Path | What it is |
|---|---|
| `src/daemon.ts` | Goals, agents, message delivery, the human inbox |
| `src/hub.ts` | The six agent tools: `team`, `spawn`, `send`, `wait`, `status`, `done` |
| `src/store.ts` | Append-only event log (SQLite, built into Node) |
| `src/recover.ts` | Rebuilding goals from the log when the daemon restarts |
| `src/server.ts` | Client API: `GET /state`, `GET /events` (with replay), `POST /commands`; `/mcp/<token>` and `/hook/<token>` for agents |
| `src/harnesses.ts` | Harness profiles: finding each CLI, its login and its models |
| `src/mcpservers.ts`, `src/readonly.ts` | Roles' MCP servers by name; which shell commands only read |
| `src/doctor.ts`, `src/probe.ts` | `mh doctor` and `mh test` |
| `src/git.ts` | Worktrees and branches per agent, and reading new commits for git events |
| `src/mcp.ts` | The tools as an MCP server, one identity per agent, plus the approval tool |
| `src/cli.ts` | The `mh` command |
| `src/adapters/` | `claude.ts` (Claude Code, stream-json), `codex.ts` (Codex app-server), `agy.ts` + `agy-hook.ts` (Antigravity CLI, stream-json and hooks), `fake.ts` (scripted agents for tests) |
| `.metaharness/` | Roles, methodology and workflows for this repo |
| `test/` | `npm test` runs teams end to end in throwaway repositories (scripted agents, plus a fake `agy` that runs real hooks), with no model calls |
