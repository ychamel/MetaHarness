---
when: start
roles: lead
description: a cartographer keeps the code's documentation while the team changes code
---
When this goal will change code, even a small patch, spawn a `cartographer` before anyone starts
on it. It keeps the shared documentation in step as work lands on the branch: ARCHITECTURE.md
(the map) and docs/RUNTIME.md if the repository has them, and the doc comments that say what
each file, class and function is for. It's the only one who edits them, so they speak with one
voice and never conflict in a merge. Each teammate keeps the README of the systems it changes.
Tell the teammates you spawn that the cartographer is there and to message it when their work
changes the design or what something is for.
