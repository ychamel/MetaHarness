# MetaHarness — Design v2

Our own base for running a **team of agents from different providers, each in its native
harness**, on one goal. Each model does what it's best at. They talk to each other, share work
through plain files, and you can watch and steer all of it.

> **Why not one harness?** Subagents only exist inside one vendor's harness, and moving work
> across harnesses today means pasting whole contexts. We want Opus on design, cheap GPT models
> (Sol 6.1, Luna) on well-specified implementation and docs, and Gemini on reports, all working
> on the same task and handing work over the way a human team would.

---

## 1. Principles

1. **Guide, don't enforce.** Roles, workflows and conventions are prose the agents read and
   understand. Nothing is schema-validated, and no output is ever rejected and asked for again.
2. **Smart agents, simple pipes.** The daemon starts agents, delivers messages, keeps a log and
   shows you what's happening. Planning, routing and judging quality are done by agents (and
   you).
3. **Everything is text and files.** Handoffs are markdown files in a shared folder. Agents
   already read and write files very well, so no special format is needed.
4. **Expect mistakes and absorb them.** Wrong names, forgotten steps, crashed sessions and
   missing notes all degrade gracefully. The daemon never fails a goal because of something an
   agent wrote. Only you end a goal.
5. **Observe, don't limit.** No caps on context or spending inside the system. Cost and activity
   are fully visible, any notifications are ones you configure, and you can pause anything.
6. **Build on open protocols, not products.** We use MCP (agents → us), each harness's own
   headless interface (us → agents), and git.

---

## 2. The pieces

| Piece | What it is | Form |
|---|---|---|
| **Role** | A teammate type: which harness and model (plus backups), what it's good at, how it should work | A markdown file with a few lines of front matter |
| **Workflow** | A guide for running a kind of task (who to spawn, what runs in parallel, where the human decides), followed by the lead or by a role; workflows can hand on to each other (§17) | Markdown |
| **Methodology** | House rules every agent gets: how to communicate, hand off, ask for help | One markdown file |
| **Goal** | One request plus the team working on it | Created with `mh run` or from the UI |
| **Agent** | A named instance of a role in a goal (`architect`, `impl-1`, `impl-2`…) | Backed by one harness session (resumed or replaced as needed) |
| **Shared folder** | Where the team leaves documents for each other | A plain directory every agent can read and write |
| **Messages** | Short notes between agents and you | Free text |

There are no task DAGs, contracts, acceptance gates or budgets.

---

## 3. Architecture

```
┌──────────────────────────────── UI (local web) ────────────────────────────────┐
│   Team view  ·  Conversations  ·  Shared folder  ·  Inbox  ·  Timeline  ·  Costs │
└──────────────────────────────────────▲─────────────────────────────────────────┘
                                       │ events + commands (WebSocket)
┌──────────────────────────────────── mhd ───────────────────────────────────────┐
│                                                                                 │
│   Agent manager          Message router          Event log (SQLite)            │
│   start · resume ·       deliver · hold ·        everything that happened,     │
│   respawn · nudge        piggyback · notify      append-only                   │
│                                                                                 │
│   Folder watcher         Human inbox             Worktree helper               │
│   shared/ changes →      approvals + questions   one worktree per coding agent │
│   events                 from any agent                                        │
│                                                                                 │
│   ┌─────────────────── MCP server (one identity per agent) ───────────────────┐│
│   │      team · spawn · send · wait · status · done                            ││
│   └─────▲─────────────────────▲──────────────────────▲───────────────────────┘│
│   ┌─────┴──────┐      ┌───────┴──────┐       ┌───────┴──────┐                  │
│   │ Claude     │      │ Codex        │       │ Gemini       │   adapters:      │
│   │ adapter    │      │ adapter      │       │ adapter (agy)│   thin, ~300 LOC │
│   └─────┬──────┘      └───────┬──────┘       └───────┬──────┘                  │
└─────────┼─────────────────────┼──────────────────────┼─────────────────────────┘
          ▼                     ▼                      ▼
     architect (Opus)     impl-1, impl-2 (Sol)     reporter (Gemini)
                          docs (Luna)
          │                     │                      │
          └──────── read/write ─┴──── shared/ ─────────┘
```

**Adapters** do four things: start a session (with the role prompt, the methodology, the brief
and our MCP server), stream its events into the log, deliver a message into it, and resume it.
Each one also reports which of these its harness supports, so the router knows how a message can
reach that agent.

---

## 4. Configuration: roles, methodology, workflows

Stored in `.metaharness/` in the repo, with a personal set in `~/.metaharness/` that applies
everywhere.

```markdown
<!-- .metaharness/roles/architect.md -->
---
harness: claude-code
model: claude-opus-5-5
good_at: technical design, trade-offs, performance work, reviewing hard code
---
You're the team's architect. Think about the design before anyone writes code.
Put your designs in the shared folder so implementers can read them without you.
Split work into pieces that a cheaper model could implement from the description alone.
When you review, focus on correctness and design drift, not style.
```

```markdown
<!-- .metaharness/roles/implementer.md -->
---
harness: codex
model: gpt-6.1-sol
good_at: implementing well-specified changes quickly and cheaply
---
You implement a clearly scoped piece of work in your own worktree.
If the spec is unclear or seems wrong, message whoever gave it to you rather than guessing.
```

```markdown
<!-- .metaharness/roles/scout.md — a typical quick helper -->
---
harness: codex
model: gpt-6-luna
good_at: fast, cheap lookups — searching the codebase, reading many files, summarizing what's there
---
You're a quick helper. Answer the question you were given and nothing more.
Keep the answer short. If it's long, put it in shared/ and return the path.
You can read the caller's worktree, but don't change it.
```

The `good_at` line matters most. Every agent sees the roster with these lines, so a lead picks
collaborators the way a person would, by reading what each one is good at.

