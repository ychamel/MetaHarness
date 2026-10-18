---
when: start
roles: lead
description: the repository has no codebase map yet
missing: ARCHITECTURE.md
---
This repository has no ARCHITECTURE.md, the map that shows agents where things are so they
spend less time searching. Don't create one unasked. If this goal means working across much
of the code, ask the human (`send` to human with `decision: true`) whether to run the
`map-bootstrap` workflow first. Otherwise, mention it in your done note: "The map-bootstrap
workflow can create ARCHITECTURE.md for this repository."
