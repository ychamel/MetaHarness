# Tracker

Where MetaHarness stands against the plan in [DESIGN.md §19](DESIGN.md). Update this file when a
step lands. Last updated 2026-10-24.

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
- [x] **Fresh session when a context window is nearly full** (2026-10-19): at `contextHandoffPct`
      (80) an agent mid-turn is asked to write notes, then a new session on the same harness and
      model starts at the next step boundary (never mid-command, never with an approval open),
      from a handoff that now also carries the goal, the team and its helpers' results, and the
      waiting messages. Between turns nothing happens until a message comes, which starts the
      fresh session (no turn spent). Not again for a session that began within 20 points of the
      threshold; a harness that compacts first cancels it. Claude Code's window is assumed 200k
      (1M for `[1m]`) until a turn ends. Live on haiku with the threshold at 35%: asked at 37%,
      notes written, fresh session at once, which read the notes and carried on where the old
      one stopped reading
- [x] **Antigravity isolation from the user's own customizations** (2026-10-25, agy 1.4.7):
      agy reads its global MCP servers, hooks, plugins and workflows from `$HOME/.gemini/config`
      with no switch, so it runs with a HOME of links (`~/.metaharness/homes/<harness>/home`)
      that leaves those out; commands get the real HOME back through `BASH_ENV`. A role's server
      without a MetaHarness definition is copied from the user's `mcp_config.json`. Checked live
      with spy servers, hooks and a plugin (none fire; the sign-in, resume and the command's HOME
      hold) and `mh test antigravity` (every check passes). The probe now also passes an urgent
      message the running turn takes through a hook (agy 1.4.7 calls the model again soon enough
      that no pause is needed), and an account a report re-confirmed without changing it
