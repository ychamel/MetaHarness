# Tracker

Where MetaHarness stands against the plan in [DESIGN.md §18](DESIGN.md). Update this file when a
step lands. Last updated 2026-10-18.

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
- After `done`, `mh status` still showed the agent's last status line, which is out of date by
  then. Fixed: it's hidden once the agent is done or ended.
- The 7 approvals: 4 of them were read-only and are now approved by the daemon (see below).

- [x] Git worktree per agent on `mh/<goal>/<agent>`; the lead's branch `mh/<goal>/main` is the
      goal branch; `spawn(from:)`; `git.commit`/`git.merge` events; the lead's final note lists
      unmerged branches. Codex gets the git dirs as writable roots so it can commit
- [x] Read-only shell commands approved without asking, for every harness (`src/readonly.ts`).
      Replayed on the worktree run's 7 approvals: 4 would no longer ask; the 3 left are real
      writes (`git merge`, `cat >` into shared/, a Python edit of README), and the methodology
      now points agents to their edit tools for those
- [x] **Exit-test run** ✅ (2026-10-18, goal `9b3e7f3d`, branch `exit-test-2` in `test_meta`,
      request `.metaharness/requests/themes.md`, workflow `feature`). An earlier run of the same
      request (goal `80b3d7a6`, old one-worktree-per-agent code) finished with 84/84 tests but
      never changed the model's API, so nothing had to be followed. This time the human sent the
      model implementer a new requirement right after its first commit (named colors: `colors`
      become `{ hex, name }` objects). It was injected mid-turn; the model implementer
      committed the change within 20 s and told the UI implementer and the architect what
      changed and the hash; the UI implementer, half-way through, merged it, adapted the cycler
      and history labels, settled the label format with the architect, and merged again for the
      tests. Both pieces were reviewed by Opus (approved), merged into the human's branch by the
      architect, follow-ups applied, report written on Antigravity: 91/91 tests, 7 commits,
      about 10 minutes, $1.73 on Claude, 2 approvals (both harmless: `node -e`, `node --test &&
      git log`), 2 read-only commands approved by the daemon

- [x] First turn counts as busy from the start in every adapter, so early messages join it
      (Codex could otherwise start a second turn before `turn/start` answered)
- [x] **Workflows, specialist roles, one shared folder** (DESIGN.md §17): workflow files (with
      `playbooks/` still read) that the lead follows and chains with a `workflow` tool;
      `send(..., decision: true)` puts a decision in the Inbox; roles with `mcp:` (resolved by
      name per machine) and `workflow:`; the team works in the human's checkout, with worktrees
      from `spawn(worktree: true)`, a role's `worktree: true`, or `from`. Default workflows
      `feature`, `feature-explore`, `implementation`; new roles `explorer`, `designer`
- [ ] Not yet run live: a workflow chain with a human decision (the exit-test run chained
      `feature` → `implementation`, but the architect judged no approval was needed); a role
      with its own MCP server (blender is configured here for Claude Code and Codex)
- [x] From the exit-test run: commits and merges in the human's checkout were logged with no
      agent. They're now named after the agent in the checkout whose command last ran a
      committing git command (within two minutes); anything else stays unnamed (the human)
- [x] From the exit-test run: the Codex implementer twice messaged a placeholder hash
      ("912HEAD", "9FINAL") before its commit landed, then corrected it. The methodology now
      says to message after the commit finishes, with the hash git printed. Not yet seen live
- [x] Cleanup is the daemon's job (`src/clean.ts`, `goal.cleaned`): when the lead finishes, or
      the last teammate after it, worktrees and branches merged into the goal's branch go.
      Uncommitted or unmerged work, or anything git can't answer about, stays and is listed in
      the lead's note; only `mh clean <goal> --force` removes it (`--force` needs a goal, a
      prefix must match one goal). Never a goal whose agents still work, or whose lead hasn't
      finished, without `--force`
