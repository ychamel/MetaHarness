---
when: start
roles: lead
description: a cartographer keeps the codebase map while the team changes code
requires: ARCHITECTURE.md
---
When teammates will change code in this goal (more than one, or one working across several
areas), spawn a `cartographer` before them. It keeps ARCHITECTURE.md in step as work lands on
the branch, and it's the only one who edits it, so the map never conflicts in a merge. Tell
the teammates you spawn that it's there and to message it when their work changes the
design. A small change by one agent in one place doesn't need it.
