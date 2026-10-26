---
when: start
roles: lead
description: the repository has no codebase map yet
missing: ARCHITECTURE.md
---
This repository has no ARCHITECTURE.md, the map and the layered docs that let agents read only
what a task needs instead of searching the code. Don't create them unasked. If this goal means
working across much of the code, ask the human (`send` to human with `decision: true`) whether
to run the `map-bootstrap` workflow first. Otherwise, mention it in your done note: "The
map-bootstrap workflow can write ARCHITECTURE.md and a README per system for this repository."