- [x] **Git guard** (`src/guard.ts`): agents only add history. A `reference-transaction` hook,
      set for agents' processes only through `GIT_CONFIG_PARAMETERS`, refuses deleting
      branches or tags and moving any branch but the agent's own backwards; a `pre-push` hook
      refuses pushing; the repository's own hooks still run. `git push`, branch/tag/ref
      deletion and `git worktree remove/prune` are refused before they run, and are in Claude
      Code's `--disallowedTools`. Tested with real git: delete, `reset --hard`, `--amend`,
      `branch -f` and push refused; commit, merge, new branch and rewriting its own branch allowed
- [x] Dependencies in fresh worktrees: the checkout's ignored `node_modules` and `vendor` are
      copied with hard links (`cp -al`, 0.15 s for 3,900 files). A symlink was tried first:
      `npm ci` through it emptied the checkout's `node_modules`. Venvs aren't copied (a copy
      still runs the checkout's Python). Not tried on macOS (BSD `cp` has no `-l`: nothing is
      copied there)
- [x] Merge conflicts as events: `git.conflict` / `git.conflict_resolved` (committed or aborted)
      from `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` or a rebase, in the checkout and every
      worktree. `done` mid-conflict is answered with a warning, and the spawner's note says so;
      the lead's final note mentions a merge still open in the checkout
- [x] Harness profiles and `mh doctor` (DESIGN.md §16): built-in profiles for Claude Code, Codex,
      Antigravity; detection of Cursor, Gemini CLI, OpenCode, Copilot, Qwen Code, Goose; user
      profiles in `.metaharness/harnesses/*.md`. The daemon builds its adapters from profiles
- [x] **Antigravity CLI adapter** (`agy` 1.4.1): stream-json, MCP and hooks in the agent's own
      `--add-dir` folder, mid-turn messages through `PreInvocation`, approvals and no native
      subagents through `PreToolUse`, interrupt by restarting from `--conversation`, quota per
      pool from `agy -p=/quota`. The "-p prints nothing without a terminal" report was wrong
- [x] Backups in roles (`fallback:`), used when the primary can't run here or is at its limit
- [x] Rate limits per account (or quota pool): warn at 90% and ask for notes; at the limit wait
      for a reset within 15 minutes, else move to a backup with a handoff built from the event
      log; new spawns skip limited accounts
- [x] Urgent messages interrupt: natively, or by kill-and-resume on harnesses without it
- [x] `mh test <harness>`: MCP, mid-turn message, follow-up, urgent interrupt, usage, rate
      limits. All three harnesses pass every check (2026-10-18; haiku, gpt-6-luna,
      gemini-3.8-flash-low)
- [x] **Messages mid-turn on every harness, never mid-step** (DESIGN.md §7): when a message
      can't join the running turn (no native injection, or it's urgent), the turn is paused once
      no tool is running, then continues in the same session with the message. Grace 20 s for a
      hook or tool result to pick it up, 60 s at most waiting for a tool. Urgent messages no
      longer cut commands short; `mh test` checks the turn pauses after the running command.
      Live on 2026-10-18, every check passes on all four: Claude Code (haiku, $0.08, native),
      Codex (gpt-6-luna, native), Antigravity (gemini-3.8-flash-low, by restarting the session
      from its ID), OpenCode (free model, natively over ACP)
- [x] **ACP transport** (`src/adapters/acp.ts`), with a built-in OpenCode profile (`opencode
      acp`, asks before edits and commands, no native subagents or questions). Messages ride on
      the output of commands run through our `terminal/*`, else the turn pauses between steps;
      permission requests go through the policy; model via the `model` config option; resume via
      `session/resume` or `session/load`; context and cost from `usage_update`. Tested against a
      scripted ACP agent (`test/fixtures/fake-acp.mjs`) and live
- [x] **Live: `mh test opencode` passes every check** (2026-10-18, OpenCode 2.0.32,
      `opencode/deepseek-v4.1-flash-free`, $0, 55 s): MCP tools, message mid-turn (in a `wait`),
      follow-up after done, urgent message pauses the turn after the running command, usage.
      Learned: OpenCode v2 reaches MCP tools through "code mode" (one `execute` tool running
      `await tools.metaharness.status(...)`), so the policy reads the code's `tools.<server>.<tool>`
      calls; it runs commands with its own `shell` tool, never the client's `terminal/*`, so its
      mid-turn messages come through `wait`, our tool results, or a pause between steps; its
      `shell` permission requests carry the command and reach our policy. A server passed over
      ACP replaces one in its config, so `codemode: false` can't be set that way (tried: direct
      tools made the model search longer). `opencode/glm-5.3-flash-free` answered 429 "Endpoint
      is unavailable" and OpenCode kept retrying; `MH_ACP_LOG=<file>` records the traffic