```markdown
<!-- .metaharness/methodology.md — given to every agent -->
You're part of a team of AI agents from different providers working toward one goal.

- Call `team` to see who's on the team and what each role is good at.
- Long things (designs, findings, reports) go in the shared folder as markdown.
  Messages stay short and point to files. A few lines of summary at the top of a document
  helps your teammates.
- When you hand work to someone, tell them: the goal, what's already done, where to look, and
  what you'd like back.
- If something's unclear, ask the person who knows (`send`) instead of guessing.
- Post a `status` line when you start something new so the human can follow along.
- Teammates may message you while you work, so read messages when they show up. If you've been
  heads-down for a while, call `wait(0)` between steps.
- In the shared folder, write your own files (e.g. `notes/<your-name>.md`). To change someone
  else's document, message its owner instead of editing it.
- You have your own git worktree and branch. Commit there when a piece works; if someone
  depends on your code, commit early and tell them. Teammates' branches are in the same
  repository, so `git diff` or `git merge` them straight away.
- Your worktree is a fresh checkout: ignored files (dependencies, build output) aren't in it.
- For quick help (searching the codebase, reading many files, checking one thing), use
  `spawn(role, brief, quick: true)` with a fast role like `scout`. You get the answer back
  directly.
- When finished, call `done` with a short note on what you did and where it is.
```

```markdown
<!-- .metaharness/workflows/feature.md — given to the lead (playbooks/ is still read; §17) -->
---
good_at: a feature whose approach is clear: design it, then build it
---
1. Write the design to shared/design.md. Get a second opinion from a reviewer on a different
   provider if it's non-trivial.
2. If it changes the architecture, ask the human to approve it: `send` to human with
   `decision: true`, saying what to approve and where it is, then `wait` for the answer.
3. Continue with the `implementation` workflow.
```

That's the whole configuration: markdown files for roles, the methodology and workflows, plus
optional harness profiles (§16) and MCP server definitions (§17).

---

## 5. Agent tools (MCP)

Seven tools. All of them accept loose input and answer in plain language.

| Tool | What it does |
|---|---|
| `team()` | The roster: agents on this goal, their roles, what they're doing; plus roles you can spawn and what they're good at |
| `spawn(role, brief, quick?, name?, worktree?, from?)` | Start a teammate. `brief` is free text. Returns their name. With `quick: true` it starts a helper, waits, and returns the helper's answer directly (§11). With `worktree: true` (or `from`) it gets its own worktree (§9) |
| `send(to, text, urgent?, decision?)` | `to` = an agent name, a role, `lead`, `all`, or `human`. To the human with `decision: true`, it asks for an approval (§17) |
| `wait(timeout?)` | Pause until a message arrives or one of your spawned agents finishes, then return what happened |
| `status(text)` | A one-line progress update, shown in the UI and in `team()` |
| `done(note?)` | "I'm finished." The note goes to whoever spawned you. Your session stays resumable for follow-ups |
| `workflow(name?)` | Read a workflow, e.g. the one the current one says to continue with; without a name, list them (§17) |

Every tool result also says whether you have unread messages and which shared files changed
since you last looked, so agents notice them naturally.

---

## 6. How context moves (and why nothing gets dumped)

```
   architect (Opus)                    shared/                        impl-1 (Sol)
 ┌──────────────────┐   writes   ┌──────────────────┐   reads    ┌──────────────────┐
 │ designs the      │──────────▶│ design.md         │◀───────────│ starts from a    │
 │ feature          │            │ review-design.md  │            │ 6-line brief:    │
 └────────┬─────────┘            │ notes/impl-1.md   │            │ "implement part  │
          │ spawn("implementer", │ report.md         │            │  B of design.md, │
          │  "Implement part B   └──────────────────┘            │  worktree is     │
          │   of shared/design.md. Tests in tests/api.           │  ready, ping me  │
          │   Ping me with questions.")                          │  with questions" │
          └──────────────────────────────────────────────────────▶└────────┬─────────┘
                                                                           │
          ◀──────── send("architect", "Part B: sync or async client?") ────┘
          ───────── send("impl-1", "Async. Updated design.md §3.") ────────▶
```