- [x] agy 1.4.7's new tools mapped (its init event lists 60; the model is shown a subset, the
      browser ones inside `browser_subagent`). Refused for MetaHarness's own: `send_message` (new
      kind `message`, use send), `schedule` (new kind `schedule`, use wait), `run_workflow` (a
      Python script that starts agents: delegate). Reads: `manage_inbox`, `search_marketplace`,
      `list_plugin_accounts`, the browser's DOM, screenshots, console and network, and
      `manage_task` but `send_input` (shell). The human is asked for `notebook_execution` (shell),
      `delete_knowledge` (the user's knowledge, linked into the isolated HOME), browser actions (the
      browser profile is the user's, signed in) and `generate_image` (spends quota).
      `--disable-slash-commands` is passed when `agy --help` lists it: without it, a message
      starting with `/` runs as agy's command, and under stream-json `/help` ends the process.
      `--effort` now works with a bare model name; the per-effort model names stay, since 1.4.1
      hangs on it. Checked with tests and `mh test antigravity` (every check passes)
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
- [x] **Stuck agents reported to the lead** (2026-10-19, DESIGN.md §8): after `stallMinutes` (10) of
      nothing but `wait`, when the teammate an agent last dealt with is waiting too or has
      finished, or nobody on the team is working; not when it waits on the human, an approval,
      or helpers of its own that still work. Once per stuck spell; the human gets a `stalled`
      Inbox item (reply goes to the lead) when the lead has finished, or the whole team stays
      stuck another `stallMinutes` after the lead was told. Scripted tests only; not seen live
- [x] **Rules** (2026-10-19, DESIGN.md §18, `src/rules.ts`): markdown notes that reach an agent at
      a moment the daemon sees (`start`, `path`, `new-file`, `commit`, `done`), filtered by role
      and path, delivered like change notices (a running turn gets them, an idle agent with
      whatever reaches it next); each logged as `rule.fired`. Layers: the built-in pack
      (`defaults/rules/`), personal, repository; same name replaces, `off: true` or
      `settings.json` `rules: {name: false}` turns one off. Rules page in the app; the assistant
      can propose one. Adapters now say what kind each tool call is (Codex: which files it
      created). Live on Claude haiku in a scratch repository: map sections came with its reads
      and it reused the helpers the map named, no-duplicates fired on its new file, map-upkeep
      on its commit (it then updated ARCHITECTURE.md), finish-clean held its first done.
      Not yet seen live on Codex or Antigravity, nor the map-bootstrap workflow
- [x] **The clean-code pack**: `conventions` (+ `CONVENTIONS.md`), `map` (sections of
      `ARCHITECTURE.md` by path heading), `no-duplicates`, `map-upkeep`, `finish-clean`,
      `map-missing`, and the built-in `map-bootstrap` workflow
- [x] **Personal skills hidden** (checked live 2026-10-19): Claude Code already by
      `--setting-sources project,local` (the claude.ai plugin's skills drop out, bundled ones
      stay); Codex by `skills.config` entries for `user`-scope skills from `skills/list` (a probe
      skill vanished from a luna thread, imagegen stayed); Antigravity by stubs in the agent's
      customization root (a global probe skill showed as "turned off" on gemini flash)
- [x] **Skills, step 2** (2026-10-20, DESIGN.md §18, `src/skills.ts`): `SKILL.md` folders from
      the built-in, personal and `.metaharness/skills/` folders and the repository's
      `.claude/skills` and `.agents/skills`, for every harness. A `skill(name?, part?)` tool: a
      summary first (description, SKILL.md whole when short, else its opening and headings; its
      files by path), then one section or file. Each harness's native copy of the repository's
      skills is hidden (Claude Code `Skill(name)` denied, Codex `repo` scope off, Antigravity
      stubs); `native_skills: true` on a role keeps them. Live on haiku, luna and gemini flash in
      a scratch repository: all three listed the skills, got the note on reading `src/`, read the
      summary and the right section. Claude Code still lists a hidden `.claude/skills` skill but
      its call was refused; Codex no longer listed the `.agents/skills` one; Antigravity's stub
      won over the workspace's
- [x] **Skills carried like MCP servers** (2026-10-20, after talking it through): a role's
      `skills:` names what it carries (a skill no role names goes to every role), a rule's
      `skill:` points at one at a moment, and a skill's own file keeps only `harness:` and
      `off:`. Skills moved to the *Tools & skills* page (read-only, with a switch, who carries
      it and which rules point at it); the Roles page has a Skills field, the Rules page *Points
      at a skill* and a hint when a rule's text grows long. Re-run live on the same three: a
      skill only the Claude role names was listed for it alone, and a `skill:` rule on `src/**`
      led each agent to the skill's summary and the right section
- [x] **Crashed agents respawned by their spawner** (2026-10-23, from use: an Antigravity agent
      crashed and the lead had to be told to spawn a replacement by hand). The spawner gets the
      reason, the last message and its options, the lead hears about crashes further down, and
      `respawn` (tool, `agent.respawn`, `mh respawn`, Respawn / Start over in the app) starts it
      again under its name: its session resumes, or `fresh` / `on: <harness/model>` starts a new
      one from a handoff. The crashed one stays as `<name>-crashed` with its history (its events
      and the messages to it are renamed in the log, `agent.renamed`); the replacement takes its
      role, brief, spawner, worktree and waiting messages. A crashed lead goes to the human's
      Inbox. The daemon never respawns by itself: the user wants the lead to decide
- [ ] An agent that goes quiet mid-turn for a long time (no tool calls, no text): not detected.
      Dropped unless it shows up in use (2026-10-23): it never has; crashes did
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
- [x] **Second round from that run** (2026-10-18): Codex past its plan's limit shows as a warning
      with credits, not "ok"; approvals by a gatekeeper model or the harness's own (settings,
      per role), checked live on haiku; costs by kind of token with a Costs tab; prompt-cache
      clocks and reminders; Harnesses and Settings pages (`settings.json`, `settings.save`,
      `harness.check`, `gatekeeper.create`). Checked in headless Chrome on a scripted team
- [x] **The assistant** (2026-10-18): Ask panel; assistant role (built in on Codex luna with
      backups, editable); read-only MCP tools (goals, goal, events, agent, files, costs,
      config, guide) and propose/apply for setup changes; fresh session per conversation.
      Checked live on luna against a copy of the Evolution run's log, and in headless Chrome
