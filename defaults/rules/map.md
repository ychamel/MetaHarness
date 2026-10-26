---
when: start
roles: all
description: the repository's map (ARCHITECTURE.md), and how to get from it to the code you need
include: ARCHITECTURE.md
requires: ARCHITECTURE.md
---
This repository's docs come in layers, so you read only what your task needs. The first layer,
ARCHITECTURE.md, is below: what the code is, one heading per system with where it lives and
where its behavior is defined, what never to open, and the commands. Before opening code:

1. Find the system your task is in, then read its README, which the map points to. Read
   docs/RUNTIME.md only for work that crosses systems, and a decision or domain doc only when
   you change that decision or work in that domain (the map lists them).
2. Check where the system's behavior is defined. If it's in data or configuration, change it
   there, not in code. If it lives in editor or tool state, don't work around it in code: list
   the manual step for the human in your done note.
3. Name the 3 to 5 files you expect to need, then read those, selectively. Search wider only
   when they don't answer it.
4. Never open what the map's never-read list names.
5. When the code and a doc disagree, the code wins: say so, and fix the doc if it's yours to
   keep (the `docs` rule says whose it is) or tell whoever keeps it.
