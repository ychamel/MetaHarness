---
when: commit
roles: team, !cartographer
description: keep ARCHITECTURE.md in step when files are added, moved or removed
requires: ARCHITECTURE.md
changes: added, deleted, renamed
unless_changed: ARCHITECTURE.md
paths: **, !**/*test*/**, !**/*.test.*, !**/*_test.*, !**/*.spec.*
---
ARCHITECTURE.md wasn't changed. If the team has a cartographer (`team` lists one), it keeps
the map: don't edit it, send the cartographer a short message: what changed in the design and
why (a new part and what it's for, something moved, a new dependency between parts, a flow
of data that now goes another way).
Otherwise, if the map no longer says where things are, update its section in your next commit. Keep it a map: what each part is for and where things go, a few lines per section, not
a file listing.