- An agent's starting context is: **role prompt + methodology + the brief its spawner wrote**,
  plus its workflow (the goal's, if it's the lead, or its role's). Everything else it reads from the shared folder or asks
  for.
- **The spawner writes the brief.** Agents are good at briefing each other when told what a good
  brief contains (the methodology does this).
- **Ask the person who knows.** When the owner of some context is idle, the message resumes
  their session, which still has its full context. No one copies context across.
- The shared folder sits outside the worktrees (`~/.metaharness/goals/<id>/shared/`) and is
  added to each harness's allowed directories. It's ordinary files: you can open it in your
  editor, and agents use their native read/write tools on it.
- **Owners, not locks.** By convention each agent writes its own files (`notes/<name>.md`), and
  only the owner edits a shared document; others message the owner. If two agents write the
  same file anyway, nothing is lost: the folder watcher keeps every version in
  `shared/.history/`, and both writers are told about the clash.
- **Change notices.** When a shared file changes, every other agent on the goal gets a line in
  its unread notice, e.g. "design.md updated by architect, 2 min ago". Whether to re-read it is
  up to the agent.

---

## 7. Getting a message to a busy agent

MCP only works when the agent calls one of our tools. A coding agent can spend 10–20 minutes on
its own edits and shell commands without doing that, which is exactly when a parallel teammate's
"I renamed `UserDTO` → `User`" matters most. The router uses the best channel the target
agent's harness supports:

| Situation | How it's delivered |
|---|---|
| Agent is working (mid-turn) | **Straight into the running turn.** Claude Code: the message is written to its streaming input; Codex: `turn/steer`. Both are native and verified (Appendix A). **This is the main path** |
| Harness has no native channel | A hook adds the message before the agent's next model call or after its next tool call (Antigravity: `PreInvocation`, tested; Claude Code: `PostToolUse`, tested) |
| Agent is calling our tools | Unread notice attached to every tool result; it reads them via `wait(0)` |
| Agent is in `wait` | Returned immediately |
| Agent's turn has ended (idle) | Sent as a new user turn (session resumed) |
| Harness has neither | The methodology asks agents to call `wait(0)` between steps; the unread notice catches the rest |
| You mark a message urgent | Interrupt and resume with the message. Without a native interrupt, the session is killed and resumed from its ID with the message |
| Agent is done | Its session is resumed for the follow-up. If that's impossible, the message goes to its spawner with a note |

Where a hook is used, it's a few lines of glue that call the daemon. It only adds something when
there are new messages or file changes, so an agent nobody is messaging sees nothing extra.

---

## 8. Tolerating mistakes

| What goes wrong | What the system does |
|---|---|
| `spawn("reviwer", …)` | Uses the closest role if it's clear and says so; otherwise lists the roles |
| `send` to a name that doesn't exist | Matches by role or close name; otherwise tells the sender who's available |
| Agent ends its session without calling `done` | Marked *ended*; its last message is forwarded to the spawner as the note |
| `done()` with no note | Fine; its last message is used |
| Agent goes quiet for a long time | A gentle nudge ("still working? post a status"). Still silent → tell the spawner and you |
| The daemon stops or restarts | The log keeps each agent's state and native session. The next daemon, started in the same repository, rebuilds the goals whose lead hasn't finished: agents cut off mid-turn resume their sessions with a note about the restart, how their team stands and any messages they missed; finished or idle agents resume when a message reaches them. Approvals the old sessions were waiting on are dropped (the agent asks again); the human's open questions stay in the Inbox |
| Session crashes | Resume it. If that fails, start a fresh agent with the same role, the original brief, and "you're continuing X's work, see shared/ and the worktree" |
| Handoff written in an odd place or shape | Nothing breaks; the reader is an agent and the message says where to look |
| Lots of spawns or a messaging ping-pong | Shown in the UI. You can set an optional alert. It is never blocked automatically |
| Two agents waiting on each other | Both `wait` calls time out; the nudge spots the pattern and tells each one who it's waiting on |
| A provider rate limit is hit | The agent shows as *waiting (rate limited)* with the retry time and continues by itself |
| Two agents write the same shared file | Every version is kept in `shared/.history/`; both get told about the clash |
| A quick helper takes longer than expected | After the time limit, the caller gets the helper's name and a note that it's still working. The answer arrives later as a message |
| Malformed tool arguments | Parsed leniently; the error explains in plain words how to call the tool |

---

## 9. Code and git

- **The team works in the human's checkout**, on whatever branch is checked out, the way native
  subagents do (§17). Teammates see each other's changes as they're made; the methodology asks
  them to agree who edits which files and to commit only their own. `mh run` says where the team
  works, and warns about uncommitted changes the agents will see.
- **Worktrees when a workflow asks.** `spawn(..., worktree: true)`, a role with `worktree: true`,
  or `spawn(..., from: "impl-1")` gives a teammate its own worktree on `mh/<goal>/<agent>`,
  under `~/.metaharness/goals/<goal>/worktrees/`. It starts from the latest commit, or from the
  named teammate's branch, which is how a reviewer gets the code it reviews. Uncommitted work
  isn't included, so the methodology asks agents to commit before handing off.
- Agents integrate with git themselves, like a human team would. The lead merges worktree
  branches into the checked-out branch, and resolving conflicts is ordinary agent work. When the
  lead finishes, the human's note says how many commits the branch gained, what's uncommitted,
  and which worktree branches aren't merged.
- Codex sandboxes writes to the working directory, so in a worktree its writable roots also get
  the shared `.git` and the worktree's own git directory; without both, commits fail (checked
  with Codex 0.162). Claude Code's commands aren't sandboxed by default.
- `git.commit` and `git.merge` events come from polling the checked-out branch and the
  worktree branches every few seconds, so they're best effort: a fast-forward merge is
  recognised by commits already seen on another branch. Commits on the shared branch aren't
  attributed to an agent, since anyone in the folder (the human included) could have made them.
- A folder that isn't a repository, or one with no commits, gets no worktrees: everyone shares
  it, and a spawn that asks for a worktree is told so.
- **Parallel agents read each other's code through branches.** All worktrees share one git
  repository, so once impl-2 commits, impl-1 can run `git diff mh/42/impl-2` or merge it right
  away, with no push or fetch.
- When the goal is finished, you open the PR or ask the lead to.
- Later, as an option: the whole goal in its own worktree and branch, leaving the human's
  checkout alone.

---

## 10. You in the loop

- **Permissions stay native.** Each role can set its harness's own permission mode, so we don't
  build a policy engine on top. When a harness asks for approval, the adapter sends the request
  to **your Inbox** rather than leaving the agent stuck on a terminal prompt.
- **Read-only commands don't ask.** Whatever the harness, a shell command that only reads
  (`cat`, `sed -n`, `git diff`, pipes and loops of such, a `$( … )` that only reads) is approved
  by the daemon itself and logged as `approval.auto`. The check errs towards asking: writes,
  redirections, unknown programs and anything it can't parse still come to you. A role can
  opt out with `auto_approve: none`.
- **Questions:** `send("human", …)` also lands in the Inbox.
- **Steering:** you can message any agent, the lead, or everyone, and pause, resume or stop any
  of them.

---

## 11. Native subagents are off; quick spawns replace them

Adapters turn off each harness's own subagent feature: `--disallowedTools Agent` for Claude
Code, `--disable multi_agent` for Codex, and a `PreToolUse` hook that refuses the subagent tools
for Antigravity CLI. All delegation goes through MetaHarness.
That means even small helper jobs can use whichever model suits them (an Opus architect can send
a codebase search to Luna), and every one of them shows up in the UI.

For this to feel as good as a native subagent, a quick spawn has to match it on four things:

| A native subagent has… | A quick spawn gets it from… |
|---|---|
| A call that returns the answer | `spawn(role, brief, quick: true)` blocks and returns the helper's final answer as the tool result. If it takes longer than a set limit (say 2 minutes), the caller gets the helper's name instead and the answer arrives later as a message, so nobody stays blocked |
| A fast start | A **warm pool**: a few sessions per helper role, already started and waiting for a brief. Pool size is set per role and can be zero |
| The parent's working state | The helper runs **in the caller's folder**, so it sees uncommitted changes. It's read-only by default; a helper that needs to write gets its own worktree from the caller's latest commit |
| Low overhead | A shorter methodology for helpers (just "answer the brief, keep it short", none of the team rules). The session is released after answering, or kept warm for the next caller |

