---
when: start
roles: lead
description: a cartographer keeps the code's documentation while the team changes code
---
When this goal will change code, even a small patch, spawn a `cartographer` before anyone starts
on it. It keeps the code's documentation in step as work lands on the branch: the doc comments
that say what each file, class and function is for, and ARCHITECTURE.md, the codebase map, if
the repository has one. It's the only one who edits them, so they speak with one voice and never
conflict in a merge. Tell the teammates you spawn that it's there and to message it when their
work changes the design or what something is for.
