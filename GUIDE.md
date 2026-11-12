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

The quickest way is one line. It checks Node and git (and says how to install them if they're
missing), downloads MetaHarness to `~/metaharness`, builds it, puts `mh` on your PATH and runs
`mh doctor`:

```sh
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/ychamel/MetaHarness/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/ychamel/MetaHarness/main/install.ps1 | iex
```

Run it again later to update. Or do it by hand:

```sh
git clone <this repository> metaharness
cd metaharness
npm install
npm run ui:build      # builds the web app the daemon serves
npm link              # optional: puts `mh` on your PATH (otherwise use `node src/cli.ts`)
```

The examples below use `mh`.

`mh daemon` starts MetaHarness again by itself when you press **Restart now** in the app, which
it offers after an update: a running MetaHarness keeps the code it started with until then.

**New to coding?** Turn on *Setup → Settings → How the team talks to you*. Agents then write to
you in plain words and give you choices as buttons, approvals say what a command does before
showing it, the app explains its terms when you hover them, and a finished goal ends with a
summary of what changed, how to try it, and an **Undo this goal** button.

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

Then make each role use a harness and model you have. The easiest way is the web app's
**Roles** page (section 5 shows how to open it): pick a role, choose its harness and model
(**List … models** asks the harness what it offers), and save it to the project you're in or to your
personal folder. `mh doctor` lists the models too. Roles are plain files, so you can also edit
`~/.metaharness/roles/*.md` by hand. A role file looks like this:

```markdown
---
harness: codex
model: gpt-6.1-sol
effort: medium
fallback: claude-code/sonnet, antigravity/gemini-4-argon@high
good_at: implementing well-specified changes quickly and cheaply
---
You implement a clearly scoped piece of work.
If the spec is unclear or seems wrong, message whoever gave it to you rather than guessing.
```

