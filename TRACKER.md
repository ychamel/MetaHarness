# Tracker

Where MetaHarness stands against the plan in [DESIGN.md §16](DESIGN.md). Update this file when a
step lands. Last updated 2026-10-17.

## Milestone 0: a small team works ✅

Exit test passed on 2026-10-17 in `~/Desktop/Projects/test_meta`: an Opus architect, a
`gpt-6.1-sol` implementer and an Opus reviewer built a color-changing button. 23 of 23 tests
passed, the review findings were fixed, and the human only had to answer 3 approvals.

- [x] Harness capability research (DESIGN.md Appendix A)
- [x] Daemon, event log (SQLite), the six agent tools, human Inbox (`5424124`)
- [x] Client API: `/state`, `/events` with replay, `/commands`; `mh` CLI
- [x] Fake adapter and scripted end-to-end tests
- [x] MCP layer: one address and identity per agent (`d8fa948`)
- [x] Claude Code adapter (stream-json, mid-turn delivery, approvals through our MCP tool)
- [x] Codex adapter (app-server, `turn/steer`, approvals through its protocol)
- [x] Quick spawns; native subagents off in both harnesses
- [x] Role reminder in each agent's first message (Luna ignored developer instructions without it)
- [x] Fixes from the first run: full approval text, status kept during approvals, agents isolated
      from the user's plugins and global MCP servers (`c156aff`)

## Milestone 1: real use

- [ ] **Git worktree per coding agent**, branches `mh/<goal>/<agent>`, and merging (next up)
- [ ] Antigravity CLI adapter for Gemini (`agy` 1.4.0 is installed; test stream-json, hooks,
      mid-turn delivery and the "-p prints nothing without a terminal" report first)
- [ ] Change notices when shared files change, plus `shared/.history/`
- [ ] Rate-limit handling: show the agent as waiting with a retry time, not crashed
- [ ] Resume agents after a daemon restart, from their saved native session IDs
- [ ] Warm pool for quick-helper roles
- [ ] Idle nudges, and detecting two agents waiting on each other
- [ ] Comparison run: ~10 real tasks, Opus alone vs the team (quality, cost, time, interventions)

## Milestone 2: UI

- [ ] Team tree, agent detail, messaging and controls, Inbox (build order 1 in DESIGN.md §14)
- [ ] Graph (card style), sequence, timeline (build order 2)

## Milestone 3: improve

- [ ] Role×model stats, retrospectives, replay, costs, git view, search

## Not yet verified live

- Interrupting a Claude Code turn
- A quick spawn running on a real harness
- How Claude Code reports cost across several turns of one session (we keep the running maximum)
- Codex cost needs `.metaharness/prices.json`; without it, cost shows as "—"

## Resuming work

```sh
npm install && npm test        # 10 tests, under a second, no model calls
node src/cli.ts daemon --fake  # try it without spending anything
```

Real runs: start `node src/cli.ts daemon` from the repository the agents should work on, then
`mh run`, `mh tail`, `mh status`, `mh approve`. The data lives in `~/.metaharness`.
