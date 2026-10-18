# Getting started with MetaHarness

MetaHarness runs a team of AI agents on one goal. Each agent runs in a coding harness you
already use and are signed in to: Claude Code, Codex, Antigravity CLI or OpenCode. A lead agent
plans the work and spawns teammates, the teammates message each other while they work, and you
follow along in a web app, answer their questions and approve what needs approving.

This guide takes you from nothing to a first goal, then covers how to steer a team and tailor it
to your subscriptions. For how it works inside, see [DESIGN.md](DESIGN.md).

## 1. What you need

- **Node 24 or newer.** MetaHarness runs its TypeScript sources directly.
- **git 2.28 or newer.** The agents work in your repository. Version 2.28 is what lets
  MetaHarness stop agents from deleting branches.
- **At least one harness, installed and signed in:**

  | Harness | Install | Sign in |
  |---|---|---|
  | Claude Code | https://claude.com/claude-code | `claude auth login` |
  | Codex | `npm install -g @openai/codex` | `codex login` |
  | Antigravity CLI | https://antigravity.google | run `agy` once and sign in |
  | OpenCode | `npm install -g opencode-ai` | `opencode auth login` |

  MetaHarness never handles your credentials. It starts each harness the way you would, so each
  agent uses that harness's subscription. A team works best with two or three different
  providers, but one is enough to start.

## 2. Install

```sh
git clone <this repository> metaharness
cd metaharness
npm install
npm run ui:build      # builds the web app the daemon serves
npm link              # optional: puts `mh` on your PATH (otherwise use `node src/cli.ts`)
```

The examples below use `mh`.

## 3. Check your harnesses

```sh
mh doctor
```

`doctor` runs each CLI's own version, login and model commands, then lists:

- which harnesses are installed and signed in, and which models each offers;
- whether every role can run here, and on which of its backups.

To check that MetaHarness can really drive a harness, run a short live test on a cheap model.
It costs a few cents at most:

```sh
mh daemon            # in one terminal (it must be running for mh test)
mh test claude-code  # in another; likewise codex, antigravity, opencode
```

It checks:

- that the agent can reach MetaHarness's tools;
- that a message reaches it while it's working;
- that it takes a follow-up after it's done;
- that an urgent message pauses its turn between steps;
- that it reports usage and rate limits.

Each harness should pass every check, or say why not.

## 4. Set up your roles

A **role** is a kind of teammate: the harness and model it runs on, what it's good at, and its
instructions. The team picks roles by name when it spawns agents.

MetaHarness reads its config from two places, and the second wins where they overlap:

1. `~/.metaharness/`, your own defaults for every repository;
2. `<repository>/.metaharness/`, for one project.

This repository ships a set of roles, workflows and agent instructions in its own
`.metaharness/` folder. To use them in every project, copy them to your home folder:

```sh
mkdir -p ~/.metaharness
cp -r .metaharness/roles .metaharness/workflows .metaharness/methodology.md .metaharness/helper-methodology.md ~/.metaharness/
```

Then edit `~/.metaharness/roles/*.md` so each role uses a harness and model you have. `mh doctor`
lists the models. A role file looks like this:

```markdown
---
harness: codex
model: gpt-6.1-sol
fallback: claude-code/sonnet, antigravity/gemini-4-argon-medium
good_at: implementing well-specified changes quickly and cheaply
---
You implement a clearly scoped piece of work.
If the spec is unclear or seems wrong, message whoever gave it to you rather than guessing.
```

| Key | What it does |
|---|---|
| `harness` | `claude-code`, `codex`, `antigravity`, `opencode`, or a profile of yours (section 8) |
| `model` | The model on that harness, as `mh doctor` names it |
| `fallback` | Backups, best first: `harness/model`, or just `model` on the same harness. Used when the primary can't run here, or its subscription is at its limit |
| `good_at` | One line the lead reads when choosing whom to spawn |
| `helper: true` | A quick helper (like `scout`): answers one question and returns, inside its caller's turn |
| `allow` | Commands it may run without asking, Claude Code style: `Bash(npm test*), Bash(git commit*)` |
| `auto_approve: none` | Always ask you, even for read-only commands (the default approves those itself) |
| `permission_mode` | The harness's own mode, e.g. `default` for Claude Code to ask before every edit |
| `mcp` | MCP servers it needs besides MetaHarness's own, by name (section 8) |
| `workflow` | A workflow it always follows |
| `worktree: true` | Give agents in this role their own git worktree by default |

The shipped roles:

- `architect`: the default lead;
- `designer` and `explorer`: compare and explore approaches;
- `implementer`;
- `reviewer`;
- `scout`: a quick helper;
- `documenter`;
- `reporter`.

Keep the names if you can, since the workflows refer to them.

## 5. Your first goal

Start the daemon **from the repository you want the agents to work on**. They work in that
checkout, on whatever branch is checked out, so a clean working tree is easiest:

```sh
cd ~/code/my-project
mh daemon
```

In a second terminal, open the web app:

```sh
mh ui
```

`mh ui` opens the app in your browser and signs you in with the daemon's token, which lives in
`~/.metaharness/token`. Click **New goal** and describe what you want, as you would to a
colleague. Leave the lead as `architect`, and leave the workflow on "let the lead choose" or
pick one:

| Workflow | When |
|---|---|
| `feature` | The approach is clear: design it, then build it |
| `feature-explore` | It isn't: explore two or three approaches, let a designer settle one, then build |
| `implementation` | A design exists: split it, build the pieces (in parallel when they're independent), review, merge |

You can also start a goal from the terminal: `mh run "Add per-user rate limiting to
/api/upload" --workflow feature`.

What happens next:

1. The lead reads the code and writes a design to the **shared folder**. If the workflow says
   so, it asks you to approve the design: a **decision** appears in your Inbox.
2. It spawns implementers. When pieces are built in parallel, each implementer gets its own
   **git worktree** and branch (`mh/<goal>/<agent>`), so they don't step on each other.
3. Teammates message each other as they go: questions, answers, "I changed the API, here's
   the commit".
4. Reviewers check the work. The lead merges the branches into your checked-out branch.
5. The lead calls `done`, and its note lands in your Inbox: what changed, where it is, and
   whether anything is left unmerged. The worktrees and merged branches are then removed.

You review the result in your checkout like any other change, and push it yourself.

## 6. Steering the team

**The web app** shows four things:

- **Team** (left): who spawned whom, with each agent's state, status line, cost and context use.
  A `!` badge means an agent is waiting for your approval.
- **Inbox** (left, below the team): everything waiting for you.
  - **Approvals:** a command an agent wants to run. Approve, or deny with a reason.
  - **Decisions:** "approve this design". Approve, or send it back saying what to change.
  - **Questions:** answer in the box.
  - **Results:** an agent finished. Clear it, or reply to send a follow-up.
- **Center tabs:**
  - **Activity:** everything that happens, as it happens.
  - **Graph:** who talks to whom, and who writes which shared file.
  - **Sequence:** messages in order.
  - **Timeline:** who was working or waiting, and when.
- **Agent** (right): the selected agent's live stream (what it says, its commands and their
  output, its messages), its brief and full prompt, and its controls.

**Talking to an agent:** select it and type in the message box. The message reaches it while it
works, without stopping it. Tick **Urgent** to pause its turn between steps (never in the middle
of a command) and deliver the message at once.

**Controls:**

| Control | Effect |
|---|---|
| Pause / Resume | It stops after its current step, and messages wait. Resume tells it to carry on |
| Stop | Ends the agent; whoever spawned it is told |
| Open in harness | The command to open its session in the harness itself, e.g. `claude --resume …` (pause it first) |
| + Helper, + Agent | Start an agent yourself; its result comes to you, or to the agent you pick |
| Pause all, End goal | The same for the whole goal; ending it also cleans up its worktrees |

The terminal can do all of this too:

- `mh status`, `mh tail`
- `mh send impl-1 "…" [--urgent]`
- `mh approve <id> [note]`, `mh deny <id> [reason]`
- `mh pause|resume [agent]`, `mh stop <agent>`, `mh end`
- `mh spawn <role> "<brief>"`, `mh open <agent>`

## 7. What agents can and can't do

- **Approvals.** Commands that only read (`git log`, `grep`, `cat`, and so on) run without asking.
  So do edits inside the agent's own folder, and anything its role's `allow` list covers. Anything
  else waits in your Inbox. Each harness keeps its own sandbox on top.
- **Git.** Agents commit, merge and branch freely, but they can only add history. Git itself (a
  hook MetaHarness sets for agents only, never for you) refuses these:
  - deleting branches or tags;
  - rewinding a branch that isn't theirs (`reset --hard`, `--amend`, `branch -f`);
  - pushing. You push.

  In your checkout, which teammates share, commands that throw away uncommitted changes are
  refused too (`reset --hard`, `checkout -- .`, `restore`, `clean`).