- [ ] OpenCode retries reported as `session_info_update` `_meta["opencode/retry"]` (with
      `provider.rate-limit`) could feed rate limits; an approval left in the Inbox when a pause
      cancels the turn is answered to nobody
- [ ] Other ACP harnesses as profiles (Gemini CLI, Goose, Qwen Code, Kimi): their `args` need
      checking against each CLI
- [ ] A one-shot print-mode transport: only for a harness that has nothing better
- [ ] Drafting profiles for unknown harnesses, a shared profile registry, role presets
- [ ] Handoff when a context window is nearly full (same mechanism as a move)
- [ ] Antigravity isolation from the user's own global plugins and MCP servers (like
      `--strict-mcp-config`); none are set up on this machine yet
- [x] Change notices when shared files change, plus `shared/.history/` (`src/shared.ts`): a
      scan every 3 s keeps each version as `.history/<path>/<n>-<writer><ext>`, logs
      `shared.write` / `shared.delete` / `shared.clash`, and leaves notes for teammates that ride
      along with their next tool result, message or hook, without waking anyone. The writer is
      the agent whose tool call named the file in the last two minutes; the owner is the first
      writer, and a write by anyone else is a clash both are told about. Versions, owners and
      open conflicts survive a restart
- [x] **Git guard live on all four harnesses** (2026-10-18, scratch repository, cheap models):
      each printed MetaHarness's `core.hooksPath`, committed in the checkout, and had `git reset
      --hard HEAD~1` refused before it ran (Claude Code by its own deny list, Antigravity by its
      hook, Codex and OpenCode by the policy), leaving the checkout clean. The first run showed
      `reset --hard` resets the files before the hook refuses the branch move, so commands that
      discard uncommitted changes are now refused up front in the shared checkout; Codex there
      runs with `approvalPolicy: untrusted` (its rule files can't be set per session), gets the
      checkout's `.git` as a writable root so it can commit at all, and has its `bash -lc '…'`
      commands read inside. Refusal reasons reach ACP and Codex agents as notices
- [ ] Not yet run live: dependency copies, conflict events, shared-folder notices and clashes,
      cleanup at a real goal's end (all covered by scripted tests)
- [x] Resume agents after a daemon restart (`src/recover.ts`, `Daemon.recover`): goals whose
      lead hasn't finished are rebuilt from the log; agents cut off mid-turn resume their native
      sessions with a restart note, their team's state and missed messages; done or idle agents
      resume when messaged; stale approvals are dropped; open questions, rate limits and git
      refs carry over. `close()` no longer logs agents as ended, so Ctrl-C and restart work.
      `mh daemon --no-resume` skips it. Run live on 2026-10-18 in a scratch repository: the
      daemon was stopped while a Claude haiku lead waited and a Codex luna implementer was in
      `sleep 45`; the next daemon resumed both native sessions, the implementer checked its
      state, re-ran the cut-off command, committed and finished, and the lead merged ($0.11).
      The fast-forward merge in the checkout was named after the lead
- [ ] Warm pool for quick-helper roles
- [ ] Idle nudges, and detecting two agents waiting on each other
- [ ] Test each workflow on its own, once more workflows and roles exist (quality, cost, time,
      interventions). A single-model baseline comparison is dropped for now (2026-10-18)

## Milestone 2: UI

- [x] What the UI needs from the daemon (2026-10-18): `agent.pause`/`resume` (between steps,
      messages held; restartable harnesses end the process and keep the session),
      `goal.pause`/`resume`/`end`, `agent.spawn` by the human, `agent.open_native` (per-adapter
      `nativeCommand`, `open_cmd` in profiles); `GET /goals`, `GET /agent`, past goals rebuilt
      from the log in `/state`, goal status (`running`/`done`/`ended`/`stopped`), total cost,
      harness manifests; the daemon serves `ui/dist` at `/` and `mh ui` opens it. CLI: `mh
      pause|resume|end|spawn|open|ui`. `goal.set_lead` (a human as lead) left for later

- [x] Team tree, agent detail, messaging and controls, Inbox (build order 1 in DESIGN.md §14):
      React + Vite in `ui/`, served from `ui/dist` (`npm run ui:build`, `mh ui`); activity feed;
      start a goal, start an agent; browser notifications for new approvals and questions
- [x] Graph (card style), sequence, timeline (build order 2): React Flow cards with spawn,
      message (count, animated while recent) and shared-file lines, helpers folded into a badge,
      focus, time window; SVG sequence lanes and state timeline
- [x] Checked in headless Chrome against a scripted team on the real daemon and server (desktop
      and phone widths): approving a decision and an approval, pausing and resuming from the page
- [x] **Usability pass, and setup in the app** (2026-10-18): nav rail (Home, Goal, New goal,
      Setup); Home with what needs you across goals, a start box, running and past goals with
      outcomes and search; goal header with the outcome, message-the-team (lead, all, role,
      agent), clean up; Needs you apart from Updates; Story tab (key events as cards, steps
      folded) as the default, Files tab (shared folder rendered, versions, `GET /file`), Log;
      agent panel led by what it's doing or its result, only the controls that apply, tool calls
      folded. Setup pages edit roles, workflows, guidelines and MCP servers in the repository's
      or the personal folder (`src/configedit.ts`; `config.get`, `role.save|delete`,
      `workflow.save|delete`, `guide.save`, `mcp.save`, `harness.models`), and the daemon reloads
      its config on save. Unknown front-matter keys and leading comments survive a save; a
      workflow saved from `playbooks/` moves to `workflows/`. `--fake` has a scripted designer
      that asks you for a decision. Checked by driving headless Chrome on a scripted team:
      approve and send back from Home and the goal page, edit, create and save roles,
      workflows, a server and the guidelines, message the team, files, phone width
- [x] **First full run with the UI** (2026-10-18, a Godot game in `~/Desktop/Gamedev/Evolution_meta`:
      Claude opus architect, eight Codex implementers, a Claude sonnet reviewer, 2 h, $11.49 on
      the Claude side). Fixed from it: the goal page was 4,000px wide (a long goal title and
      feed lines widened its grid columns); graph cards can be dragged and keep their place
      per goal in the browser (Reset layout puts them back), shared files sit in a grid under
      the team; Home lists this repository's past goals, others behind a checkbox; Claude
      Code's permission prompt now goes through the same policy as the other harnesses (17 of
      the run's 58 approvals were reads of screenshots in /tmp); the model picker lists each
      harness's models; Codex's v1 approval requests get answers in their own shape; an
      approval answered at once is no longer lost
- [ ] Your own runs with the UI (live harnesses); fix what they turn up
- [ ] Build order 3 (Milestone 3): diffs and the git view, shared-folder history browser, costs,
      replay, search

## Milestone 3: improve

- [ ] Role×model stats, retrospectives, replay, costs, git view, search

## Not yet verified live

- A quick spawn running on a real harness
- How Claude Code reports cost across several turns of one session (we keep the running maximum),
  and across a resumed session (counted as new spend on top of the old)
- A real move to a backup at a real rate limit (tested with scripted agents only)
- Antigravity approvals that reach the human (tested with the fake `agy`; live runs only hit
  allowed and refused tools)
- Codex cost needs `.metaharness/prices.json`; without it, cost shows as "—"

## Resuming work

```sh
npm install && npm test        # 62 tests, about half a minute, no model calls
node src/cli.ts doctor         # what's installed and signed in here
node src/cli.ts daemon --fake  # try it without spending anything
```

Real runs: start `node src/cli.ts daemon` from the repository the agents should work on, then
`mh run`, `mh tail`, `mh status`, `mh approve`. The data lives in `~/.metaharness`.
