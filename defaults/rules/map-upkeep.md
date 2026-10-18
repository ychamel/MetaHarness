---
when: commit
roles: team
description: keep ARCHITECTURE.md in step when files are added, moved or removed
requires: ARCHITECTURE.md
changes: added, deleted, renamed
unless_changed: ARCHITECTURE.md
paths: **, !**/*test*/**, !**/*.test.*, !**/*_test.*, !**/*.spec.*
---
ARCHITECTURE.md wasn't changed. If the map no longer says where things are (a new module, a
moved one, a part that's gone), update its section in your next commit. Keep it a map: what
each part is for and where things go, a few lines per section, not a file listing.
