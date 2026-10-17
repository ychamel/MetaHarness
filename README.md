# MetaHarness

Run a team of AI agents from different providers, each in its own native harness (Claude Code,
Codex, Antigravity CLI), on one goal. Agents spawn and message each other through a small set of
tools, hand work over through a shared folder, and everything they do is logged so you can follow
and steer it.

The design is in [DESIGN.md](DESIGN.md).

## Status

Milestone 0: the core runs real teams across **Claude Code and Codex**. Agents reach their tools
over MCP, messages reach running turns natively (Claude Code streaming input, Codex `turn/steer`),
and permission requests land in your Inbox. Scripted agents (`--fake`) are there for development.
Antigravity CLI (Gemini) and git worktrees per agent come in milestone 1.

## Try it

Needs Node 24 or newer (it runs the TypeScript sources directly).

```sh
npm install                    # the MCP SDK, plus TypeScript for type-checking
node src/cli.ts daemon         # terminal 1 (add --fake for scripted agents, no model calls)

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

`npm link` puts `mh` on your path instead of `node src/cli.ts`.

## Layout

| Path | What it is |
|---|---|
| `src/daemon.ts` | Goals, agents, message delivery, the human inbox |
| `src/hub.ts` | The six agent tools: `team`, `spawn`, `send`, `wait`, `status`, `done` |
| `src/store.ts` | Append-only event log (SQLite, built into Node) |
| `src/server.ts` | Client API: `GET /state`, `GET /events` (with replay), `POST /commands`, and `/mcp/<token>` for agents |
| `src/mcp.ts` | The tools as an MCP server, one identity per agent, plus the approval tool |
| `src/cli.ts` | The `mh` command |
| `src/adapters/` | `claude.ts` (Claude Code, stream-json), `codex.ts` (Codex app-server), `fake.ts` (scripted agents for tests) |
| `.metaharness/` | Roles, methodology and playbooks for this repo |
| `test/` | `npm test` runs the milestone-0 scenario end to end |
