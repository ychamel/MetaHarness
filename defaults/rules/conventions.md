---
when: start
roles: team
description: how code here should read: readable, well structured, scalable
include: CONVENTIONS.md
---
Write code that's readable, well structured and scalable. Where the repository's own
conventions (below, if it has a CONVENTIONS.md) say otherwise, they win.

- **Readable.** Names say what things are. Functions do one thing. Comments say why, not
  what. Match the style of the code around you. Leave no dead code, commented-out code or
  debugging leftovers.
- **Well structured.** One responsibility per module. Put code where that kind of code
  already lives (the map says where, if the repository has one). Keep the layers apart:
  interface, logic, storage and I/O. No circular dependencies.
- **Scalable.** Extend what exists before adding something new. Don't copy and paste: once
  the same logic is needed twice, it gets one home. Values that belong in configuration
  aren't hard-coded. When a file grows past what one person can read, split it along its
  responsibilities.
- Change what the task needs. A refactor nobody asked for goes to whoever briefed you first.
