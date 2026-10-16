# MetaHarness

Run a team of AI agents from different providers, each in its own native harness (Claude Code,
Codex, Antigravity CLI), on one goal. Agents spawn and message each other through a small set of
tools, hand work over through a shared folder, and everything they do is logged so you can follow
and steer it.

The design is in [DESIGN.md](DESIGN.md).

## Status

Milestone 0, step 2: the core runs with **scripted agents** (no model calls). The Claude Code and
Codex adapters, and the MCP layer they connect through, come next.

## Try it

Needs Node 24 or newer (it runs the TypeScript sources directly).

```sh
npm install                    # dev tools only: TypeScript for type-checking
node src/cli.ts daemon --fake  # terminal 1: daemon with scripted agents

node src/cli.ts run "Add per-user rate limiting to /api/upload"   # terminal 2
node src/cli.ts tail           # follow everything live
node src/cli.ts status         # who's doing what
node src/cli.ts send implementer-1 "Did you add tests?"
```

`npm link` puts `mh` on your path instead of `node src/cli.ts`.

## Layout

| Path | What it is |
|---|---|
| `src/daemon.ts` | Goals, agents, message delivery, the human inbox |
| `src/hub.ts` | The six agent tools: `team`, `spawn`, `send`, `wait`, `status`, `done` |
| `src/store.ts` | Append-only event log (SQLite, built into Node) |
| `src/server.ts` | Client API: `GET /state`, `GET /events` (with replay), `POST /commands` |
| `src/cli.ts` | The `mh` command |
| `src/adapters/` | One adapter per harness; `fake.ts` runs scripted agents for tests |
| `.metaharness/` | Roles, methodology and playbooks for this repo |
| `test/` | `npm test` runs the milestone-0 scenario end to end |
