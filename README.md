# MetaHarness

Run a team of AI agents from different providers, each in its own native harness (Claude Code,
Codex, Antigravity CLI), on one goal. Agents spawn and message each other through a small set of
tools, hand work over through a shared folder, and everything they do is logged so you can follow
and steer it.

The design is in [DESIGN.md](DESIGN.md).

## Status

Milestone 0: the core runs real teams. Agents reach their tools over MCP, messages reach running
turns, and permission requests land in your Inbox. Scripted agents (`--fake`) are there for
development.

Milestone 1 in progress:
- Each agent works in its own git worktree on `mh/<goal>/<agent>`, and the lead merges into the
  goal branch `mh/<goal>/main`, which is what you take at the end.
- **Claude Code, Codex and Antigravity CLI** all run, and each passes every `mh test` check:
  mid-turn messages (native, or through a hook for Antigravity), urgent interrupts, resume,
  usage and rate limits.
- Roles can name backups. When a subscription nears its limit, agents are asked to write notes;
  at the limit they wait for a close reset or move to a backup, continuing from a handoff.

See [TRACKER.md](TRACKER.md).

## Try it

Needs Node 24 or newer (it runs the TypeScript sources directly), and at least one of Claude
Code, Codex or Antigravity CLI, signed in.

```sh
npm install                    # the MCP SDK, plus TypeScript for type-checking
node src/cli.ts doctor         # which harnesses are here, signed in, with which models; can each role run?
node src/cli.ts daemon         # terminal 1 (add --fake for scripted agents, no model calls)
node src/cli.ts test codex     # optional: check what works with a harness, on a cheap model

node src/cli.ts run "Add per-user rate limiting to /api/upload"   # terminal 2
node src/cli.ts tail           # follow everything live
node src/cli.ts status         # who's doing what
node src/cli.ts send implementer-1 "Did you add tests?"
node src/cli.ts approve <id>   # answer a permission request listed by status
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

Another harness on a transport MetaHarness already speaks is a profile, not code:
`.metaharness/harnesses/<id>.md` (see DESIGN.md §16).

`npm link` puts `mh` on your path instead of `node src/cli.ts`.

## Layout

| Path | What it is |
|---|---|
| `src/daemon.ts` | Goals, agents, message delivery, the human inbox |
| `src/hub.ts` | The six agent tools: `team`, `spawn`, `send`, `wait`, `status`, `done` |
| `src/store.ts` | Append-only event log (SQLite, built into Node) |
| `src/server.ts` | Client API: `GET /state`, `GET /events` (with replay), `POST /commands`; `/mcp/<token>` and `/hook/<token>` for agents |
| `src/harnesses.ts` | Harness profiles: finding each CLI, its login and its models |
| `src/doctor.ts`, `src/probe.ts` | `mh doctor` and `mh test` |
| `src/git.ts` | Worktrees and branches per agent, and reading new commits for git events |
| `src/mcp.ts` | The tools as an MCP server, one identity per agent, plus the approval tool |
| `src/cli.ts` | The `mh` command |
| `src/adapters/` | `claude.ts` (Claude Code, stream-json), `codex.ts` (Codex app-server), `agy.ts` + `agy-hook.ts` (Antigravity CLI, stream-json and hooks), `fake.ts` (scripted agents for tests) |
| `.metaharness/` | Roles, methodology and playbooks for this repo |
| `test/` | `npm test` runs teams end to end in throwaway repositories (scripted agents, plus a fake `agy` that runs real hooks), with no model calls |