- [x] **Plan limits** (2026-10-18): every window of every account (Claude Code session and
      weekly, Codex 5h and 7d, each Antigravity pool), read without a turn: `claude -p /usage` (since 2026-10-20 a one-word Haiku ping when its text
      has no windows),
      Codex `account/rateLimits/read`, `agy -p=/quota` (now with stdin closed; it waited on it
      before). At start, every `limitCheckMinutes` (10), and *Check now* (`limits.check`). Home
      and Harnesses show them, a running goal's header a chip per account. A lifted limit
      releases agents waiting on it. Read live from all three on 2026-10-18; checked in
      headless Chrome
- [x] **Gatekeeper reads commands as the shell does** (2026-10-20, from the Evolution map run:
      7 approvals came to the human, 6 of them harmless). Five were Codex scouts writing reports
      into `shared/` with `cat <<'EOF'`: haiku misread Codex's `/bin/bash -lc "…'"'"'…"` quoting
      as live backticks, and one report ran past the 6,000 characters it is shown. Now
      `src/shellview.ts` takes off the wrapper (for the Inbox too) and replaces quoted
      here-document bodies with their length, the prompt names the shared folder and says when a
      command is cut. Replayed live on haiku: all 6 ALLOW, the `git rm` of a tracked shader ASK
- [x] **Fixes and features from use** (2026-10-23):
  - Graph flicker and blank graph: the graph handed React Flow new nodes without their
    measured sizes on every drag step, event and 5 s tick, so React Flow hid every card and
    dropped every line until it measured them again (seen in headless Chrome: all 5 cards
    hidden and 0 of 6 lines on each drag frame), and framing the view meanwhile could land on
    empty space. Sizes now go back in, and the view is framed once new cards are measured. An
    error boundary keeps a failing view (or a chunk gone after `ui:build`) from blanking the app.
  - Panes resize: the goal page's columns, the graph's panel, the file list, the setup lists
    and the assistant, by dragging their edge (kept per browser, double-click resets).
  - Leftover processes: each harness CLI runs in a process group of its own; stopping an agent
    closes its stdin, then SIGTERMs and SIGKILLs its group and descendants that left it
    (`src/procs.ts`); what a CLI leaves behind when it exits goes too, and the daemon kills
    what's left as it exits. Codex threads are unloaded (`thread/unsubscribe`) and the shared
    app-server shuts down after a minute with none. Finished agents let their process go after
    10 quiet minutes (`agent.released`); a message resumes their session.
  - **Effort apart from the model**: a role's `effort:` (low … max, Codex's ultra), a backup's
    own with `@high`; Claude Code `--effort`, Codex `model_reasoning_effort` (checked live:
    a thread reports the effort it got), Antigravity the listed `-low/-medium/-high` variant
    (a bare name with `--effort` hangs `agy`), ACP the `thought_level` option; each takes the
    nearest level it has. The role editor folds Antigravity's variants into model + effort, so
    one price per model covers every effort.
  - **Workflows name their roles** (`roles:`): agents running one can start only those, plus
    quick helpers; a chained workflow adds its own; the human can start anyone.
  - **Live graph**: the step each agent is on and for how long, unread messages, approvals; a
    pulse along a line per message; dashed lines to whoever an agent waits on (`waitingOn` in
    the snapshot: the human, the agents it started, or its last partner); a messages panel
    (or everything) beside it, and a pair's whole conversation on clicking its line.
  - **Goals page**: every goal from any folder, with its size on disk; open it or its files,
    open its shared folder, delete one or many (`goal.delete`: git cleanup as before, then the
    goal's folder and events; unsaved work asks again; a goal at work is refused), and folders
    the log no longer has a goal for.
  Checked in headless Chrome against scripted teams; not yet in a real run.
- [x] **Git and design round** (2026-10-23), from the user wanting the architecture visible
      rather than reading every diff:
  - **Exact authorship**: `post-commit`/`post-merge`/`post-rewrite` hooks in the guard's hooks
    folder record `<sha> <agent>` in `.git/metaharness/authors-<goal>` (`MH_AGENT`, `MH_GOAL`
    in each agent's environment); the daemon watches the folder, so commits show at once. The
    two-minute guess stays as the fallback. Commits and merges carry their size and paths
    (`--diff-merges=first-parent`).
  - **Landed work**: commits reaching the goal branch are announced as `git.landed` once the
    branch is quiet for a minute; a design snapshot follows, and roles with `wake: landed` hear
    about it.
  - **Git tab**: branches with ahead/behind and uncommitted files, every commit and merge with
    its author colour and size, diffs of a commit, a branch, the whole goal, or uncommitted
    work (`GET /git`, `GET /diff`, read when asked, never logged). Agent detail has a
    **Changes** tab.
  - **Design tab**: areas from `ARCHITECTURE.md` (folders without one; unmapped folders dashed),
    import arrows between them, live activity by agent, collisions; a timeline of snapshots
    (`goals/<goal>/design/`) with what changed since the one before or the start; an area's
    files as a treemap, a file's definitions and imports; pinned notes (`note.pin`, kept as a
    rule with `note.keep`); history (map commits, snapshots) and findings for next time
    (collisions, conflicts, rework, spread, rules fired).
  - **Language packs** (`src/languages.ts`, web-tree-sitter 0.27): Python, TypeScript, TSX,
    JavaScript, GDScript (grammar built to wasm with emscripten, `defaults/languages/GRAMMARS.md`),
    Godot scenes (patterns); packs in `languages/` folders add more, with a tree-sitter grammar
    or line patterns, and five ways to resolve imports.
  - **Cartographer**: built-in role (`defaults/roles/`, which now loads like the built-in rules
    and workflows), the only editor of the map; messaged by teammates, woken by landed work,
    commits the map with a one-line design summary. A `cartographer` start rule tells the lead
    to use one; `map` and `map-upkeep` point teammates at it.
  Checked with tests (11 new) and in headless Chrome against a scripted team (lead, two
  worktree implementers, the cartographer) on a small repository, light and dark. Not yet in a
  real run: whether a real cartographer keeps the map well, and how the Design view reads on a
  large repository.
- [x] **Done waits for the team, and a more versatile assistant** (2026-10-23):
  - An agent's `done` is held while teammates it spawned still work (or rest while their own
    teammates work); quick helpers and woken roles (the cartographer) don't count. The reply
    names them with their state and status, and the agent decides: wait, message them, or carry
    on. `agent.done_held` in the log.
  - The assistant's panel picks its model (any harness that runs here, or the role's), its
    effort, and **Read only / Write**. A new model or effort takes over mid-conversation with a
    transcript of it (so does a session after a crash); write mode holds from the next tool call
    and is told to the model once; a new conversation goes back to read only. Side sessions
    now get their route's effort (the gatekeeper's and assistant's role effort was dropped
    before). `assistant.set`, `assistant.options`. **Make default** (`assistant.make_default`)
    saves the pick to the role, writing the built-in one out first; backups named by model alone
    keep their old harness, and the new model drops out of them. The role editor shows the
    assistant and gatekeeper only model, effort, backups and instructions.
  Checked with tests (2 new, 3 updated) and in headless Chrome on a fake daemon. Not yet live.
