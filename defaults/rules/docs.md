---
when: start
roles: team
description: the documentation layers: where each fact goes, who keeps it, the README headings and the size limits
requires: ARCHITECTURE.md
---
This repository's docs come in layers, so an agent reads only what its task needs. Each layer
is kept short and holds what the others don't.

| Layer | Where | Holds | Size |
|---|---|---|---|
| Map | `ARCHITECTURE.md` | What the code is (3 lines); stack and versions; one heading per system, its path (`## src/api/`), with a line or two: what it's for, where its behavior is defined (code, data, config, editor, infra) and its README; the never-read list; commands and global conventions (or a pointer to CONVENTIONS.md); the decision and domain docs, with when to read each; `## Flows` and `## Systems` | ~100 lines, 6,000 characters |
| Runtime | `docs/RUNTIME.md` | Components and their boundaries; how it runs (a request's lifecycle, or the game loop and update order); startup; who owns shared state | 1–2 pages |
| System | `README.md` in the system's folder | The headings below | ~80 lines |
| Decisions, domain | `docs/decisions/`, `docs/domain/` (or where the map says) | One decision per file: context, decision, consequences. Domain docs: game design, product specs, API contracts, shader notes | One topic per file |
| Code | Names, types, doc comments | Doc comments on files, classes and functions are for the human following the design in the Design view | |

A system's README has these headings, in this order (write "None." rather than drop one):
`## Purpose`, `## Entry points`, `## Where behavior is defined`, `## Invariants and contracts`
(including the ones outside the code: "expects a child named Muzzle", "needs env var X"),
`## Constraints` (performance, security, authority), `## Gotchas`, `## Dependencies` (what it
uses, and what uses it). When a system's files are spread by type (scenes/, scripts/,
assets/), its README goes in its main code folder and names its scenes and assets.

- **Write what the code can't say**: intent, invariants, wiring outside the code, constraints.
  Pointers over prose, each fact in one place: link to it rather than repeat it.
- **Editor or tool state** is what should be changed through a tool rather than by editing a
  file: settings in an admin console or a cloud console, a scene tree reshaped in an editor,
  anything that regenerates IDs or imports, baking, animation. Text files that hold behavior
  (configuration, scene and resource files) are sources of truth, not noise: they're never on
  the never-read list.
- **The never-read list** names what's generated, binary, vendored, or large and serialized.
- **Who keeps what.** You keep the README of each system you change, in the same commit as the
  code: entry points, invariants, gotchas and dependencies you added, changed or found. When a
  choice between real alternatives would otherwise be undone later, record it in
  `docs/decisions/`. If the team has a cartographer, it keeps the map, docs/RUNTIME.md and the
  doc comments: tell it what changed rather than editing them. Otherwise, keep those too.
- **Sizes.** When a doc would go over its size, prune it: cut what the code already says, what
  another doc holds, and what's no longer true. If the design really needs more room, ask the
  human to raise the limit (`send` to human with `decision: true`) rather than let it grow.
