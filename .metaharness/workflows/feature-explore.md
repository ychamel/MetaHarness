---
good_at: a feature where the right approach isn't clear yet: explore options, settle a design, get it approved
---
1. Spawn 2–4 explorers in parallel, each with a different idea or scope (pick roles by what
   they're good at; different providers give more varied ideas). Each writes
   shared/explore/<their name>.md: the approach, a sketch, the risks, and what it would cost.
   Explorers read code and write to shared/; they don't change the code, so they share the
   folder.
2. Give the designer (or the architect, if there's no designer) all the explorations. The
   designer either asks for another round (new scopes, or a deeper look at one idea) or
   settles and writes shared/design.md, saying which ideas it took and why.
3. Ask the human to approve the design: `send` to human with `decision: true`, pointing at
   shared/design.md, then `wait` for the answer. Don't start implementing before they approve.
   If they ask for changes, go back to step 2 with their notes.
4. Once approved, continue with the `implementation` workflow.
