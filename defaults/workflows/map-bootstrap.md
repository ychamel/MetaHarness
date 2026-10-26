---
good_at: writing the layered docs agents navigate by (ARCHITECTURE.md, the map; a README per system; docs/RUNTIME.md) for a repository that has none, or refreshing stale ones
---
The docs come in layers: an agent reads the map, picks a system, reads its README, and knows
which 3 to 5 files to open. They say what the code can't: intent, invariants, wiring outside
the code, constraints. Each fact lives in one place, and each layer has a size it stays under.

1. Look at the layout yourself (`git ls-files`, the top two levels of folders, the README, the
   build and project files) and split the code into systems: one per folder that has a job of
   its own. When files are spread by type (scenes/, scripts/, assets/), a system is a job, its
   home is its main code folder. Small systems can share a README. Note what's generated,
   binary, vendored or large and serialized, for the never-read list; text files that hold
   behavior (configuration, scene and resource files) never go on it.
2. Have each system surveyed, in parallel, by teammates good at exploring or reading code (the
   roster says who), or by quick helpers for small systems. Brief: "Read <system>. Write
   <folder>/README.md with these headings, in order: Purpose, Entry points, Where behavior is
   defined, Invariants and contracts, Constraints, Gotchas, Dependencies (uses, and used by).
   Under 80 lines. Write what the code can't say: intent, invariants including ones outside
   the code (a node a scene must have, an env var), where behavior lives when it isn't code
   (data, configuration, scene files, editor or tool state). Pointers to files over prose.
   Don't change any code. Commit only your README." Teammates with `worktree: true` keep the
   commits apart.
3. Read the READMEs as they come back: the same headings and voice, nothing that walks through
   the code line by line, nothing two of them both say. Send back what's off.
4. Write docs/RUNTIME.md (1–2 pages): the components and their boundaries, how it runs (a
   request's lifecycle, or the game loop and update order), startup and bootstrapping, and who
   owns shared state.
5. Write ARCHITECTURE.md at the repository root, under ~100 lines and 6,000 characters (it's
   loaded into every agent):
   - `# <project>`, then what it is in 3 lines, the stack and versions.
   - One heading per system, its path (`## src/adapters/`), with a line or two: what it's for,
     where its behavior is defined (code, data, config, editor, infra), and its README.
   - `## Never read`: the generated, binary, vendored and large serialized files, as globs.
   - `## Commands`: build, test, run; and the global conventions, or a pointer to
     CONVENTIONS.md.
   - `## Further docs`: docs/RUNTIME.md and each decision or domain doc, with when to read it.
   - `## Flows`: the few main paths data or control takes through the systems, one per line,
     steps joined by arrows and named by the systems' paths, with what moves after a dash:
     `- Checkout: src/api/ → src/orders/ → src/store/ — an order is placed and saved`.
   - `## Systems`, when a system holds many classes: the groups that work together, one per
     line, the classes in brackets and what the group does after a dash:
     `- Foraging (FoodLeads, FoodLeadSenses) — finds food the herd can reach`.
6. If the code follows clear conventions (naming, layout, error handling, tests), write them
   down in CONVENTIONS.md, short and specific to this code. Skip it when there's nothing
   beyond general good practice.
7. Ask the human to approve: `send` to human with `decision: true`, naming the files and
   summing up the systems in a few lines, then `wait`. Apply their changes.
8. Merge the READMEs' branches into the branch the human has checked out, commit
   ARCHITECTURE.md, docs/RUNTIME.md (and CONVENTIONS.md) on their own, then call `done`.