- [x] **One Design screen, in layers** (2026-10-23), from the user: changes were hard to see
      on the map, and tracing a colour meant hunting through the Git list.
  - **Scopes** (`GET /design/scope`): the whole goal, optionally with the unmerged branches
    merged in as a picture (`git merge-tree`, nothing moves), a landing, an agent's branch, a
    commit, or a shift-clicked range, picked on a lane graph of the branches at the top.
  - **Layers**: change (areas tinted by lines changed, top definitions named on the card, new
    and removed areas), dependencies (new, lost, circular), flows from the map's `## Flows`
    section (checked against the imports), hotspots, activity, fade unchanged. Picking an agent
    fades what it didn't touch.
  - **Inspector**: the scope's changes, commits (hover lights their areas), hotspots, cycles and
    flows; an area's lines, authors, and changed definitions, each opening just its part of the
    diff (definitions now keep their last line); the file treemap tinted by change.
  - **Reports**: JSON per landing and for the goal so far in `design/reports/`, for a later
    analysis goal (no suggestions yet).
  - Git commits name their areas and open the Design tab there; the Git tab stays until the
    Design view makes it redundant.
  - The cartographer, the map-bootstrap workflow and `map-upkeep` know about flows.
  Checked with tests (2 new) and in headless Chrome against a scripted team (two merged
  implementers, one left unmerged that makes a circular dependency, the cartographer), light
  and dark. Not yet in a real run or on a large repository.