- **Cleanup.** When a goal ends, MetaHarness removes its worktrees and the branches already
  merged into your branch. Anything with uncommitted or unmerged work is kept and listed in the
  lead's note. Remove it yourself when you're sure: `mh clean <goal> --force`.
- **Dependencies.** A worktree gets a hard-linked copy of your `node_modules` (and `vendor`), so
  tests run without installing. An agent that reinstalls only touches its copy.
- **The shared folder** (`~/.metaharness/goals/<goal>/shared/`) holds designs, notes and
  reports. Every version of every file is kept in `shared/.history/`. When a teammate changes a
  file, the others are told the next time anything reaches them.
- **Rate limits.** Near a subscription's limit, agents are asked to write notes. At the limit,
  they wait for a reset that's close, or move to a backup from their role's `fallback`, picking
  up from a handoff.

## 8. Tailoring it

- **Workflows** are plain guides the lead follows: `.metaharness/workflows/<name>.md`, with a
  `good_at:` line at the top. A workflow can stop for your decision, and hand on to another
  workflow. Copy one of the shipped ones to start.
- **Agent instructions.** `methodology.md` is what every agent reads about working on a team;
  `helper-methodology.md` is for quick helpers. Edit them in either config folder.
- **MCP servers.** A role names what it needs, for example `mcp: blender`. Each name is looked
  up in `~/.metaharness/mcp.json`, in the format every harness uses
  (`{"mcpServers": {"blender": {"command": "…", "args": […]}}}`), else among the servers that
  role's harness already has. `mh doctor` lists names that don't resolve.
- **Other harnesses.** A harness that speaks a protocol MetaHarness knows is a profile file, not
  code: `.metaharness/harnesses/<id>.md`. For an ACP harness (Gemini CLI, Goose, Qwen Code,
  Kimi and others), something like this; the flag that starts ACP mode, and the command that
  resumes a session, are in each CLI's own docs:

  ```markdown
  ---
  title: Goose
  bin: goose
  transport: acp
  args: acp
  open_cmd: goose session --resume {id}
  ---
  ```

  Check it with `mh doctor` and `mh test <id>`. Setting `MH_ACP_LOG=/tmp/acp.log` on the daemon
  records the traffic if something's off. Other keys: `env` (`KEY=value, …`, e.g. to point
  Claude Code at another provider), `status_cmd`, `models_cmd` or `models`, `probe_model`.
- **Cost.** Claude Code and OpenCode report cost. For Codex, add
  `.metaharness/prices.json` with each model's USD price per million tokens, for example
  `{"gpt-6.1-sol": {"input": 1.25, "cachedInput": 0.125, "output": 10}}` (use the real prices).

## 9. Restarts

Stopping the daemon (Ctrl-C) doesn't lose the goal: everything is in an event log
(`~/.metaharness/mh.db`). Start it again from the same repository:

- Agents that were mid-turn resume their sessions, told what happened.
- Finished or idle agents resume when someone messages them.
- `mh daemon --no-resume` skips this.

Finished goals stay in the app's goal list, rebuilt from the log.

## 10. When something's off

| Symptom | Try |
|---|---|
| `mh doctor` says a harness isn't installed, but it is | Its folder isn't on the daemon's PATH (OpenCode installs to `~/.opencode/bin`). Start the daemon from a shell where `which <bin>` works |
| A role "can't run here" | Its harness isn't signed in, or the model isn't offered: fix `harness:`/`model:` or add a `fallback:` |
| "No roles are defined yet" | Section 4: roles go in `~/.metaharness/roles/` or the repository's `.metaharness/roles/` |
| The web app says it isn't built | `npm run ui:build` in the MetaHarness folder |
| The web app asks for a token | Open it with `mh ui`, or paste the contents of `~/.metaharness/token` |
| Lots of approvals for harmless commands | Add them to the role's `allow:` list |
| An agent seems stuck | Its stream in the app shows its last command. Message it, mark it urgent, or pause and resume it |
| A harness misbehaves | `mh test <harness>` says which part works and which doesn't |

## Reference

| | |
|---|---|
| `MH_HOME` | Where goals, the event log and the token live (default `~/.metaharness`) |
| `MH_PORT` | The daemon's port (default 7777) |
| `~/.metaharness/goals/<goal>/` | `shared/` (and `.history/`), `worktrees/`, each agent's harness config |
| `mh help` | Every command |
| `npm run ui:dev` | The web app with hot reload, for working on it, talking to a running daemon |
