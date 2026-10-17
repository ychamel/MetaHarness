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

1. **Guide, don't enforce.** Roles, playbooks and conventions are prose the agents read and
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
| **Role** | A teammate type: which harness and model, what it's good at, how it should work | A markdown file with three lines of front matter |
| **Playbook** | A suggested way to run a kind of goal, written for the lead agent | Markdown |
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

## 4. Configuration: roles, methodology, playbooks

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
<!-- .metaharness/playbooks/feature.md — given to the lead -->
Suggested flow for a feature. Adapt it to the task, and skip steps that don't apply.

1. Write the design to shared/design.md. Get a second opinion from a reviewer on a different
   provider if the design is non-trivial.
2. Ask the human to look at the design before code is written if it changes architecture.
3. Spawn implementers for the independent pieces. Give each one a brief that points to the
   design.
4. Have the code reviewed by someone other than its author. Send findings back to the
   implementer.
5. Ask the documenter to update docs and the reporter to write shared/report.md for the human.
```

That's the whole configuration: three kinds of markdown files.

---

## 5. Agent tools (MCP)

Six tools. All of them accept loose input and answer in plain language.

| Tool | What it does |
|---|---|
| `team()` | The roster: agents on this goal, their roles, what they're doing; plus roles you can spawn and what they're good at |
| `spawn(role, brief, quick?, name?)` | Start a teammate. `brief` is free text. Returns their name. With `quick: true` it starts a helper, waits, and returns the helper's answer directly (§11) |
| `send(to, text)` | `to` = an agent name, a role, `lead`, `all`, or `human` |
| `wait(timeout?)` | Pause until a message arrives or one of your spawned agents finishes, then return what happened |
| `status(text)` | A one-line progress update, shown in the UI and in `team()` |
| `done(note?)` | "I'm finished." The note goes to whoever spawned you. Your session stays resumable for follow-ups |

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
  plus the playbook if it's the lead. Everything else it reads from the shared folder or asks
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
| Harness has no native channel | A hook adds the message to the agent's context after its next tool call (Claude Code supports this; Antigravity CLI has hooks too, untested) |
| Agent is calling our tools | Unread notice attached to every tool result; it reads them via `wait(0)` |
| Agent is in `wait` | Returned immediately |
| Agent's turn has ended (idle) | Sent as a new user turn (session resumed) |
| Harness has neither | The methodology asks agents to call `wait(0)` between steps; the unread notice catches the rest |
| You mark a message urgent | Interrupt and resume with the message, if the harness supports it |
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

- Every agent except quick helpers gets its own **git worktree** on a branch `mh/<goal>/<agent>`,
  under `~/.metaharness/goals/<goal>/worktrees/`, so agents never overwrite each other's files.
  This is plumbing for safety, not a rule on behaviour. The human's own checkout isn't touched.
- The **goal branch** is `mh/<goal>/main`, and it's the lead's branch: it starts from the commit
  the human was on. (Git can't have a branch `mh/<goal>` next to branches under `mh/<goal>/`.)
- A new agent's branch starts from its spawner's latest commit, or from a teammate's with
  `spawn(..., from: "impl-1")`, which is how a reviewer gets the code it reviews. Uncommitted
  work isn't included, so the methodology asks agents to commit before handing off.
- Agents integrate with git themselves, like a human team would. The lead merges branches into
  the goal branch, and resolving conflicts is ordinary agent work. When the lead finishes, the
  human's note says how far the goal branch got and which branches aren't merged into it.
- Codex sandboxes writes to the working directory, so its writable roots also get the shared
  `.git` and the worktree's own git directory; without both, commits fail (checked with Codex
  0.162). Claude Code's commands aren't sandboxed by default.
- `git.commit` and `git.merge` events come from polling the goal's branch tips every few
  seconds, so they're best effort: a fast-forward merge is recognised by commits already seen on
  another branch.
- A repository with no commits, or a folder that isn't one, gets no worktrees: everyone shares
  the folder, and the lead is told to run one implementer at a time. If the human's checkout has
  uncommitted changes, `mh run` warns that the agents won't see them.
- **Parallel agents read each other's code through branches.** All worktrees share one git
  repository, so once impl-2 commits, impl-1 can run `git diff mh/42/impl-2` or merge it right
  away, with no push or fetch. The methodology asks agents to commit early when someone depends
  on their code.
- Agents that don't write code (reporter, researcher) can run in a read-only checkout.
- When the goal is finished, you open the PR or ask the lead to.

---

## 10. You in the loop

- **Permissions stay native.** Each role can set its harness's own permission mode, so we don't
  build a policy engine on top. When a harness asks for approval, the adapter sends the request
  to **your Inbox** rather than leaving the agent stuck on a terminal prompt.
- **Questions:** `send("human", …)` also lands in the Inbox.
- **Steering:** you can message any agent, the lead, or everyone, and pause, resume or stop any
  of them.

---

## 11. Native subagents are off; quick spawns replace them

Adapters turn off each harness's own subagent feature: `--disallowedTools Agent` for Claude
Code, `--disable multi_agent` for Codex, and the Antigravity CLI equivalent if it has one. All delegation goes through MetaHarness.
That means even small helper jobs can use whichever model suits them (an Opus architect can send
a codebase search to Luna), and every one of them shows up in the UI.

For this to feel as good as a native subagent, a quick spawn has to match it on four things:

| A native subagent has… | A quick spawn gets it from… |
|---|---|
| A call that returns the answer | `spawn(role, brief, quick: true)` blocks and returns the helper's final answer as the tool result. If it takes longer than a set limit (say 2 minutes), the caller gets the helper's name instead and the answer arrives later as a message, so nobody stays blocked |
| A fast start | A **warm pool**: a few sessions per helper role, already started and waiting for a brief. Pool size is set per role and can be zero |
| The parent's working state | The helper runs **in the caller's worktree**, so it sees uncommitted changes. It's read-only by default; a helper that needs to write gets its own worktree from the caller's latest commit |
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
  money went, and suggested edits to roles or playbooks. You decide what to change.

The loop for improving is just editing markdown. You change a role's `model`, rewrite a
`good_at` line, or adjust a playbook, then compare the next runs. Trying two models for one role
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
| Goal | `goal.started` · `goal.paused` · `goal.resumed` · `goal.ended` | Header, goal list |
| Agent lifecycle | `agent.spawned` {role, harness, model, parent, brief, quick, worktree, branch, native_session} · `agent.state` · `agent.status` {text} · `agent.done` {note} · `agent.ended` · `agent.crashed` · `agent.resumed` · `agent.respawned` | Team tree, cards |
| Activity | `agent.text` (streamed) · `agent.tool_call` {tool, summary} · `agent.tool_result` {summary, ok} · `agent.file_edit` {path, diff} | Agent detail stream |
| Messages | `message.sent` {from, to, text, urgent} · `message.delivered` {via: hook \| tool \| turn \| interrupt} · `message.read` | Graph, sequence view |
| Shared folder | `shared.write` {path, version} · `shared.read` {path} (best effort) · `shared.clash` | Graph file nodes, folder browser |
| You | `inbox.item` {kind: approval \| question \| stuck \| crash} · `inbox.resolved` | Inbox, notifications |
| Usage | `usage` {tokens_in, tokens_out, cost, context_pct?} | Costs, context bars |
| Git | `git.commit` {branch, sha, summary} · `git.merge` {from, into, sha, fastForward?} (conflicts aren't detected yet) | Git view |
| Health | `nudge.sent` · `alert` {kind: idle \| ping_pong \| context_full \| cost} | Health flags |

Agent states: `starting` · `working` · `waiting` · `idle` · `done` · `ended` · `crashed`.

### Commands

| Command | Arguments |
|---|---|
| `goal.start` | request, playbook?, lead_role? (or `human`) |
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
| **Replay** | Time scrubber over a finished goal; every view replays | Improving roles and playbooks |
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
| Daemon → agents | Claude Code CLI in stream-json mode, `codex app-server` (JSON-RPC), Antigravity CLI (`agy`) in stream-json mode for Gemini (Appendix A) |
| UI | React + Vite, served by the daemon |

---

## 16. Plan

| Step | Scope | Done when |
|---|---|---|
| **0 — A small team works** | Daemon, event log, Claude and Codex adapters, the 6 tools, shared folder, roles + methodology, Client API (§13) with the CLI as its first client, **mid-turn message delivery (Claude Code streaming input, Codex `turn/steer`)**, approvals via our MCP tool and Codex approval requests, a Codex price table, a fake adapter for tests, quick spawns (helper runs in the caller's worktree, answer returned inline), native subagents off in Claude Code and Codex, CLI (`mh run`, `mh status`, `mh tail`, `mh send`) | Opus, as lead, designs a real change, briefs a Sol implementer, answers its question, and reviews its code, with all handoffs through shared/ |
| **1 — Real use** | Antigravity CLI adapter for Gemini (stream-json; test mid-turn delivery first), rate-limit handling, daemon restart recovery (resume sessions from their saved IDs), warm pool for helper roles, native subagents off in Gemini, worktrees, change notices + `shared/.history/`, playbooks, approvals routed to a CLI inbox, nudges, crash resume/respawn, Luna docs + Gemini report roles | Two implementers work in parallel on dependent pieces and adjust to each other's changes; you use it for your own day-to-day work |
| **2 — UI** | §14 build order 1–2 | You stop needing the CLI |
| **3 — Improve** | Role×model stats, retrospectives, optional variants, §14 build order 3 (replay, costs, git, search) | A role or playbook gets better because of what a retrospective showed |

**Sanity check at the end of step 1:** run a handful of real tasks two ways: Opus alone in
Claude Code, and the team. Compare result quality, cost, time, and how often you had to step in.

---

## 17. Open questions

1. Can you act as the lead (spawning and briefing agents from the UI), or is the lead always an agent? Probably both.
2. Should the shared folder be committed with the code at the end (design docs, reports), or stay outside the repo?
3. How long should finished agents stay resumable for follow-up questions before being released?
4. Is one goal at a time enough at first, or are parallel goals needed early?
5. How many warm helper sessions should each role keep, and does an idle harness process cost
   anything beyond memory?

---

## Appendix A. Harness capabilities (checked 2026-10-17)

Checked on this machine against Claude Code 2.1.284, Codex CLI 0.162.1 and Antigravity CLI
(`agy`) 1.4.0, using help output, the Codex app-server protocol schema, and live tests on a cheap
model. The Antigravity column is from `agy --help` only, with no live tests yet; it must be
tested before milestone 1. (Antigravity CLI replaced Gemini CLI.)

| Need | Claude Code | Codex | Antigravity CLI (`agy`, help only) |
|---|---|---|---|
| Headless control | `claude -p --input-format stream-json --output-format stream-json` ✅ tested | `codex app-server`: JSON-RPC over stdio (105 methods) ✅ | `agy -p --input-format stream-json --output-format stream-json`. A community report says `-p` prints nothing without a terminal: test it |
| Role prompt | `--append-system-prompt` | `developerInstructions` on `thread/start` | `--agent` (a custom agent definition); no system-prompt flag (test) |
| Attach our MCP server | `--mcp-config` (+ `--strict-mcp-config`) | `config` override on `thread/start`: `mcp_servers.<name>.url` (streamable HTTP) | `agy mcp add` (global config, so per-agent tokens need care: test) |
| Shared folder access | `--add-dir` | `--add-dir` / sandbox writable roots | `--add-dir` |
| **Message into a running turn** | ✅ **Tested.** A message written to the streaming input mid-turn is seen in the same turn. A `PostToolUse` hook's `additionalContext` also works ✅ tested | `turn/steer` (native) | Help says stream-json "runs a turn for each" message, which probably means queued for the next turn. Has hooks: test whether they can add context |
| Interrupt | Interrupt control in streaming mode (confirm in milestone 0) | `turn/interrupt` | Unknown (test) |
| Resume | `--resume <id>`; `--session-id <uuid>` lets us choose the ID | `thread/resume` | `--conversation <id>` |
| Approvals to our Inbox | `--permission-prompt-tool` pointing at a tool on our MCP server | Server requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, … | Unknown; `--mode accept-edits` and `--sandbox` limit what needs approval (test) |
| Turn off native subagents | `--disallowedTools Agent` (the result reports `subagent_stats`) | `--disable multi_agent` | Unknown (test) |
| Usage and cost | ✅ Result includes `total_cost_usd`, per-model usage and `contextWindow` | `thread/tokenUsage/updated`: tokens + `modelContextWindow`. **No cost**: we price tokens from a table | Unknown (check the stream-json result) |
| Models | Aliases `opus`, `sonnet`, `haiku`, `fable`, or full IDs | `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, … | `gemini-4-argon-{low,medium,high}`, `gemini-3.8-flash-{low,medium,high}`, plus Claude and GPT-OSS models |
| Rate-limit signal | Verify | `account/rateLimits/updated` | Verify |

### What this changes

- **Mid-turn delivery is native** for both milestone-0 harnesses. Hooks are now only a fallback
  (§7).
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
