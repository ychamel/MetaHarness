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

Worktree run on 2026-10-18 (goal `e6cb3a94` in `test_meta`, "color history"). An Opus architect
split the work into two contract-bound pieces. Two Sol implementers built them in parallel in
their own worktrees and committed there, and each piece got its own Opus reviewer, started on
the implementer's branch with `from`. One reviewer test-merged the sibling branch (55/55 tests).
The architect merged both, added an integration test, fixed a review nit and updated the
README: 59/59 tests, 7 commits on the goal branch, about 11 minutes, $1.40 on Claude (Codex
cost unknown, no prices.json). The exit test also asks for implementers who adjust to each
other's changes, and this run didn't need that: the contracts kept them apart.

Findings from the run:
- 7 approvals, all for harmless Bash from Claude agents: compound read-only commands (`sed -n`,
  `cat`, loops), a heredoc writing to shared/, and a Python edit of README. Consider allowing
  read-only commands for architect and reviewer, and nudging agents toward their edit tools.
- A merge was reported as coming from `review-view` instead of `view`, because both branches
  pointed at the same commit. Fixed: merges are named after the branch a commit was first seen on.
- After `done`, `mh status` still shows the agent's last status line, which is out of date by then.

- [x] Git worktree per agent on `mh/<goal>/<agent>`; the lead's branch `mh/<goal>/main` is the
      goal branch; `spawn(from:)`; `git.commit`/`git.merge` events; the lead's final note lists
      unmerged branches. Codex gets the git dirs as writable roots so it can commit
- [x] First turn counts as busy from the start in every adapter, so early messages join it
      (Codex could otherwise start a second turn before `turn/start` answered)
- [ ] Clean up worktrees when a goal is over (`mh clean`?); they're kept for now
- [ ] Dependencies in fresh worktrees: agents are told to install them; consider linking
      `node_modules` and the like
- [ ] Merge conflicts as events (watch `MERGE_HEAD` in worktrees)
- [ ] **Antigravity CLI adapter for Gemini** (next up) (`agy` 1.4.0 is installed; test stream-json, hooks,
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

- Two implementers who have to adjust to each other's changes mid-task (the run above kept
  them apart with contracts)
- Interrupting a Claude Code turn
- A quick spawn running on a real harness
- How Claude Code reports cost across several turns of one session (we keep the running maximum)
- Codex cost needs `.metaharness/prices.json`; without it, cost shows as "—"

## Resuming work

```sh
npm install && npm test        # 14 tests, about two seconds, no model calls
node src/cli.ts daemon --fake  # try it without spending anything
```

Real runs: start `node src/cli.ts daemon` from the repository the agents should work on, then
`mh run`, `mh tail`, `mh status`, `mh approve`. The data lives in `~/.metaharness`.