Helpers appear in the UI nested under the agent that called them, collapsed by default.

**Trade-offs to measure** (the metrics in §12 will show them):
- **Startup time and token overhead** per helper will be higher than for an in-process
  subagent, even with the warm pool, because every helper loads its harness's full system
  prompt.
- **Cold prompt cache.** A native subagent stays with the same provider and can benefit from its
  prompt caching. A helper in another harness starts cold. For small lookups a cheap model
  should more than make up for this, but check it with real numbers.

---

## 12. Observing and improving

Everything is logged as events: agent started/ended, every message, every tool call the harness
exposes, status lines, shared-folder changes, token usage and cost, approvals, nudges, crashes.
All of this is passive and never constrains an agent.

What you get from it:

- **Live cost and activity** per agent, role, model and goal.
- **Per role×model numbers** across goals: cost, time, how often its outputs drew review
  findings or follow-up questions, how often it needed nudging, and your optional 👍/👎 on its
  work.
- **A retrospective at the end of each goal.** A cheap agent reads the event log and the shared
  folder and writes `shared/retro.md`: which handoffs caused confusion, who got stuck, where the
  money went, and suggested edits to roles or workflows. You decide what to change.

The loop for improving is just editing markdown. You change a role's `model`, rewrite a
`good_at` line, or adjust a workflow, then compare the next runs. Trying two models for one role
side by side can come later as an optional `variants:` line.

---

## 13. Client API

The CLI and the UI are both clients of one local API served by the daemon. Anything the UI can
do, the CLI can do too, and vice versa.

### Transport

| Endpoint | Purpose |
|---|---|
| `GET /state?goal=<id>` | A snapshot computed from the log: agents, inbox, shared files, costs. Saves a client from replaying a long goal from the start |
| `WS /events?goal=<id>&since=<seq>` | Replays events after `since`, then streams new ones live. Every event has an increasing `seq`, so a client that reconnects picks up exactly where it left off |
| `POST /commands` | Every action a client can take |

The API listens on `localhost:7777` (configurable), and clients authenticate with a token
stored in `~/.metaharness/token`.

### Event envelope

```ts
type Event = {
  seq: number;          // increases by one per event; used for replay and reconnects
  ts: string;
  goal: string;
  agent?: string;       // agent name, e.g. "impl-1"
  parent?: string;      // who spawned it → hierarchy
  type: string;
  data: object;
};
```

### Events