- [x] **The Systems lens** (2026-10-24), from the user: the areas map shows which folders a
      commit touched, not how the game's systems are built and connected.
  - A GDScript code reader and resolver (`src/codegraph.ts`): calls, objects made, signals
    emitted and handled, state read and written, entry points from the engine, the main scene
    and the autoloads; kept per commit as `design/<sha>.code.json` (`GET /design/code`,
    `GET /design/source`). Tests and add-ons left out.
  - In the Design tab, **Areas · Systems**: a map from the engine down (areas open into classes,
    isolate one), a trace (step by step in line order, down or up, with the stacks from the
    engine and the code), and between (two systems and what joins them, by direction of
    influence). Changes in the scope marked throughout.
  Checked with tests (3 new) and in headless Chrome on a throwaway daemon reading Primordia
  (99% of 5568 calls followed). Not yet in a real run. Later: other languages' readers,
  layer rules (`sim -/-> ui`) checked per commit, mechanics named in the map.
- [x] **One Systems canvas you zoom by focus** (2026-10-24), from the user: the map was either
      the high level or a mess of nodes once an area opened; they wanted to filter the noise
      while still knowing it exists, stay on one screen, and see how a change plugs into the game.
  - Look at classes, groups or areas: drawn in full (a class's functions as pins, a group or
    area as a frame), one step out summed as cards with a pin per card they link to, the rest
    as chips; autoloads used everywhere as rails. Split and fold cards, Back/Esc, ELK layout.
  - Groups inside large areas: automatic (by how classes link), or named in ARCHITECTURE.md's
    `## Systems` section; doc comments read into the graph and shown on cards.
  - What the scope changed is the default focus, with the route from the engine to it; two
    systems looked at replace Between; the trace is docked in the panel, synced with the canvas.
  - The cartographer keeps `## Systems` and may add a one-line class doc comment.
  - Follow-up (same day): cards resize from their corner (taller: more pins; wider: what each
    pin links with); a card's menu (right-click or ⋯) says why it's there and names what can be
    done; what was split, folded, hidden or drawn is listed above the canvas, each undoable.
    A focus opens centred on what's looked at, at a zoom you can read.
  Checked with tests (2 new) and in headless Chrome on Primordia (its last goal's commits).
  Not yet in a real run.
- [x] **Documented code, read on hover** (2026-10-25), from the user: every file, class and
      function should say what it's for, and the Design view should show it on hover.
  - The cartographer owns the doc comments as well as the map, and the lead starts one for any
    goal that changes code, even a small patch, map or not. It documents what landed without a
    doc and rewrites one only when it has become wrong, describing the code as it is (no
    history, length to fit the function). Teammates tell it what things are for.
  - The `doc-bootstrap` workflow documents a repository part by part, in parallel.
  - Language packs read doc comments (comments right above a definition, or a docstring; a
    pack's `doc:` marker limits them, `##` in GDScript), served by `GET /design/docs`.
  - One hover card (summary, then detail) on the canvas's class cards and function rows,
    definition names in the code view, and file rows: the commit panel, changed files,
    hotspots, the file map and a file's definitions.
  Checked with tests (1 new) and a typecheck. Not yet in a real run.
- [x] **One Goals tab, and discussion rooms** (DESIGN.md §21, brainstorm → "go" on 2026-10-25).
  The rail's Goal, Goals and New goal are one **Goals** tab (opens on the running goal; the
  goal menu has New goal and All goals…). **Rooms**: the human leads seats (role + optional
  harness/model + stance) through ask, job, views, respond, debate, chain and patch; answers go
  to the thread; led by default (participants' messages to each other become suggestions) or
  open; a coordinator side session (built-in role) rates each round and keeps the board;
  patches on `mh/<room>/room`, merged once, then the cartographer maps them; endings: design,
  goal from the room (`fromRoom`), new room from a room or goal, end (keep or discard). Casts in
  `casts/`. UI: Thread tab (thread, seats, composer, board), room header, New room dialog,
  Rooms in Home and the Goals list; the other goal tabs work for rooms. Checked with tests
  (6 new) and in headless Chrome against a scripted daemon. Not yet in a real run.
- [x] **Rooms, round 2** (DESIGN.md §21, after the user's first real room, 2026-10-26). Fixed
  from its log: nobody picked no longer means everyone; the coordinator now decides after
  every answer instead of waiting for a quiet room (it never looked again); panel messages show
  in the thread; side questions go through the coordinator instead of ping-ponging. New: the
  coordinator routes and decides (back, forward, compare, note; waits for its own forwards;
  check-in after 4); seats are a role or just a model, with a responsibility and a stance;
  agents get the roster and a digest; `team` knows rooms; canvas + thread/board layout; `+ New
  goal` / `+ New room` in the headers; the coordinator on Codex luna; a scripted coordinator for
  `mh daemon --fake`. Then: the coordinator splits a question into parts per seat, running
  them in parallel or waiting for the parts they need (`after`), one decision at the end.
  Checked with tests (11 room tests) and in headless Chrome against a
  scripted daemon. Not yet in a real run.
- [x] **Rooms, round 3** (DESIGN.md §21, brainstorm → answers on 2026-10-26). Seats can be
  **benched** (skipped by routing; session rests, one at work finishes first; resumes with a
  digest when brought back) and **stopped** mid-answer (what it said stays as its answer,
  marked stopped; the coordinator sees it; the seat stays). A per-seat **scout** switch lets a
  seat hand lookups to the `scout` role as a quick helper (refused when off); its lookups show
  in the thread. Agents are told to answer simply with details in a report. Shared files named
  in the thread are links and chips that open in the room's side panel, as in the Graph tab
  (full shared-folder paths link too, there and in the Graph). Checked with tests (3 new, 150
  in all) and in headless Chrome against a scripted daemon. Not yet in a real run.
- [x] **Rooms, round 4: a lead, lenses and a canvas** (DESIGN.md §21, brainstorm → answers on
  2026-10-26). The human talks with one lead (built in: Antigravity Gemini 3.8 Flash, Sonnet as
  backup), which sends lenses (the room's set-up roles or models) in the background and keeps a
  canvas of cards (question, idea, finding, risk, decision) and links, through a `canvas` tool
  the lenses use too. Replaces the coordinator, seats, ask modes, bench, scout and open mode.
  Cards branch into rooms of their own; patches go through a lens with `patch: true`. UI: chat
  beside the canvas, lens bar, endings in the header. The fake harness now starts a turn with
  injected messages a script didn't read (as real harnesses do). Checked with tests (6 room
  tests, 143 in all) and in headless Chrome against a scripted daemon. Not yet in a real run.
- [x] **Layered docs in the default pack** (DESIGN.md §18, brainstorm → "go" on 2026-10-26).
  The map becomes the first of several layers, read before code: `ARCHITECTURE.md` (~100
  lines, sent whole at the start by `map`, now a start rule), `docs/RUNTIME.md`, a README per
  system with fixed headings, decision and domain docs. A new `docs` rule says what goes where,
  the sizes (suggestions an agent keeps by pruning, or by asking to raise them; nothing
  checks), and who keeps what: teammates their systems' READMEs, the cartographer the map, the
  runtime doc and the doc comments. `map-bootstrap` writes the layers. Rule text only, plus the
  cartographer's and rooms' wording made generic. Checked with tests (143). Not yet in a real
  run: the throwaway `docs-migrate` workflow waits in Evolution_meta's `.metaharness/workflows/`.
- [x] **Rooms, round 5: a design board for getting clear** (DESIGN.md §21, brainstorm → "go" on
  2026-10-28). Use cases split: goals build from a decision, rooms reach one. The lead becomes a
  facilitator (directions, narrowing questions, a concept card); lenses become makers picked by
  what they make, with four built-in roles (researcher, illustrator, prototyper, writer); the
  canvas becomes a free board (new card kinds: source, image, demo, text, concept; frames;
  places; tidy). The human asks makers directly (`room.ask`) and mixes cards (`room.mix`:
  placeholders linked to their ingredients, what to take from each, remix). Demos are sandboxed
  pages with knobs (`GET /media` wires `window.knobs`); **Keep these values** makes a decision.
  Harness manifests say `web` and `images`; image tool calls are allowed in rooms; Codex gets
  live web search. Patches, the room branch, Merge and the room cartographer are gone. Checked
  with tests (148 in all), in headless Chrome against a scripted daemon (board, demo sliders,
  kept values, mix dialog, drag onto a frame), and live through MetaHarness on 2026-10-28:
  Codex luna made an image (its tool, copied into `room/media/`, the gatekeeper allowing the
  copy) and a source card from a web search, both answering the human without waking the lead.
  Antigravity Flash never calls `generate_image`: it uses its `image-generator` subagent, which
  was refused (it then drew pixel art with Python). On the user's call, that subagent is now
  let through as an image request, with its report back to its parent session; retested live,
  it generated the image, saved it to `room/media/` and put the card on the board in ~2 minutes.
- [x] **Projects: one daemon, many folders** (DESIGN.md §22, brainstorm → "go" on 2026-10-30).
  The daemon no longer starts in a folder: it opens projects like an editor, holds them all,
  and runs their goals at once, sharing subscriptions and limits. A `Project` (folder, config
  over the personal one, design snapshots) belongs to each goal and room; nothing falls back to
  the daemon's folder. `~/.metaharness/projects.json` keeps the folders opened and trusted; a
  folder with its own `.metaharness` setup shows what it would run and asks once. The app gets
  a Projects page (cards, Open folder over the daemon's disk, New project), a project switcher,
  and every command carries the project; the CLI gets `mh project`, `mh projects`, and `mh run`
  opens the git top it's run in. The assistant is the machine's: it proposes `project.open`,
  `project.create`, `project.clone`, and starts in the project it's asked from. Agents stay in
  their project: reads outside ask (they all passed before), read-only commands are
  auto-approved only when `pathsOutside` finds nothing, agents lose `MH_HOME`, a
  `stay-in-project` default rule, and Codex threads get a permission profile denying other
  projects and `~/.metaharness`. Checked with tests (155), in headless Chrome against a scripted
  daemon (start screen, folder browser, open, goal in the project, trust prompt, setup per
  project), and live on 2026-10-30: Codex luna (the profile blocks a read of another project;
  writes and network as before; the `sandbox` parameter overrides a profile, so it's left out),
  Claude haiku (a `cat` and a Read outside both come to the Inbox). Not yet: Antigravity live,
  Windows paths, a phone client.
- [ ] The assistant stepping into goals (messaging the lead, pausing): later
- [ ] Your own runs with the UI (live harnesses); fix what they turn up
- [ ] Build order 3 (Milestone 3): shared-folder history browser, replay, search

## Milestone 3: improve

- [ ] Role×model stats, retrospectives (totalling the Design view's findings and reports across goals),
      replay, search

## Not yet verified live

- A quick spawn running on a real harness
- How Claude Code reports cost across several turns of one session (we keep the running maximum),
  and across a resumed session (counted as new spend on top of the old)
- A real move to a backup at a real rate limit (tested with scripted agents only)
- Antigravity approvals that reach the human (tested with the fake `agy`; live runs only hit
  allowed and refused tools)
- Codex, Antigravity and ACP cost needs prices in `settings.json` (the old `prices.json` still
  works); without them, cost shows as "—" and the Costs tab says which models lack a price

## Resuming work

```sh
npm install && npm test        # 155 tests, about half a minute, no model calls
node src/cli.ts doctor         # what's installed and signed in here
node src/cli.ts daemon --fake  # try it without spending anything
```

Real runs: start `node src/cli.ts daemon` (from anywhere), open the folder the agents should work
on (`mh project` in it, or Open folder in the app), then `mh run`, `mh tail`, `mh status`, `mh approve`.
The data lives in `~/.metaharness`.
