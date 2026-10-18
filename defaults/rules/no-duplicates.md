---
when: new-file
roles: team
description: before building on a new file, check that nothing already does its job
paths: **, !**/*test*/**, !**/*.test.*, !**/*_test.*, !**/*.spec.*, !**/*.md
---
Before you build on it: is there already a module or helper that does this, or should? Look
in the map (ARCHITECTURE.md) if the repository has one, or ask a quick helper (`spawn` with
`quick: true`, e.g. "does anything in the repository already parse X?"). If something close
exists, extend it rather than adding a second version, and remove this file.