| Key | What it does |
|---|---|
| `harness` | `claude-code`, `codex`, `antigravity`, `opencode`, or a profile of yours (section 8) |
| `model` | The model on that harness, as `mh doctor` names it |
| `effort` | How hard it thinks: `low`, `medium`, `high`, `xhigh`, `max` (Codex also has `ultra`). Each harness takes the nearest level it has; empty means the harness's default. It's apart from the model, so one price per model covers every effort. Antigravity's `-low`/`-medium`/`-high` model names still work, and the role editor shows them as a model and an effort |
| `fallback` | Backups, best first: `harness/model`, or just `model` on the same harness. Used when the primary can't run here, or its subscription is at its limit. They run at the role's effort; `codex/gpt-6-sol@high` gives one its own |
| `good_at` | One line the lead reads when choosing whom to spawn |
| `helper: true` | A quick helper (like `scout`): answers one question and returns, inside its caller's turn |
| `allow` | Commands it may run without asking, Claude Code style: `Bash(npm test*), Bash(git commit*)` |
| `auto_approve: none` | Always ask you, even for read-only commands (the default approves those itself) |
| `approvals` | `ask`, `gatekeeper`, `harness` or `allow`: who decides the rest for this role (default: the Settings page's choice, section 7) |
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

Start the daemon, from anywhere. One daemon serves every project:

```sh
mh daemon
```

Then open the folder you want the agents to work on as a **project**, the way you'd open a
folder in an editor. They work in that checkout, on whatever branch is checked out, so a clean
working tree is easiest. From a second terminal:

```sh
cd ~/code/my-project
mh project           # opens this folder (the top of its git repository) and the app on it
```

Or run `mh ui` and pick **Open folder…** on the **Projects** page: it browses the daemon's
machine, so it works the same when the daemon runs on another computer. **New project** there
makes a folder with a git repository in it; to clone one, ask the assistant (**Ask**), which
proposes the clone for you to apply. A folder with its own `.metaharness` setup (roles, MCP
servers, harness profiles, which can run programs) shows what it would run and asks you to
trust it, once.

Several projects can be open, and their goals run at the same time; the first button in the
side bar shows the project you're in and switches between them. Each project's goals, rooms
and setup are its own, and its agents work in it and nowhere else (section 7).

`mh ui` opens the app in your browser and signs you in with the daemon's token, which lives in
`~/.metaharness/token`. In a project, it opens on **Home**: click **+ New goal** and describe what you want,
as you would to a colleague. Leave the lead as `architect`, and leave the workflow on "let the
lead choose" or pick one:

| Workflow | When |
|---|---|
| `feature` | The approach is clear: design it, then build it |
| `feature-explore` | It isn't: explore two or three approaches, let a designer settle one, then build |
| `implementation` | A design exists: split it, build the pieces (in parallel when they're independent), review, merge |

You can also start a goal from the terminal, in the project's folder: `mh run "Add per-user
rate limiting to /api/upload" --workflow feature`. It opens the folder as a project first if
it isn't one yet.

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

**The web app** has a rail on the left: **Home**, **Goals**, **Rooms**, **Ask**, and
**Setup**. Setup is one page with its parts across the top: **Team** (roles, workflows,
guidelines), **Behaviour** (rules, settings) and **Machine** (harnesses, tools and skills).

- **Home:** your plan limits (with **Check now**), what needs you across every goal, how
  approvals are decided and the **I'm away** switch, what's running (goals and rooms), and your
  **lines of work**: goals and rooms grouped by what continues what (a room → its plan → the
  implementation → a review), each with what its latest step came to and buttons to go on from
  it (searchable). **+ New goal** and **+ New room** are at the top.
- **Goals** opens on the running goal (or the latest). **+ New goal** is the first button in its
  header. The goal's name beside it is a menu: other goals and **All goals…**, the full list
  with sizes on disk, where you delete the ones you're done with.
- **Going on from a goal:** a finished goal's **Outcome** (above its story) and each line of
  work on Home have **Implement**, **Review** and **Continue…**; a room has **→ Goal**, and a
  file in the **Files** tab has **New goal from this**. Each opens a new goal that continues
  it: you pick which of its documents to take along (its design or report is picked for you),
  and they're copied into the new goal's shared folder under `imported/`, so deleting the old
  goal later loses nothing. The new lead gets the old goal's outcome and is told where the
  copies are. A room's whole board, design and chat are copied the same way.
- **Files and images in a message:** anywhere you write to an agent (its conversation, **Message**,
  a room's chat, **Ask**, an answer in the Inbox), click 📎, drop files on the pane, or paste a
  screenshot. On a phone, 📎 offers the camera and your photos. Each file can be up to 100 MB. The
  agent gets the file's path and reads it with its own tools; a big image also gets a smaller copy,
  so looking at it doesn't bog the agent down. They aren't uploaded until you send. The **New goal**
  and **New room** forms take files too, and the lead has them from its first word; it passes them
  on to whoever on the team needs them.
- **Rooms:** brainstorms for getting clear and deciding (below).
- **Ask** (in the left rail, from any page): an assistant for questions about your goals and
  setup. It looks things up in the logs, shared files, costs and config. When you ask for a
  setup change, it suggests one with an **Apply** button; nothing changes until you click.
  **New conversation** starts it fresh. Its model is a role (Settings → Assistant): Codex's
  luna by default, with Claude and Antigravity backups. Under its title you can pick another
  model (from any harness that runs here) and effort for this conversation; the new model reads
  what was said so far; **Make default** saves the pick to its role, so it starts on it after
  a restart too. It works for every project: a conversation starts in the project you're in,
  and it can look at the others. It reads only, unless you switch it to **Write**: then it may
  edit files and run any command in the project, for a task you give it, and the setup
  changes it suggests are applied at once. A new conversation
  starts in read only again.
- **Goal:** the request, status, time, cost and branch in one line at the top, with how
  approvals are decided and **I'm away** while it runs. Once it's done, its **Outcome** (the
  lead's final note, the document it wrote, what to do next, and **Follow up** to ask the lead
  about it) sits above the story. Below that:
  - **Needs you** (center, highlighted): what an agent is waiting on.
    - **Approvals:** a command an agent wants to run. Approve, or deny (add a note if you like).
    - **Decisions:** "approve this design". Approve, or send it back saying what to change.
    - **Questions:** answer in the box.
  - **Team** (left): who spawned whom, with each agent's state, status line, cost and context
    use. **Updates** below it: results from agents that report to you; clear them, or follow up.
    (The lead's own report is the goal's Outcome once the goal is over.)
  - **Make room:** the buttons at the right end of the tabs show or hide the team column, the
    goal's header (its name and status move into the tab row; click it to bring the header
    back) and the agent column; **⤢** puts all three away at once, **⤡** brings them back.
    It's the same on every tab, so switching tabs never moves the page, and it's kept in your
    browser. With the agent column put away, an agent you pick (in the team, a lane's **⋯**,
    a name in the panel or in Git) slides in over the right side; **Esc** or **×** closes it,
    **Pin as a column** brings the column back.
  - **Center tabs:**
    Five tabs: **Story**, **Graph**, **Design**, **Files**, **Costs**; Story and Graph switch
    between views beside the tabs.
    - **Story** (the default): what happened, the important parts first. Who started whom,
      messages, results, commits, problems and your answers are cards; the steps in between
      (status lines, tool calls, file updates) fold into one line you can open.
    - **Design:** one screen for following the code as the team changes it, without reading
      every diff. The map shows the code as its areas, the way `ARCHITECTURE.md` describes
      them (or its folders, when there's no map); areas the map leaves out show dashed.
      - **Looking at** (the bar at the top) picks what the map shows the effect of. **Whole
        goal** compares the code when the goal started with the goal branch now; tick **with
        unmerged branches** to include the agents' committed work that hasn't been merged yet,
        merged as a picture (nothing in your checkout or their branches moves; files that would
        conflict are named). **Landings** lists each time work landed on the branch, with who
        and what. Below, each branch is a lane in its agent's colour and each commit a dot:
        click a dot to keep that commit lit (below), shift-click a second one to look at
        everything in between, click a lane's name for that agent's branch (its **⋯** opens the
        agent). The commits in what you're looking at are ringed. The lanes show up to six
        rows and scroll; drag the bar under them for more or fewer (double-click it to fit them
        again). The lens's own tools sit at the end of the same row.
      - **Layers ▾**, each on or off: **Change** tints each area by how much it changed and
        names what changed on the card (`+ class`, `~ function`, `− removed`), with its lines
        added and removed, commits, and a bar of who made them; new areas are outlined, removed
        ones show faded. **Dependencies** draws which area imports which, new arrows in blue,
        lost ones dashed, circular ones in amber. **Flows** draws the paths data takes, from
        the map's `## Flows` section. **Hotspots** rings the areas and files that may need
        attention: changed often, by several agents, used by many files, or large. **Activity**
        shows who is editing where (the last 15 minutes while the goal runs). **Fade
        unchanged** dims what the scope left alone. Your choice of layers is remembered.
      - **Click an agent's name** (beside the layers, or in the panel) to focus on it: the
        map and the lanes fade everything it didn't touch, and the panel keeps to its commits.
      - **The panel** on the right opens when you click something, or with **▤ Changes**;
        **Esc** puts it away and the map takes its room. Opened with nothing selected, it says
        what the scope holds: what changed in the
        design, its commits (point at one to light up the areas it touched; click it to keep it
        lit), hotspots, circular dependencies, the flows (click one to pick it out on the map;
        a step that names no area, or two steps with no import between them, is flagged), and
        under **The map, its history, and findings for next time**: the overview, the
        cartographer's commits, and files several agents edited, conflicts, rework, how widely
        each agent roamed and which rules fired.
      - **Click an area** for what the scope did there: its lines and commits, who made them,
        and each definition added, changed or removed. Click a definition for its code, the
        edits marked on it. Below are the area's files as a map, sized by how big they are and
        tinted by how much they changed (and by whom); click a file for its definitions (a
        changed one opens its code, its edits marked), the whole file with its edits marked,
        what it uses and what uses it. There you can also **pin a note** for the agents working there (each gets it the first time it
        touches the area), **keep it for future goals** (it becomes a rule), or message the
        team about the area.
      - **Hover a commit** in the lanes (or in the panel's list) to preview it without
        changing the scope: a card says who made it, its message, +/− and its files, and what
        it touched lights up on the map (areas, or the classes, cards and chips on Systems)
        while the rest dims. On Systems the functions it changed light up too: as rows on a
        class you look at, or listed under any other card holding them. **Files changed** in
        the panel does the same for one file (with the functions the scope changed in it).
        Colours are the same everywhere: green new, amber changed, red removed, blue selected,
        purple hovered or kept lit.
      - **Click a commit** (a dot, or one in the panel's lists) to keep it lit while you move
        around the map: look at other systems, open cards, go to the whole game, and what it
        touched stays outlined in purple, the rest only a little dimmed. It's named beside the
        scope (click the name to see it again, **×** to let it go), its dot is ringed, and the
        panel shows it: who made it, its message, the definitions it added, changed or removed,
        and its files with +/−. Hover a definition or a file there to light just that on the
        map; click a definition or a file's name for its code with the commit's edits marked,
        **↗** to go to it. **Look at only this commit** makes it the scope; **Open in Git** opens it there.
        Click the dot again, or press **Esc**, to let it go.
      - Each landing leaves a **report** in the goal's `design/reports/` folder (JSON: the
        commits, each area's share, files ranked as hotspots, circular dependencies, coupling,
        the flows checked against the imports), for a later goal or a model to analyse.
      - **Areas · Systems** (the switch at the start of the lens's tools) changes lens. **Systems**
        shows how the code runs instead of which file imports which: what calls what, which
        signals reach which handlers (the event bus between them left out), what makes objects
        of what, and who reads or writes whose state. It reads GDScript for now, tests and
        add-ons left out; its tools say how many of the calls it could follow (a call on a
        variable with no declared type can't be, and the panel lists the ones to type).
        **Links ▾** picks which kinds of link are drawn, and whether the scope's changes are
        marked. It's one canvas, laid out left to right the way control flows; what you look
        at, the route from the engine and your changes to the view float over its top, the
        chips and colours over its bottom. The panel opens for whatever you click; **▤ Changes**
        opens it on what the scope changed (its functions and files first, then where two
        systems you look at meet, then where the game starts). **Esc** puts the panel away
        first, then goes back.
        - **Code with its edits marked:** a class's panel shows its code (its whole file; an
          inner class, its own lines), and a function's its own lines, as they are, with the
          edits marked on them (and coloured by its language pack): green lines added, yellow
          lines changed (hover one for what it was), and a red line where lines were removed (hover it for them). The code opens
          scrolled to the first edit, and the head says how many of each. The edits are the kept
          commit's when it touched that code (the code shown as that commit left it), else the
          scope's. A group's or area's panel lists its changed files, each opening to its code
          the same way. **Functions it changed** (under **▤ Changes**) lists the functions the
          scope added (+), edited (~) and removed (−): click one for its panel, or, for a removed
          one, for what it was. In a kept commit's panel, **▸** opens a definition's or a file's
          code in place and **↗** goes to it. With a commit kept lit, the functions it changed
          listed under a card are links: click one for its panel.
        - **Names in the code link on:** in the code a panel shows, what the lens follows is
          coloured as its links on the canvas: calls (blue), signals emitted or connected and
          their handlers (purple), objects made (green), and other classes' state read (amber)
          or written (orange, bold). A call underlined with dots is a guess (its receiver has
          no type). Hover a name for what it is and its doc, with its card lit on the canvas;
          click it to follow: a function or signal opens its panel, an object made opens its
          class, and a variable opens its class's code at that line.
        - **Whole game:** every area as a card, the engine at the head. Each card's rows are
          its pins: one per card it links to, with how many links go each way. Autoloads much
          of the game uses (global state, audio, tables of constants) are **rails** down the
          right side instead of lines from every card; a card notes how much it uses each.
        - **Look at** something by double-clicking its card (or picking it in the search box,
          or **Look at it** in the panel): it's drawn in full, what's one step from it as
          cards, and everything else folds into **chips** along the bottom ("ui 17 · 148↔":
          classes not drawn, and their links to what is). A class you look at shows its
          functions as pins, and its lines leave from the function that makes the call or
          emits the signal; when there are too many lines they go to the card, and hovering
          or clicking a function draws its own. A group or area you look at becomes a
          **frame** with what it holds inside; lines leaving the frame leave from its edge,
          and each card inside says how many go out. Neighbours are summed as coarsely as
          still tells them apart: a class beside it, another group of its area, another area.
        - **Shift-click** (or **Add to what's looked at**) looks at several things at once.
          With two, the panel shows where they meet: what runs straight between them, and
          the classes both touch, by the way influence runs (when the ecosystem changes
          `Genome` and creatures read it, the ecosystem reaches creatures through `Genome`).
          Those classes are drawn on their own.
        - **Open a card in place** with its **▾** (on area and group cards, or **Open it here**
          in its menu): it becomes a frame with its cards inside, the lines going to the card
          inside that makes them, and nothing else on the canvas changes, the view included.
          Cards inside open too. **▴** closes it. Opened as a neighbour, it holds only what
          links to what you look at; the rest stays in the chips.
        - **Pin** the cards inside a frame you want to keep (their **📌**), then **⊖ fold the
          rest** on the frame: what isn't pinned goes on one card ("26 more, not pinned"),
          its lines with it; click that card or **⊕ show all** to bring them back. A class you
          look at works the same way with its functions: pin rows (the **📌** at a row's end),
          then **⊖** on the card draws only those.
        - **Right-click a card** (or its **⋯**) for its menu: the first line says why it's on
          the canvas ("One step from Creature (5 links)"), then what you can do with it: look
          at it, also look at it, split it into its groups or classes, fold it into what holds
          it, hide it (it joins the chips), pin it, show it in the panel. What you open, pin,
          split, fold, hide or draw from the chips is listed in a strip above the canvas, each with **×** to undo
          it, and **Undo all**. Click a chip to draw it (and anything hidden in it). **←** or
          **Esc** goes back; **Whole game** clears what's looked at.
        - **Drag a card's bottom-right corner** to resize it: taller shows more of its pins,
          wider shows what each of them links with. Sizes are kept per goal in your browser
          (**Back to its own size** in the menu). Drag cards where you like (kept per goal and
          per what's looked at; **Reset layout** puts them back).
        - **Groups:** an area with more than nine classes is split into groups of classes
          that link to each other, named after the class most of them use ("Creature +6").
          The cartographer can name them and say what each does in ARCHITECTURE.md's
          `## Systems` section (`- Foraging (FoodLeads, FoodLeadSenses) — finds food the herd
          can reach`), and a class's doc comment (`##` in GDScript) shows on its card.
        - **What the scope changed** is looked at first when the scope changed any code: the
          classes it changed (their groups or areas when there are many), each with its
          changed functions and the ones joining it to the others. The chip at the top turns
          it off. **Route from the engine** draws the shortest way the engine gets there,
          through the cards, and spells it out above the canvas ("every physics tick:
          World._physics_process → World.step → Creature.tick").
        - **Click a function** (a pin, or in the panel) and the panel traces it: **What it
          does** lists its calls, the objects it makes and the signals it emits in the order
          its lines do them, a signal going on to its handlers, each step opening into its
          own; **How it's reached** goes the other way. Hovering a step lights its card;
          clicking one brings its class onto the canvas if it isn't there; double-clicking
          traces from it. Its lines on the canvas are numbered in the order its code reaches
          them. Below are the shortest ways the engine gets to it (like a debugger's stack),
          the state of other classes it reads and writes, and its code, with the names it
          calls, emits, makes and touches linked on. **Trace it wide** puts the trace in the canvas's place.
        - **Click a line** for every place in the code behind it, by pair of classes; **Draw
          it on its own** shows the classes on each side with an arrow per pair.
        - Tick the links to draw: **Calls**, **Signals**, **Creates**, **State**.
        - **Changes in this scope** marks the links, functions and classes the scope added,
          edited or removed, and the panel lists them as sentences ("World.step calls
          FoodLeads.tick").
    - **Design → Commits** (the third lens, beside Areas and Systems): the goal branch, each
      agent's branch (merged or not, uncommitted files), and every commit and merge with who
      made it, its size, and the areas of the design it touched (click one to see it on the
      map, at that commit). Click a commit for its diff (**On the map** shows what it did to the
      design); **Whole goal** shows everything since the goal started (what a pull request
      would hold), and **Uncommitted** what's changed but not committed, in your checkout or an
      agent's worktree. An agent's commits in its **Changes** open here.
    - **Files:** the shared folder: designs, reviews and reports, rendered, images as pictures, with every version
      and who wrote it.
    - **Graph**, with its views **Map**, **Messages** and **Busy:** who talks to whom,
      messages in order, who was busy when. The graph is live: each card shows the step its agent is on and for how long,
      messages it hasn't received yet, and approvals waiting on you; a dot runs along a line as
      a message is sent, and a dashed line goes from an agent in `wait` to whoever it waits on.
      The panel beside it follows the team's messages (or everything it does); click a line
      for the whole conversation between those two, briefs and results included. Drag the
      cards to arrange them; the layout is kept for that goal.
    - **Costs:** where the money went, by agent, role or model, split into input, cache
      reads, cache writes and output.
    - **Story → Every event:** every event, as `mh tail` shows it, with filters.
  - **Agent** (right): what the selected agent is doing now (or its result), its controls, and
    its conversation (its words, messages, and its tool calls folded into groups), its
    **changes** (its commits, the files it edited, its uncommitted work), its brief, and its
    setup (prompt, folder, worktree, session).

Long texts show their first lines with **Show more**. Drag the edge between two panes (the
columns, the graph's panel, the file list, the setup lists, the assistant) to resize it; the
width is kept in this browser, and a double-click puts it back.

**Old goals:** the **Goals** page lists the project's goals, or every goal from every project, with its cost and what it
keeps on disk. Open one to read its story, files and costs again, open its shared folder in
your file manager, or delete it (one or several at once): its shared files and their history,
agents' folders and its log go, and so do worktrees and branches whose work is merged. A goal
whose worktrees hold unsaved work asks again before that is lost; one still at work must be
ended first. Commits on your branches always stay.

Agents that finished keep their process for 10 minutes in case a message comes, then let it
go; a later message resumes their session where it was.

**Talking to an agent:** select it and type in the message box. The message reaches it while it
works, without stopping it. Tick **Urgent** to pause its turn between steps (never in the middle
of a command) and deliver the message at once.

**Controls:**

| Control | Effect |
|---|---|
| Pause / Resume | It stops after its current step, and messages wait. Resume tells it to carry on |
| Stop | Ends the agent; whoever spawned it is told, unless it had already reported back |
| Respawn, Start over | On a crashed agent: starts it again under its name, resuming its session or (Start over) from a handoff. The crashed one stays as `<name>-crashed`. The lead does this for its teammates; you'll mostly need it when the lead crashes |
| Open in harness | The command to open its session in the harness itself, e.g. `claude --resume …` (pause it first) |
| + Helper, + Agent | Start an agent yourself; its result comes to you, or to the agent you pick |
| Message | To the lead, everyone, every agent in a role, or one agent |
| Pause all, End goal | The same for the whole goal; ending it also cleans up its worktrees |
| Clean up | On a finished goal: removes its worktrees and merged branches, and asks before removing unmerged work |

The terminal can do all of this too:

- `mh status`, `mh tail`
- `mh send impl-1 "…" [--urgent]`. To `all` or a role, it reaches those still going: finished agents aren't woken, and see it if something wakes them later. To wake one, use its name.
- `mh approve <id> [note]`, `mh deny <id> [reason]`
- `mh pause|resume [agent]`, `mh stop <agent>`, `mh end`
- `mh spawn <role> "<brief>"`, `mh open <agent>`
- `mh respawn <agent> [note] [--fresh] [--on <harness/model>]`

### Rooms: getting clear and deciding

A goal needs a target: once you know what you want, its workflows design, review, audit and
build it. A **room** is for before that, when you're unsure: exploring options, finding a feel
or a look, combining ideas, until you reach a decision (or just clarity). You talk with one
agent, the room's **lead**, a facilitator that offers directions, asks the question that narrows
things down and keeps a **board**; **makers** find references and make images, playable demos
and write-ups for it and for you. Nobody changes your project in a room. **+ New room** (Rooms,
Home, or a room's header): what to talk about, and the makers.

- **Makers** each make one kind of card. The built-in four: **researcher** (references from the
  web and the code), **illustrator** (images: Codex by default, Antigravity as its backup),
  **prototyper** (small playable demos) and **writer** (write-ups and ideas). They're roles like
  any other: change their models in Setup → Roles, or add your own. In the dialog each maker is
  a role or **just a model** (harness, model and effort from three lists), with a
  **responsibility** (start from Research, Illustrate, Prototype, Write, Big picture or Review;
  it says what it makes) and optionally a **stance**. Pick a saved **cast** or save the makers
  as one. A maker starts the first time it's asked and keeps what it learnt.
- **The chat** (left): you and the lead. Its replies are short; when something is worth making,
  it sends a maker, says so in a line (**→ illustrator** …), and keeps talking. A maker's answer
  shows as a line (**↩ illustrator** …; click to read it) and wakes the lead. **■ Stop** (beside
  the lead's name) cuts its turn short. A shared file named in the chat opens in the chat's place.
- **The makers** (over the board): what each makes and is doing. **■** stops one at work, **⏻**
  puts one away (**↺** brings it back), **+ Maker** adds one. An image maker whose harness can't
  generate images says **no image tool**.
- **The board:** cards of every kind (ideas, questions, sources, images, demos, write-ups,
  findings, risks, decisions, concepts) where you put them, or grouped in **frames** (Look,
  Combat…) that lay their cards out themselves. **Drag** a card to move it, onto a frame to put
  it in; drag a frame's title to move it with its cards; drag the background to pan,
  **ctrl+wheel** to zoom; **Frames…** jumps to one, **Tidy** lays the loose cards out again.
  Solid arrows are links the lead drew; dashed ones show what a card was mixed from. New cards
  glow for a few seconds.
- **Click** a card to open it beside the board: an image full size, a **demo** to play, a
  source's link, a concept's pillars with the cards each comes from. **Shift-click** picks more.
  With cards picked: **⚗ Mix…**, **Ask a maker…** (straight to it, about those cards), **Ask
  the lead**, **▢ Frame**, **⑂ Branch** (a room of its own, starting with those cards and the
  ones linked to them), **✓** settle, **✗** drop, **⟶** link two. **+ Card** and **+ Frame**
  add your own.
- **Mixing:** pick cards, **⚗ Mix…**, and say what to take from each (*its style*, *its
  combat*, *its characters*), what to make (an image, a demo, a write-up, ideas, references)
  and how many takes. Placeholders appear at once, linked to their ingredients, and the maker
  fills them. Open a result and **⚗ Remix…** to swap an ingredient or change what's taken.
  Makers you ask and mixes don't wake the lead; it hears of them with your next message.
- **Demos** are throwaway pages, played sandboxed, with **knobs**: sliders for the values that
  decide the feel (gravity, jump speed, camera lag…). When the project has the real code, the
  prototyper ports its formulas and names the knobs after the real parameters. Tune until it
  feels right, then **Keep these values**: a decision card with the numbers, which a goal
  builds to (opening it plays the demo with those values).
- **Godot demos:** in a Godot project (or when you ask), the prototyper makes a small Godot
  project instead of a page, and its card has **▶ Run in Godot**. It opens a window on the
  machine running MetaHarness, not on your phone if you're on one, and **■ Stop** closes it.
  Script errors show on the card. The tuning sliders are inside the game; tell the room what
  you want to keep. MetaHarness runs `godot` from the PATH: set `MH_GODOT` if yours is elsewhere.
- **Prototypes** are for trying several ideas separately, usually when polishing a game. Pick the
  idea cards and choose **▶ Prototype each…**, or **+ Prototype** (the lead can start them too, and
  says why it chose what it did). Each gets its own builder and its own copy, kept by MetaHarness,
  outside your project, so they all run at once without touching each other:
  - **A copy of the game** is frozen as it stands, uncommitted work included, from your checkout
    or any git worktree of it, and doesn't move after that. Ideas started together share one
    freeze, so they merge cleanly. **A small project of its own** is quicker, for a mechanic away
    from the game.
  - Open its card: **▶ Run** opens the game in a window (and reopens it after each change, unless
    you untick that), and you tell its builder what to change right there, without going through
    the lead. Each answer is a new version: go **Back to this**, or **⑂ Fork** a variation from any
    version.
  - **F10 in the game** shows the sliders. **Keep these values** there puts them on the board as a
    decision.
  - **⚗ Merge…**, with two or more prototype cards picked, makes a new one with them all in it, to
    play them together. It says first whether they merge cleanly; a builder settles conflicts.
    Expect to tune again: independent ideas can still fight each other.
  - **Verdict**: Keep, Park or Drop, and what it taught you. **→ Goal** starts a goal of its own that
    builds it for production, whatever happens to the room. It can read and play that version, and
    gets what it changed, its builder's notes and shortcuts, how it went and the values you kept.
    Prototypes cut corners, so the goal reimplements; the rule that says so is
    `prototype-handoff`, in Setup, for you to change.
  - They stay until you delete them, even after the room closes: the **Rooms** list shows them with
    what they take on disk. A new room from their cards takes them along.
- **The concept card** is the idea as it stands, pillar by pillar (look, feel, mechanics,
  story…), each pointing at the cards it comes from. The lead keeps it as things settle. Only
  you decide: decision cards are what you agreed to.
- **Where it goes** (header): **End room** when you're clear (that's an outcome too); **Write
  the design** has the lead write `room/design.md` from the board, citing its cards; **→ Goal**
  copies the room's folder into the new goal (`imported/room/`) and points its lead at the board
  (concept, decisions, kept values, demos, images) and the design; **New room from this** starts a fresh room with this board, its images and demos.
- Images and demos live in the room's shared folder (`room/media/`, `room/demos/`). Makers may
  generate images without asking in a room (you're watching; **■** stops one).
- A room's tabs are **Room**, **Files** and **Costs**. Rooms open with the team and agent columns put away; click a name to slide its panel in, or
  bring the columns back with the toggles at the top right.
- A room stays open until you close it: after a daemon restart it comes back, with its chat, board
  and makers.

## 7. What agents can and can't do

- **Their project, not the machine.** Agents read, search and change files in their project
  (or their worktree of it), the goal's shared folder and the temporary folder. Reading anywhere
  else (another project, your home folder, MetaHarness's own data) asks first, whichever harness
  they run on, and a built-in rule (`stay-in-project`) tells them so. On Codex, its sandbox also
  keeps the commands it runs by itself out of other projects and `~/.metaharness`.
- **Approvals.** Commands that only read (`git log`, `grep`, `cat`, and so on) run without asking,
  as long as what they read is in the project. So do edits inside the agent's own folder, and anything its role's `allow` list covers. Who
  decides the rest is a setting (**Settings** page, or a role's `approvals:`):
  - **Gatekeeper** (the default): a cheap model allows what stays inside the project and is part
    of the task, refuses what's plainly harmful, and sends you the rest with its reason. It's a
    role like any other: built in on Claude haiku (with Codex and Antigravity backups), and
    the Settings page writes it out as `roles/gatekeeper.md` if you want another model or
    other rules. Teams can't spawn it, and its cost counts in the goal's. When its account hits
    its limit mid-session, that session goes (anything it still says counts for nothing) and the
    request is asked again on a fresh one, which runs on a backup; only if that's limited too does
    it come to you.
  - **Ask me:** everything else waits in your Inbox.
  - **Harness's own:** Claude Code's auto mode decides first; the gatekeeper, then you, for
    what it still asks about.
  - **Allow in the project:** for when you'd approve every command anyway. Whatever stays in the
    project runs without asking. A command that names a path outside it (a redirection to
    `~/.profile`, `rm -rf ~/x`, `cd ..`) or runs as another user (`sudo`) goes to the
    gatekeeper, and what the gatekeeper won't settle goes to the goal's lead as a second eye:
    the lead answers with `send` (`allow: yes` or `no`). The lead's own requests, and those the
    lead doesn't answer within the stall time (`stallMinutes`, 10), come to you.

  Each harness keeps its own sandbox on top.
- **Finished teammates.** An agent that called `done` rests until a message to it by name wakes it, which can cost its whole context again. Messages to `all` or a role don't wake it. A spawner or the lead that won't need it again calls `dismiss`: it ends, with the finished teammates it spawned, and shows as *ended* with who dismissed it. Its files, commits and notes stay, and what it left running stops. It can't come back, so more of that work means a new teammate.
- **Away.** When you want a goal to finish without you, press **I'm away** in a goal's header
  or on Home (or `mh away`); it's for every goal, not just that one. Nothing waits on you then:
  - approvals go to the gatekeeper whatever the setting, and what it won't settle to the lead;
    the lead's own are refused (it finds another way, or leaves it for you). An approval already
    waiting when you leave is refused, so the agent asks again and someone else decides;
  - what the lead sends you still lands in your Inbox, but it's told not to wait for the answer;
    a teammate's message to you isn't sent: it's told you're away and to ask the lead instead
    (and so is a teammate whose question was already waiting when you left);
  - the `away` rule reaches the leads: decide what you can, approve the workflow's own
    approvals (a design) when they stay within the goal, write each such decision in
    `shared/decisions.md` for you to review, and park what goes beyond the goal or can't be
    undone. Edit it on the Rules page like any other.

  **I'm back** (or `mh back`) and questions and approvals reach you again. It's the daemon's
  state, so it holds across restarts and for every client.
- **Prompt caches.** An agent between tasks keeps its prompt cache warm for a while (an hour
  for Claude Code, a few minutes elsewhere); the team list counts it down. Shortly before it
  expires, the agent's spawner is told, so it can send follow-up work while it's cheap. You're
  told about the lead's.
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
- **Processes.** Each agent's CLI runs in a process group of its own; stopping the agent ends
  the group and everything under the CLI. What detached (`setsid`, a double fork, a dev server
  that backgrounds itself) still carries the agent's `MH_GOAL` and `MH_AGENT` in its
  environment, so a few seconds after the agent's session ends (stopped, crashed, or let go
  after its quiet spell) MetaHarness ends whatever still has its tag, and the goal's story says
  what. A daemon that was killed can't do this; the next one ends what its goals left running
  when it starts. `mh ps` lists what agents started that still runs, marking strays (their
  agent's session is over); `mh ps --end` ends those now. A command that comes back cut short
  (interrupted, timed out) while nothing else of its agent runs has what it started ended a
  moment later (Linux), and the agent is told: a hung test runner doesn't keep a lock for the
  rest of the session. Agents have a `procs` tool too: it lists what the team's commands run
  (whose, how long, what), and ends an agent's own, or, for the lead or their spawner, a
  teammate's. Linux and macOS; Docker containers belong to Docker and aren't found.
- **Test locks.** Every agent gets `MH_PROJECT_LOCK`, a lock file of its project's own
  (`/tmp/mh-<project>-<id>.lock`). Runs that mustn't overlap take it:
  `flock -w 1800 "$MH_PROJECT_LOCK" <test command>`. A project's goals take turns on it, and other
  projects never wait on it. Write that in roles rather than a lock path of your own: a personal
  role applies to every project, and saving one that names a project says so.
- **Dependencies.** A worktree gets a hard-linked copy of your `node_modules` (and `vendor`), so
  tests run without installing. An agent that reinstalls only touches its copy.
- **The shared folder** (`~/.metaharness/goals/<goal>/shared/`) holds designs, notes and
  reports. Every version of every file is kept in `shared/.history/`. When a teammate changes a
  file, the others are told the next time anything reaches them. Files you attach to messages go
  in its `uploads/` folder, and only whoever you sent them to is told.
- **Rate limits.** Near a subscription's limit, agents are asked to write notes. At the limit,
  they wait for a reset that's close, or move to a backup from their role's `fallback`, picking
  up from a handoff. Once the account they left frees (a limit check after its reset, or any
  turn on it reporting it's fine), they move back to their role's own harness the same way: an
  agent in a turn is asked for notes and switches after its current step, one between turns
  switches with its next message, so no extra turn is spent. A teammate respawned on a route by
  name (`on`) stays there.
- **Full contexts.** When an agent's context window is 80% full (Settings), it's asked to write
  notes, then continues in a fresh session from a handoff: the goal, its brief, what it did, its
  team and where its work is. An agent between turns switches when its next message comes, so
  it costs no extra turn. Antigravity doesn't report its context, so its own compaction applies.
- **Agents waiting on each other.** When an agent's `wait` would close a loop, with nobody left
  who could wake any of them, it's refused and the agent is told what the others are waiting
  for, so one of them says what it needs. If the same loop closes again with no real work done
  and the agent named who it's waiting on, the lead hears straight away. You hear through the
  stuck-agent reports below.
- **Stuck agents.** Agents that have only waited for 10 minutes (Settings), while the teammate
  they're waiting on is waiting too or has finished, or nobody on the team is doing anything,
  are reported to the lead, who sorts it out. You hear only when the lead has finished, or the
  team stays stuck after the lead was told; your reply goes to the lead.
- **Plan limits** on Home and on each harness's page show every window of each subscription
  (the five-hour and the weekly one, each pool on Antigravity), how full it is and when it
  resets. The daemon asks the harnesses every 10 minutes (Settings), skipping an account a
  working agent has just reported; *Check now* asks straight away. Codex and Antigravity answer
  without a turn. Claude Code's `/usage` no longer gives the windows, so a subscription is asked
  with a one-word Haiku turn (about 500 tokens), which also starts a five-hour window if none
  is running. A running goal's header shows the fullest
  window of each account its agents use.

## 8. Tailoring it

Roles, workflows, rules, skills, the agent guidelines and MCP servers each have a page under **Setup** in the
web app. Each item shows whether it lives in the project (its `.metaharness` folder) or in your personal folder, and
you choose where to save it. What you save applies to agents started from then on, without
restarting the daemon. The pages write the same files described below.

- **Workflows** are plain guides the lead follows: `.metaharness/workflows/<name>.md`, with a
  `good_at:` line at the top. A workflow can stop for your decision, and hand on to another
  workflow. Copy one of the shipped ones to start. A `roles:` line (`roles: architect,
  godot-implementer, reviewer`) names the roles it uses: the lead and the team can then start
  only those, plus quick helpers, so a growing list of roles doesn't confuse them. A workflow
  it hands on to brings its own roles; one without the line keeps every role. The line can name a
  whole folder of roles too (see Folders below). You can still start any role yourself.
- **Agent instructions.** `methodology.md` is what every agent reads about working on a team;
  `helper-methodology.md` is for quick helpers. Edit them in either config folder.
- **Rules** are short notes MetaHarness hands an agent at a moment it can see: at the start,
  when it looks at files, creates one, commits, or calls `done`. The **Rules** page lists them
  with a switch each. The built-in ones keep code clean and mapped:

  | Rule | What the agent gets |
  |---|---|
  | `conventions` | At the start: readable, well structured, scalable, plus your `CONVENTIONS.md` |
  | `map` | At the start: `ARCHITECTURE.md`, and how to find its way from it to the few files it needs |
  | `docs` | At the start: the documentation layers, what goes where, their sizes, and who keeps which |
  | `no-duplicates` | Creating a file: check that nothing already does its job |
  | `map-upkeep` | Committing new, moved or removed files without touching the map: update the README, and the map or tell the cartographer |
  | `finish-clean` | Its first `done`, if it changed files: one look over the changes and the READMEs it keeps, then `done` again |
  | `map-missing` | The lead, when there's no map: it can offer you the `map-bootstrap` workflow |
  | `cartographer` | The lead, when the goal will change code: start a cartographer |

  **The docs come in layers**, so an agent reads only what its task needs:

  | Layer | Where | Holds |
  |---|---|---|
  | The map | `ARCHITECTURE.md` | What the code is, one heading per system (its path, `## src/api/`, and a line or two: what it's for, where its behavior is defined, its README), what never to open, the commands, `## Flows` and `## Systems`. Under ~100 lines: every agent gets it at the start |
  | Runtime | `docs/RUNTIME.md` | How it runs: startup, a request's lifecycle or the game loop, who owns shared state |
  | System | a `README.md` in each system's folder | Purpose, Entry points, Where behavior is defined, Invariants and contracts, Constraints, Gotchas, Dependencies |
  | Decisions, domain | `docs/decisions/`, `docs/domain/` | Why choices were made; game design, specs, API contracts |

  An agent reads the map, picks the system, reads its README, checks whether the behavior
  lives in code, data or an editor (an editor step comes back to you as a manual step in its
  done note), names the 3 to 5 files it needs, and only then opens code. The sizes are
  suggestions in the rules, not checks: an agent prunes a doc that grows past its size, or asks
  you to raise the limit. To write the docs, start a goal with the **map-bootstrap** workflow:
  explorers write each system's README, the lead writes the map and the runtime doc (and a
  `CONVENTIONS.md` if the code has clear conventions), and you approve them before they're
  committed. All of this is the built-in rules, roles and workflows: edit them to change it.

  **Who keeps the docs.** A teammate keeps the README of each system it changes, in the same
  commit as the code. **The cartographer** keeps the rest while a team works: the map, the
  runtime doc, and the doc comments that say what each file, class and function is for (the
  Design view shows them on hover). It's a built-in role (edit or replace it on the Roles page)
  and the only agent that edits them, so they never conflict when branches merge. It documents
  what lands without a doc and rewrites a doc only when it has become wrong, never adding
  history to it. Teammates message it when their work changes the design, and it can ask them
  back. MetaHarness wakes it when work lands on the goal branch (once the branch has been
  quiet for a minute), with the commits and files that came in; it updates the map and commits
  it alone, with a one-line message saying what changed in the design. Those lines are the
  design history in the Design view. It also keeps the map's `## Flows` section, the main
  paths data takes through the systems, one per line:
  `- Checkout: src/api/ → src/orders/ → src/store/ — an order is placed and saved`; the Design
  view draws them. Turn the `cartographer` rule off to work without one. A workflow with a
  `roles:` line has to name `cartographer` for the lead to start it. To document a repository
  that has few doc comments, start a goal with the **doc-bootstrap** workflow.

  To change a built-in rule, open it and save: the copy goes into the folder you pick and
  replaces it there. To add one, write `.metaharness/rules/<name>.md`:

  ```markdown
  ---
  when: path                 # start, path, new-file, commit, done or away
  description: how handlers in src/api are written
  paths: src/api/**          # globs; !glob leaves some out
  roles: team                # all, team, helpers, lead, role names, !name
  ---
  Handlers take a request and return a response; they never touch the database directly.
  ```

  More keys: `sections:` (a file whose path sections come along), `include:` (a file whose
  text follows), `requires:` / `missing:` (only while a file exists, or doesn't), `setting:`
  (only while a setting is on, e.g. `setting: agentTools`), `changes:` and `unless_changed:` for
  commits, `edited: true` for done. To turn a rule off, flip its switch, on its row in the
  Rules list or in its editor (that writes `"rules": {"map": false}` into `settings.json`), or
  add a file of the same name with `off: true`.
- **Skills** are guides for a kind of work with files to go with them: a folder with a
  `SKILL.md`, in the format Claude Code, Codex and Antigravity share. Rules are for moments
  MetaHarness can see (a path, a new file, a commit); skills are for needs only the agent
  recognizes, like writing a migration or cutting a release, so the agent reads one when it
  decides it needs it. Agents on every harness use their `skill` tool: first a summary (what
  it's for, its sections, its files), then the one section or file they need. Put a skill in
  `.metaharness/skills/<name>/` or `~/.metaharness/skills/<name>/`; the repository's
  `.claude/skills` and `.agents/skills` count too, for every harness.

  ```markdown
  ---
  name: pdf-forms
  description: filling PDF forms with the scripts in this folder
  harness: claude-code       # optional: what it works with; !id leaves one out
  ---
  ```

  The **Tools & skills** page lists them, with a switch each. A role names the skills it
  carries under **Skills** (`skills: pdf-forms` in its file); a skill no role names goes to
  every role. Each agent's prompt names the skills it carries. To remind agents at a moment,
  give a rule a skill to point at (`skill: pdf-forms`, with `when: path` and `paths: forms/**`):
  its note names the skill when they open a form. A rule that grows long is usually better as
  a skill.
- **Tools agents make** are skills too, written by agents for their own work: a sound they
  can't hear, a scene they can't see, a job they'd otherwise do by hand. An agent asks the
  **toolsmith** for one (`send` to `toolsmith`); if the team has none, MetaHarness starts one
  with that message as its task and tells the lead. The toolsmith writes the tool in
  `.metaharness/tools/<name>/` (a `SKILL.md` saying how to run it, and its scripts) and commits
  it, and every agent can read it from then on. A lead can hand teammates the tools they'll need
  (`spawn` with `tools: ["sfx-layer"]`), and agents using a tool hear when the toolsmith
  changes it. On **Tools & skills**, *Made by agents* lists them with who made each one, for
  whom and why, what it needs (`mh doctor` checks those programs too) and how often it's read.
  **Move to my library** puts one in `~/.metaharness/tools/` for every project. Exports carry
  tools like skills. The role (`toolsmith`, Opus) and the rule that tells agents to ask
  (`tools`) are both in the default pack: edit them or turn them off like any other. Any role
  can start this way: turn on *Starts when messaged* (`on_demand: true`). If tools go wrong,
  turn off *Tools agents make* in **Settings** (`"agentTools": false`): agents stop seeing
  the library, no toolsmith starts, and the `tools` rule goes quiet. The tools stay where they
  are for when you turn it back on.
- **Personal skills stay out.** Skills you installed for yourself (in `~/.claude/skills`, your
  Codex skills, `~/.gemini/config/skills`) are hidden from agents, so every harness on a team
  has the same ones. So are each harness's own copies of the repository's skills, which come
  through the `skill` tool instead, filtered by role. Each harness's built-in skills, like
  Codex's image generation, stay. A role with `native_skills: true` (*Keep the harness's own
  skills* on the Roles page) keeps all of them, as the harness loads them.
- **Language packs** tell the Design view how to read a kind of file: its classes, functions
  and imports. Python, TypeScript, JavaScript, GDScript and Godot scenes (`.tscn`, which link a
  scene to its scripts and the scenes it instances) are built in. A pack is a folder,
  `.metaharness/languages/<name>/` or `~/.metaharness/languages/<name>/`, with a
  `language.md`:

  ```markdown
  ---
  extensions: .rb
  grammar: grammar.wasm      # a tree-sitter grammar, with queries.scm next to it
  resolve: relative, suffix  # how an import names a file: relative, dotted, res, name, suffix
  try: .rb                   # endings tried when resolving
  ---
  ```

  `queries.scm` uses tree-sitter's tags convention (`@definition.class` around a definition,
  `@name` inside it), plus `@import` on the text that names another file, so a grammar's own
  `queries/tags.scm` mostly works as is. Many grammars publish a `.wasm` (web-tree-sitter 0.27
  reads them). For a simple format, skip the grammar and write `patterns.txt`, one line per
  kind: `function: ^\s*def\s+(\w+)`, `import: require\(["']([^"']+)` (the first group is
  the name, or the path). How imports resolve: `relative` (`./x` next to the file), `dotted`
  (`a.b.c` under the `roots:` folders), `res` (Godot's `res://`), `name` (a class name defined
  anywhere, like GDScript's `class_name`), `suffix` (any file whose path ends the same way).
  Files no pack reads still show in their area, sized but without definitions. A pack with
  `code: gdscript` also feeds the Systems lens (calls, signals, objects made, state); GDScript
  is the only code reader so far. A `highlights.scm` beside the grammar colours the code the
  Design view shows: a grammar's own `queries/highlights.scm` works as is (later patterns win;
  ones the grammar doesn't know are left out), and its captures (`@keyword`, `@string`,
  `@function`, `@type`, …) pick the colours. The built-in packs all have one. Hovering a file
  or a definition in the Design view shows its doc comment: the comments right above it, or a
  docstring; `doc: ##` limits them to comments starting that way (GDScript's built-in pack does).
  `"design": false` in `settings.json` turns the snapshots off.
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
- **Harnesses and prices.** The **Harnesses** page shows each CLI: whether it runs here, its
  version and login (checked when you ask), what it can do, and which roles use it. Claude Code
  and OpenCode report cost; for the others, give each model's prices there (dollars per million
  tokens, with cache reads and writes if they differ) and how long its prompt cache lasts. They
  go in `settings.json`, which also holds the Settings page's choices; the repository's file
  wins over your personal one, key by key.

### Folders: keeping roles and workflows organized

The Roles and Workflows tabs each have their own folders, like `game-dev`, `mobile-dev` or
`utilities`, one level deep. **+ Folder** makes one. To file something, pick or type a folder on the
item and save, or on a computer drag it onto the folder. **⋯** on a folder exports, renames or
removes it. **Remove folder** keeps what's in it, out of any folder; **Delete with contents** deletes
those files too.

They're real folders on disk (`.metaharness/roles/game-dev/gd-reviewer.md`), so you can arrange them
in an editor too. A role's name is its file's name wherever it sits, so nothing that names it
changes when it moves. That also means a name can only be used once in a config folder: the app
refuses a second one, and points it out if you make one by hand. Folders only organize: agents see
the same roles and workflows either way. A folder with the same name in the personal and the
project folder shows as one. Rules don't have folders.

**A workflow can use a whole folder.** Under *Roles it uses*, name roles one by one, a folder with a
trailing slash, or both:

```markdown
---
good_at: a Godot feature
roles: game-dev/, reviewer
---
```

A role you file in `game-dev` later is included from then on. Renaming the folder updates the
workflows that name it, in this project and your personal folder; workflows in other projects are
yours to change. Removing the folder has them name its roles one by one instead. A folder that
doesn't exist or is empty gives the workflow no roles from it, and the page warns about one that
doesn't exist. It doesn't open the workflow up to every role.

### Sharing roles and workflows

To send someone your setup, use **Export…** on a folder (under its **⋯**), or on a role, workflow,
rule, skill or MCP server. You get one file, `<name>.mh-export.json`, to send however you like. They
choose **Import…** on the Roles, Workflows, Rules or Tools & skills tab and pick or paste it. Any of
those tabs takes any file, and the review shows everything in it.

What comes along: a workflow brings the roles and role folders on its `roles:` line and the
workflows it hands on to; a role brings its workflow, skills and MCP servers, and a rule the skill
it points at. **Leave out** what the other person should bring themselves, and **add** anything else
in the dialog. Exporting a folder of workflows brings their roles; exporting a folder of roles
brings those roles and doesn't look for workflows that use them. A workflow with no `roles:` line
brings no roles, so name them. What ships with MetaHarness isn't packed. Rules that name a role in
the export are offered, not added.

**What stays home.** An MCP server's `env` and `headers` values are taken out unless they only
name a variable (`${TOKEN}`). Hidden files in a skill's folder aren't packed. If something still
looks like a key or a password, the export stops and shows you where, until you take it out or say
it's fine. That check knows common token shapes and can miss others. Export also tells you when a
file names a folder on your machine. The file is plain JSON: read it if you want to know exactly
what's going out.

**Importing is a reviewed copy.** Nothing is written until you press **Import**. The review lists
every item with its text, whether it's new, already here or different from yours, and what it can
do beyond giving agents text: commands it runs unasked, its own approval mode, programs it starts,
scripts in a skill. A file can tell agents anything, so read what you don't recognise. These stay
off unless you turn them on:

- anything that would overwrite yours (no copy is kept, so read both first),
- a role settings gives a job (the gatekeeper decides what runs without you),
- anything that replaces something built in (a rule like `stay-in-project`).

If you keep your own `reviewer`, a workflow from the file simply uses yours. If a role's harness
isn't on your machine, the review says so and lets you pick what it runs on. MCP values that were
taken out are listed for you to fill in on Tools & skills. Choose where it all goes: this project, or
your personal folder for every project.

Roles and workflows arrive in the folder they had. If they had none and several of a kind came
together, they arrive in a folder named after the export. Yours stays in your folder, even if you
overwrite it.

**After that they're yours.** Nothing remembers where they came from: edit them, refile them, delete
them. To drop a whole import you didn't like, use **Delete with contents** under the folder's **⋯**.
If someone sends a newer file, importing it works just like the first time: what changed shows as
different from yours, and you choose item by item.

From the command line:

```sh
mh export --role-folder game-dev                   # writes game-dev.mh-export.json
mh export --workflow godot --rule api-style        # items by name, each with what it needs
mh import game-dev.mh-export.json --to personal    # shows the review, then asks
```

`mh import` copies what the review turns on. `--replace` adds what it left off, and `--run-on
<harness/model>` moves the roles nothing here can run. Without a terminal to ask at, it needs
`--yes`.

## 9. Restarts

Stopping the daemon (Ctrl-C) doesn't lose the goal: everything is in an event log
(`~/.metaharness/mh.db`). Start it again, from anywhere: the goals left running come back, each
in its project.

- Agents that were mid-turn resume their sessions, told what happened.
- Finished or idle agents resume when someone messages them.
- `mh daemon --no-resume` skips this.

Finished goals stay in the app's goal list, rebuilt from the log.

## 10. When something's off

| Symptom | Try |
|---|---|
| `mh doctor` says a harness isn't installed, but it is | Its folder isn't on the daemon's PATH (OpenCode installs to `~/.opencode/bin`). Start the daemon from a shell where `which <bin>` works |
| A role "can't run here" | Its harness isn't signed in, or the model isn't offered: fix `harness:`/`model:` or add a `fallback:` |
| "No roles are defined yet" | Section 4: roles go in `~/.metaharness/roles/` or the project's `.metaharness/roles/` |
| "Open a project first" | Open the folder: `mh project` in it, or **Open folder…** on the Projects page |
| An agent keeps asking to read files outside the project | It's reaching for something elsewhere on the machine. Say no and tell it where to look, or copy what it needs into the project |
| The web app says it isn't built | `npm run ui:build` in the MetaHarness folder |
| The web app asks for a token | Open it with `mh ui`, or paste the contents of `~/.metaharness/token` |
| Lots of approvals for harmless commands | Use the gatekeeper (Settings), or add them to the role's `allow:` list |
| Costs show "—" for Codex or Antigravity | Give the model's prices on the Harnesses page |
| An agent seems stuck | Its stream in the app shows its last command. Message it, mark it urgent, or pause and resume it |
| An agent crashed (red) | Its spawner was told and decides: usually it respawns it. If the lead crashed, it's in your Inbox: Respawn on its page, or Start over if resuming crashes again |
| A rule's note is noisy or wrong for this project | Turn it off on the Rules page, or save an edited copy into the project |
| A harness misbehaves | `mh test <harness>` says which part works and which doesn't |

## Reference

| | |
|---|---|
| `MH_HOME` | Where goals, the event log and the token live (default `~/.metaharness`) |
| `MH_PORT` | The daemon's port (default 7777) |
| `~/.metaharness/projects.json` | The projects you opened, and which you trusted |
| `~/.metaharness/goals/<goal>/` | `shared/` (and `.history/`), `worktrees/`, `design/` (the Design view's snapshots, and `reports/`), each agent's harness config |
| `.git/metaharness/authors-<goal>` | Which agent made each commit, written by MetaHarness's git hooks (removed with the goal) |
| `mh help` | Every command |
| `npm run ui:dev` | The web app with hot reload, for working on it, talking to a running daemon |
