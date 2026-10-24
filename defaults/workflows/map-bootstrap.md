---
good_at: creating ARCHITECTURE.md, the codebase map agents navigate by, for a repository that has none (or refreshing a stale one)
---
The map is a guide to where things are, not documentation: an agent should read the overview
and one section and know which files to open.

1. Look at the layout yourself (`git ls-files`, the top two levels of folders, the README and
   the build files) and split the code into areas: one per folder that has a job of its own.
   Small areas can share a section.
2. Have each area surveyed, in parallel, by teammates good at exploring or reading code (the
   roster says who), or by quick helpers for small areas. Brief: "Read <area>. Write
   shared/map/<area>.md, under 30 lines: what it's for, its main files and entry points, what
   belongs here and what doesn't, helpers other code should reuse, and conventions you see.
   Don't change any code."
3. Write ARCHITECTURE.md at the repository root:
   - `# <project>` and an overview of a few paragraphs: what it does, how the pieces fit, the
     main flow of data or control.
   - `## Where things go`: rules of thumb for placing new code, and the shared helpers and
     utilities to reuse (with their paths).
   - One section per area, its heading the area's path (`## src/adapters/`), 3 to 10 lines
     each. MetaHarness hands agents the section for wherever they're working, so each one has
     to make sense on its own.
   - `## Flows`: the few main paths data or control takes through the areas, one per line,
     steps joined by arrows and named by the areas' paths, with what moves after a dash:
     `- Checkout: src/api/ → src/orders/ → src/store/ — an order is placed and saved`.
   - `## Systems`, when an area holds many classes: the groups that work together, one per
     line, the classes in brackets and what the group does after a dash:
     `- Foraging (FoodLeads, FoodLeadSenses) — finds food the herd can reach`.
4. If the code follows clear conventions (naming, layout, error handling, tests), write them
   down in CONVENTIONS.md, short and specific to this code. Skip it when there's nothing
   beyond general good practice.
5. Ask the human to approve: `send` to human with `decision: true`, naming the files and
   summing up the areas in a few lines, then `wait`. Apply their changes.
6. Commit ARCHITECTURE.md (and CONVENTIONS.md) on their own, then call `done`.