| Group | Events | Feeds |
|---|---|---|
| Goal | `goal.started` · `goal.paused` · `goal.resumed` · `goal.recovered` {resumed, later} · `goal.ended` | Header, goal list |
| Agent lifecycle | `agent.spawned` {role, harness, model, parent, brief, quick, worktree, branch, native_session} · `agent.state` · `agent.status` {text} · `agent.done` {note} · `agent.ended` · `agent.crashed` · `agent.resumed` · `agent.respawned` | Team tree, cards |
| Activity | `agent.text` (streamed) · `agent.tool_call` {tool, summary} · `agent.tool_result` {summary, ok} · `agent.file_edit` {path, diff} | Agent detail stream |
| Messages | `message.sent` {from, to, text, urgent} · `message.delivered` {via: hook \| tool \| turn \| interrupt} · `message.read` | Graph, sequence view |
| Shared folder | `shared.write` {path, version} · `shared.read` {path} (best effort) · `shared.clash` | Graph file nodes, folder browser |
| You | `inbox.item` {kind: approval \| decision \| question \| stuck \| crash} · `inbox.resolved` · `approval.auto` | Inbox, notifications |
| Usage | `usage` {tokens_in, tokens_out, cost, context_pct?} | Costs, context bars |
| Git | `git.commit` {branch, sha, summary} · `git.merge` {from, into, sha, fastForward?} (conflicts aren't detected yet) | Git view |
| Health | `nudge.sent` · `alert` {kind: idle \| ping_pong \| context_full \| cost} | Health flags |

Agent states: `starting` · `working` · `waiting` · `idle` · `done` · `ended` · `crashed`.

### Commands

| Command | Arguments |
|---|---|
| `goal.start` | request, workflow?, lead_role? (or `human`) |
| `goal.pause` · `goal.resume` · `goal.end` | goal |
| `agent.message` | to (agent \| role \| `lead` \| `all`), text, urgent? |
| `agent.pause` · `agent.resume` · `agent.stop` | agent |
| `agent.spawn` | role, brief, parent? (none = spawned by you) |
| `inbox.resolve` | item, decision (approve \| deny), reply? |
| `goal.set_lead` | agent or `human` |
| `agent.open_native` | agent → returns the command to attach to its session in its worktree (e.g. `claude --resume <id>`) |

Pause and stop are best effort for each harness: new turns stop being delivered right away, and
the agent is interrupted if its harness supports that.

### What adapters must capture

Native session ID, harness and model · streamed text and tool calls · **reads** of shared files,
not just writes (otherwise half the information-flow edges are missing) · usage, and context
fill if the harness reports it · approval requests.

Each harness exposes some of these only partially. The adapter's capability manifest says which
ones it has, and the UI hides any field it can't fill rather than showing a misleading zero.

---

## 14. UI

A **local web app served by the daemon** (open `localhost:7777`). The CLI stays for quick checks,
scripts and SSH. If a desktop app is wanted later, it's the same web app wrapped with Tauri, and a
VS Code panel works the same way.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Goal: rate limiting  ·  $3.12  ·  5 agents (3 working)  ·  Inbox 2  ·  ⏸ Pause all     │
├───────────────────┬──────────────────────────────────────────────┬───────────────────┤
│ TEAM              │  [ Graph | Sequence | Timeline ]              │ AGENT: impl-1     │
│ ▾ architect  opus │                                               │ sol-6.1 · working │
│   ● waiting       │     architect ────spawn────▶ impl-1           │ "writing tests B" │
│   ▾ impl-1  sol   │        │  ╲                    ▲ │            │ $0.42 · ctx 38%   │
│     ● working     │        │   ╲─msg "async"──────┘ │            │───────────────────│
│     ▸ 2 helpers   │      writes                    reads          │ ▸ brief           │
│   ▸ impl-2  sol ✓ │        ▼                        │             │ ▸ Edit api.ts +12 │
│ ▸ reporter gemini │    [design.md] ◀───reads─── impl-2           │ ▸ Bash pnpm test  │
│                   │                                               │   "4 passed"      │
│ INBOX (2)         │                                               │ ← architect:      │
│ ⚠ impl-1: npm i…  │                                               │   "Async. See §3" │
│ ? lead: approve   │                                               │───────────────────│
│   design?         │                                               │ [message…] [⚡][⏸]│
└───────────────────┴──────────────────────────────────────────────┴───────────────────┘
```

### Views

| View | Shows | For |
|---|---|---|
| **Team tree** | Hierarchy; state, role, harness/model, status line, cost, context %, unread count; quick helpers nested and collapsed | All agents at a glance, who spawned whom |
| **Graph** | Agents as **cards** (name, harness · model, state, cost) and shared files as nodes. Spawn arrows, curved message lines labelled with a count (animated as messages travel), file read/write lines | How information flows, including through `shared/` |
| **Sequence** | One lane per agent, messages as arrows over time; filter by agent or pair | Who knew what, and when |
| **Timeline** | Working / waiting / idle bars per agent | Bottlenecks, e.g. three agents waiting on one |
| **Agent detail** | Live stream (text, collapsible tool calls, edits as diffs), brief + role prompt, messages in/out, files touched, worktree diff, helpers, cost; chat box; *Open in native harness* | Opening any agent and stepping in |
| **Inbox** | Approvals, questions, stuck agents, crashes; browser notifications | Stepping in |
| **Shared folder** | Files, every version, who wrote it, diffs between versions | Tracing handoffs |
| **Git** | Branch per agent, diffs, merges, conflicts | Code integration |
| **Costs** | By agent, role and model; spending rate | Spend |
| **Replay** | Time scrubber over a finished goal; every view replays | Improving roles and workflows |
| **Search** | Across streams, messages and shared files | Finding anything |
| **Goals** | Current and past goals, with retrospectives | History |

### When the team gets big

The graph keeps the card style from the console mockup at every size; it never falls back to
plain dots. To stay readable as the team grows, it borrows these from the Graph Lab:

- **Quick helpers are folded** into a count badge on the card that spawned them, and expand on
  click.
- **Sub-teams can fold** into a single card under their lead (for example "API team · 8 agents,
  5 working"), with a halo showing how busy the team is inside.
- **Focus:** clicking a card fades everything except that agent, its parent, its children and
  the agents it talked to.
- **Time window:** message lines and counts cover the last N minutes (1, 5, 15 or all).
- **Find** jumps straight to an agent, opening its team if it's folded.

The 3D "time as depth" view is dropped. A Replay view (build order step 3) shows history
instead.

### Stepping in

Message any agent, the lead, or everyone (urgent messages interrupt) · pause, resume or stop an
agent or the whole goal · spawn an agent yourself · take over as lead · approve or deny with a
reply · open an agent's session in its native harness.

### Build order

1. **Find and talk to any agent:** team tree, agent detail, messaging and controls, Inbox.
2. **See the flow:** graph, sequence, timeline.
3. **Improve over time:** replay, costs, git, shared-folder history, search.

### Tech

React + Vite. React Flow for the graph, custom SVG for the sequence and timeline views, and a
diff component. The UI loads a snapshot from `/state`, then applies live events from `/events`.

---

## 15. Stack

| Part | Choice |
|---|---|
| Daemon + CLI | TypeScript / Node (the MCP SDK is TypeScript-first; Node 26 runs TypeScript directly) |
| Storage | SQLite for events; plain files for shared folders and config |
| Agents → daemon | MCP over HTTP on localhost, one token per agent |
| Daemon → agents | Claude Code CLI in stream-json mode, `codex app-server` (JSON-RPC), Antigravity CLI (`agy`) in stream-json mode with hooks (Appendix A) |
| UI | React + Vite, served by the daemon |

---

## 16. Harnesses, accounts and setup

MetaHarness should work with whatever subscriptions a user has: one person has Claude and
Cursor, another OpenCode with an API key, another all of them. The point to start from is that
**a subscription comes with its vendor's harness**. A Claude subscription is used through Claude
Code, ChatGPT through Codex, Google through Antigravity CLI, Cursor through `cursor-agent`. So
vendor CLIs can't be avoided, but there are only a handful of them, one per subscription vendor,
and they get careful support. Open harnesses (OpenCode, Goose, Aider, and the many forks of
Claude Code and Gemini CLI, including Chinese ones like Qwen Code) are endless, so they have to
work from configuration alone.

### Transports and profiles, not one adapter per harness

An adapter splits into two parts:

- A **transport**: how we start the harness and talk to it. There are few: stream-json over
  stdio (Claude Code, `agy`, and their imitators), a JSON-RPC app server (Codex), ACP (the Agent
  Client Protocol, spoken by Gemini CLI, OpenCode, Goose and others), and a one-shot print mode
  as the last resort. Each is code.
- A **profile**: one harness on one transport. Its binary, flags, how it's given our MCP
  server, which hook format it has, how to check its login and list its models, and which rung
  of each ladder below it reaches. Profiles are data, so a new harness is usually a profile, not
  code.

Many harnesses can also be pointed at another provider's endpoint (Claude Code with
`ANTHROPIC_BASE_URL` for GLM, Kimi or DeepSeek coding plans), so a profile can carry environment
variables too.

### Ladders: the best mechanism each harness has

Every feature that matters for agents working together has several mechanisms, best first. A
profile says which ones work; the daemon uses the best one available.

| Feature | Best → fallback |
|---|---|
| Message into a running turn | native (stream input, `turn/steer`) → hook after the next tool call → unread notice on our tool results → interrupt and resume → next turn |
| Interrupt | native → kill the process and resume the session with the message |
| Approvals | native protocol or ACP `session/request_permission` → our MCP permission tool → a `PreToolUse` hook that asks the daemon → a fixed policy plus the harness's sandbox |
| Our MCP server, one identity per agent | a CLI flag → a per-session config file → a separate config directory |
| Seeing what it does | event stream → hooks that report tool calls → its transcript file → git commits only |
| Resume | native session ID → a new session built from the handoff (below) |
| Rate limits | a native usage signal (percent used, reset time) → the error when the limit hits |

**Hooks are the middle ground.** Most harnesses now have `PreToolUse`/`PostToolUse` hooks
(Claude Code, Antigravity, Cursor, Gemini CLI and its forks), and many copy Claude Code's format.
A hook is a few lines that call the daemon, and it lifts a harness with a weak transport close to
native: messages arrive within one tool call, approvals reach the Inbox, and tool calls are
visible.

**The minimum bar is MCP plus resume.** MCP lets an agent send to anyone, any time. Resume makes
everything else possible on any harness: a message waiting for the turn to end is delivered by
resuming, and an interrupt is "kill and resume with the message" when there's no native one.
Everything above that on the ladder only shortens how long a message waits.

### Roles: a primary and backups

The user sets roles up before a run: connect harnesses, see which models each offers, pick one
for each role. A role can name backups for when its model is unavailable or its subscription is
at its limit:

```markdown
---
harness: claude-code
model: opus
fallback: antigravity/claude-opus-5-5-high, codex/gpt-6-sol
---
```

The same model can often be reached through more than one harness (Antigravity offers Claude
models, for example), so a backup can be the same model by another route.

### Accounts and rate limits

Limits belong to the **account**, not the agent: three agents on one Claude subscription hit the
limit together. The daemon keeps the state of each account from whatever the harness reports. An
account is one harness login, or one quota pool when a login has several: Antigravity has
separate pools for Gemini models, Gemini 4 Argon, and Claude/GPT models, so a Gemini agent at
its limit can move to Claude on the same login. Claude Code sends `rate_limit_event`
(`allowed`, `allowed_warning`, `rejected`, utilization and reset time); Codex sends
`account/rateLimits/updated` (percent used per window, reset time) and turn errors such as
`usageLimitExceeded`; Antigravity answers `agy -p=/quota` without a model call, which the adapter
polls.

- **Near the limit** (90% by default), each agent on that account is asked to write where it is
  to `shared/notes/<name>.md` and finish its current step.
- **At the limit**, each of its agents either waits or moves. If the reset is close (15 minutes
  by default) it shows as *rate limited* with the retry time and continues by itself. Otherwise
  it moves to the first backup whose account isn't limited. With no backup, it waits.
- New spawns on a limited account go straight to a backup.
- The lead is told, so it can plan around it.

### Handoff

Moving an agent to another harness means a new native session, so the daemon writes a handoff
for it. **The handoff doesn't depend on the agent being moved**, because a limited agent may not
be able to write one. It's built from what the daemon already has: the original brief, the
messages it sent and received, its status lines, its last words, its recent tool calls, its
notes in shared/, and its branch with commits and uncommitted changes. The new session starts in
the same worktree, under the same name, with the handoff as its brief. If the agent did write
notes when warned, the handoff points to them. A context window that's nearly full uses the same
mechanism.

### Setup

Built so far: `mh doctor`, `mh test`, user profiles. Not yet: drafting profiles for unknown
harnesses, the registry, presets, and the UI for all of it.

- **`mh doctor`** finds the harnesses on this machine, their versions, whether each is signed in
  (and with which plan), and the models each offers. MetaHarness never handles credentials: it
  runs each CLI's own status command, and for sign-in it tells the user the CLI's own login
  command. That keeps it simple, safe, and inside each vendor's terms.
- **A test per harness** (`mh test <harness>`) spends a few cents to check what actually works
  with this CLI version on this machine: our MCP tool is reached, a message arrives mid-turn, a
  session resumes, usage is reported. Vendor CLIs change every few weeks, so this is also a
  regression check. The probe also refuses anything it doesn't need except its own `sleep`
  commands, and leaves nothing in the Inbox.
- **User profiles** (`.metaharness/harnesses/<id>.md`): `bin`, `transport`, `env`, `install`,
  `login`, `status_cmd`, `models_cmd` or `models`, `probe_model`. A file named after a built-in
  profile changes only what it sets, so "Claude Code on GLM" is a `claude-stream` profile with
  `ANTHROPIC_BASE_URL` in `env`.
- **Unknown harnesses** (later): the user gives a command; we try what we can detect (does it
  answer ACP `initialize`? does `--help` mention stream-json, MCP or hooks?), one of the user's
  connected models drafts a profile from the help and docs, and the test checks it. Profiles are
  plain files, so a shared registry can follow.
- **Presets** (later): from what's connected, suggest a role assignment ("you have Claude and
  ChatGPT: Opus architect and reviewer, Sol implementers") that the user then edits.

---

## 17. Proposal: workflows, specialist roles, one shared folder

**Status: built on 2026-10-18.** §2, §4, §5 and §9 are updated to match; this section keeps the
reasoning and the details.

Everything here is guidance. Workflows say how a kind of task should go, and the lead and its
teammates follow them. Nothing in the daemon checks that they do (principle 1).

### Workflows

A **workflow** is a markdown guide for one kind of task, written for whoever runs it. It names
the roles to use, what runs in parallel, when to loop, and where the human decides. Workflows
replace playbooks: `.metaharness/workflows/<name>.md`, with `playbooks/` still read for now.

```markdown
<!-- .metaharness/workflows/feature-explore.md -->
---
good_at: features where the right approach isn't clear yet
---
1. Spawn 2–4 explorers in parallel, each with a different idea or scope. Each writes
   shared/explore/<name>.md: the approach, a sketch, the risks, and what it would cost.
2. Give the designer all the explorations. The designer either asks for another round (new
   scopes, or a deeper look at one idea) or settles and writes shared/design.md.
3. Ask the human to approve the design (send to human with decision: true, pointing at
   shared/design.md). Don't start implementing until they approve; if they ask for changes,
   go back to step 2.
4. Once approved, continue with the `implementation` workflow.
```

- **Choosing one.** `mh run --workflow feature-explore`. Without one, the lead sees the list of
  workflows and their `good_at` lines, as it sees roles, and picks.
- **Chaining.** Workflows are separate files that refer to each other by name, as step 4 does.
  A new tool, `workflow(name)`, returns a workflow's text, and without a name the list. An agent
  loads the next workflow when it gets there, so only what's needed is in its context.
- **Decisions for the human.** `send(to: "human", text, decision: true)` puts a *decision* in
  the Inbox: "approve the design?", with the files it names. `mh approve <id> [note]` or
  `mh deny <id> <what to change>` answers it, and the answer reaches the asker as a message,
  which its `wait` returns. Nothing blocks the asker; the workflow tells it to wait.

### Specialist roles

A specialist is a role that brings its own tools and, if needed, its own way of working: a 3D
modeller with the Blender MCP server, a UI designer with a particular method.

```markdown
<!-- .metaharness/roles/modeler.md -->
---
harness: claude-code
model: opus
mcp: blender
workflow: blender-modeling
good_at: 3D models and scenes in Blender
---
You build 3D assets in Blender through its MCP tools...
```

- **`mcp:`** names MCP servers the role may use. Agents are otherwise kept away from the user's
  own MCP servers (§16). Names are resolved on each machine, since servers differ from machine
  to machine: first in `~/.metaharness/mcp.json` (definitions MetaHarness keeps per machine),
  then among the servers the role's harness already has configured under that name. `mh doctor`
  says which names don't resolve here.
- **`workflow:`** names a workflow the role follows. It goes into that agent's prompt, as the
  lead's workflow goes into the lead's.

### One shared folder by default; worktrees when a workflow asks

Agents work the way native subagents do: **in one folder, the human's checkout** (the repository
the daemon runs in), on whatever branch is checked out. They see each other's changes as soon as
they're made, which is what a designer working next to an architect needs. Most work needs
nothing more.

- **Worktrees on request.** `spawn(..., worktree: true)` gives a teammate its own worktree on
  `mh/<goal>/<name>`, starting from the latest commit or from `from`. Workflows say when, e.g.
  "implementers working in parallel each get a worktree; merge their branches when done". A
  role can make it its default with `worktree: true`.
- **Sharing a folder.** The methodology asks agents in the same folder to agree who edits which
  files, and to commit only their own changes. A workflow that runs several code writers at once
  gives them worktrees instead.
- **Merging.** Worktree branches are merged into the checked-out branch by the lead, so the
  result is where the human is working.
- **The human's own edits.** The team works in the human's checkout, so `mh run` says so, and
  warns if there are uncommitted changes the agents will see and may touch.
- **Later**, as an option: the whole goal in its own worktree and branch (`mh/<goal>/main`, as
  before), leaving the human's checkout alone.
- Quick helpers are unchanged: they work in their caller's folder.

### What changes

| Area | Change |
|---|---|
| Config | `workflows/` (plus `playbooks/` for now); roles get `mcp:`, `workflow:`, `worktree:` |
| Tools | `workflow(name?)` (a seventh tool); `send` takes `decision`; `spawn` takes `worktree` |
| Daemon | Agents start in the goal's folder unless asked for a worktree; decisions in the Inbox; per-role MCP servers for each adapter (Claude Code: added to `--mcp-config`; Codex: those servers left enabled; Antigravity: added to the agent's own `mcp_config.json`) |
| CLI | `mh run --workflow`; `mh approve`/`mh deny` answer decisions; `mh doctor` checks `mcp:` names |
| Defaults | `feature-explore` and `implementation` workflows; the methodology's git section rewritten for one shared folder |

---

## 18. Plan

| Step | Scope | Done when |
|---|---|---|
| **0 — A small team works** | Daemon, event log, Claude and Codex adapters, the 6 tools, shared folder, roles + methodology, Client API (§13) with the CLI as its first client, **mid-turn message delivery (Claude Code streaming input, Codex `turn/steer`)**, approvals via our MCP tool and Codex approval requests, a Codex price table, a fake adapter for tests, quick spawns (helper runs in the caller's worktree, answer returned inline), native subagents off in Claude Code and Codex, CLI (`mh run`, `mh status`, `mh tail`, `mh send`) | Opus, as lead, designs a real change, briefs a Sol implementer, answers its question, and reviews its code, with all handoffs through shared/ |
| **1 — Real use** | Antigravity CLI adapter for Gemini (stream-json; test mid-turn delivery first), rate-limit handling, daemon restart recovery (resume sessions from their saved IDs), warm pool for helper roles, native subagents off in Gemini, worktrees, change notices + `shared/.history/`, playbooks, approvals routed to a CLI inbox, nudges, crash resume/respawn, Luna docs + Gemini report roles | Two implementers work in parallel on dependent pieces and adjust to each other's changes; you use it for your own day-to-day work |
| **2 — UI** | §14 build order 1–2 | You stop needing the CLI |
| **3 — Improve** | Role×model stats, retrospectives, optional variants, §14 build order 3 (replay, costs, git, search) | A role or workflow gets better because of what a retrospective showed |

**Sanity check at the end of step 1:** run a handful of real tasks two ways: Opus alone in
Claude Code, and the team. Compare result quality, cost, time, and how often you had to step in.

---

## 19. Open questions

1. Can you act as the lead (spawning and briefing agents from the UI), or is the lead always an agent? Probably both.
2. Should the shared folder be committed with the code at the end (design docs, reports), or stay outside the repo?
3. How long should finished agents stay resumable for follow-up questions before being released?
4. Is one goal at a time enough at first, or are parallel goals needed early?
5. How many warm helper sessions should each role keep, and does an idle harness process cost
   anything beyond memory?

---

## Appendix A. Harness capabilities (checked 2026-10-17, Antigravity 2026-10-18)

Checked on this machine against Claude Code 2.1.284, Codex CLI 0.162.1 and Antigravity CLI
(`agy`) 1.4.1, using help output, the Codex app-server protocol schema, the documentation built
into the `agy` binary, and live tests on cheap models. `mh test` re-checks the main rows on any
machine (last run: all three pass every check). (Antigravity CLI replaced Gemini CLI.)

| Need | Claude Code | Codex | Antigravity CLI (`agy`) |
|---|---|---|---|
| Headless control | `claude -p --input-format stream-json --output-format stream-json` ✅ tested | `codex app-server`: JSON-RPC over stdio (105 methods) ✅ | `agy --input-format stream-json --output-format stream-json -p=` ✅ tested. `-p` takes the prompt as its value, so it gets an empty one; input lines are `{"event":"user","message":{"role":"user","content":…}}`; output is `init`, `step_update` (text deltas, tool steps) and one `result` per turn. Works without a terminal |
| Role prompt | `--append-system-prompt` | `developerInstructions` on `thread/start` | An always-on rule in the agent's own customization root (below); also in the first message |
| Attach our MCP server | `--mcp-config` (+ `--strict-mcp-config`) | `config` override on `thread/start`: `mcp_servers.<name>.url` (streamable HTTP) | ✅ `mcp_config.json` (`{"mcpServers": {"metaharness": {"url": …}}}`) in a directory passed with `--add-dir`: every workspace is a customization root, so each agent gets its own without touching the user's config or the worktree |
| Shared folder access | `--add-dir` | `--add-dir` / sandbox writable roots | `--add-dir` |
| **Message into a running turn** | ✅ **Tested.** A message written to the streaming input mid-turn is seen in the same turn. A `PostToolUse` hook's `additionalContext` also works ✅ tested | `turn/steer` (native) ✅ tested | ✅ **Through a hook.** A line written mid-turn is queued as the next turn (tested), but a `PreInvocation` hook can add a user message before every model call (tested): the daemon hands it whatever is waiting |
| Interrupt | ✅ Interrupt control request (tested with `mh test`) | `turn/interrupt` ✅ tested | None; the daemon kills the process and resumes with `--conversation <id>` ✅ tested |
| Resume | `--resume <id>`; `--session-id <uuid>` lets us choose the ID | `thread/resume` | `--conversation <id>` ✅ tested |
| Approvals to our Inbox | `--permission-prompt-tool` pointing at a tool on our MCP server | Server requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, … | Print mode can't prompt and denies what needs permission. So: `--dangerously-skip-permissions` plus a `PreToolUse` hook that asks the daemon about every tool and answers allow or deny (deny is enforced, with our reason shown to the agent ✅ tested) |
| Turn off native subagents | `--disallowedTools Agent` (the result reports `subagent_stats`) | `--disable multi_agent` | The `PreToolUse` hook refuses `invoke_subagent`, `define_subagent`, `manage_subagents`, `browser_subagent` |
| Usage and cost | ✅ Result includes `total_cost_usd`, per-model usage and `contextWindow` | `thread/tokenUsage/updated`: tokens + `modelContextWindow`. **No cost**: we price tokens from a table | Tokens per step and per process in `result.usage` (input, output, thinking). No cost, no context window |
| Models | Aliases `opus`, `sonnet`, `haiku`, `fable`, or full IDs | `model/list` on the app server: `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, … | `agy models`: `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, plus Claude and GPT-OSS models |
| Rate-limit signal | `rate_limit_event` {status: allowed \| allowed_warning \| rejected, utilization 0–1, resetsAt, rateLimitType} (from the 2.1.284 binary's schema) | `account/rateLimits/updated` {primary/secondary: usedPercent, resetsAt; rateLimitReachedType}; turn errors `usageLimitExceeded`, `rateLimitExceeded`, `contextWindowExceeded` | `agy -p=/quota --output-format json` (no model call): remaining fraction and reset time per window, for three pools: Gemini models, Gemini 4 Argon, and Claude/GPT models. Polled every 5 minutes |
| Login status | `claude auth status` (JSON: loggedIn, authMethod, subscriptionType) | `codex login status` | No status command; `agy models` only works when signed in |
| Hooks | `PreToolUse`/`PostToolUse` in settings | Unknown | `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop` in `.agents/hooks.json`; commands run with `sh -c` and inherit agy's environment ✅ tested |

### What this changes

- **Mid-turn delivery is native** for Claude Code and Codex. Antigravity gets it through its
  `PreInvocation` hook, the middle rung of the ladder (§7, §16).
- **Codex model IDs** are `gpt-6.1-sol` and `gpt-6-luna` (§4 examples updated).
- **Approvals never need terminal scraping.** Claude Code asks a tool on our own MCP server;
  Codex sends approval requests over its protocol. Both land in the Inbox.
- **Codex cost** is computed from a per-model price table in config.
- **Role reminders in the first message.** In the first live run, `gpt-6-luna` ignored its role
  and the methodology when they were only in its developer instructions, and just did the brief.
  The daemon now also puts a short reminder in the first user message: who the agent is, its
  role's instructions, and the tools for asking and reporting back. With that, Luna asked its
  question, took the answer, and called `done`.
- **Adapter choice.**
  - Claude Code: the CLI in stream-json mode, as tested. The Agent SDK wraps the same CLI and
    can replace it later if we need typed messages.
  - Codex: one shared `codex app-server` process, with one thread per agent.
  - Antigravity: one `agy` process per agent in print mode, with its MCP server, hooks and role
    prompt in the agent's own directory (`~/.metaharness/goals/<goal>/agents/<name>/.agents/`).
    Its hooks call the daemon at `/hook/<token>`, the same credential as MCP.
  - Each agent's MCP token goes in its server URL path, so one Codex process can host many
    agents.

### Auth and terms

Both CLIs on this machine are signed in with consumer subscriptions (claude.ai and ChatGPT
Plus), not API keys.

- **Personal use.** Driving the official CLIs through their own headless modes is what those
  modes exist for. The practical limit is **subscription rate limits**, which cap how many agents
  can run in parallel. The daemon treats a rate-limit error as *waiting (rate limited)* with a
  retry time, never as a crash.
- **Distribution.** Anthropic's Agent SDK docs say third-party products may not offer claude.ai
  login without approval, and point to API keys. Before shipping to anyone else, switch to API
  keys (or each user's own login where the provider allows it) and re-check each provider's
  terms.
