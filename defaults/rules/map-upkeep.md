---
when: commit
roles: team, !cartographer
description: keep ARCHITECTURE.md and the system's README in step when files are added, moved or removed
requires: ARCHITECTURE.md
changes: added, deleted, renamed
unless_changed: ARCHITECTURE.md
paths: **, !**/*test*/**, !**/*.test.*, !**/*_test.*, !**/*.spec.*
---
ARCHITECTURE.md wasn't changed. If a system's entry points or dependencies moved, update its
README's sections in your next commit. If the map no longer says where a system lives (a new
system, one moved or removed, a new dependency between systems, a flow that now goes another
way): when the team has a cartographer (`team` lists one), send it a short message saying what
changed and why; otherwise update the map's heading for it yourself, a line or two, not a file
listing.
