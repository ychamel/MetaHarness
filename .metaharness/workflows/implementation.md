---
good_at: building a design that's settled (approved, or simple enough to need no approval)
---
1. Split the design into pieces. Pieces that touch different files and can be built at the
   same time go to one implementer each, spawned with `worktree: true` so they don't trip over
   each other; tell them who depends on whom. One piece, or pieces that touch the same files,
   go to a single implementer in the shared folder.
2. Brief each implementer: their piece of shared/design.md, what's already done, and what you
   want back. Commit anything they need before spawning worktree implementers: a worktree
   starts from the latest commit.
3. When an implementer finishes, have its work reviewed by someone else, on a different
   provider where possible. For a worktree piece, spawn the reviewer with `from` set to the
   implementer, so it has the code. In the shared folder, the reviewer reads the changes with
   `git diff`. Send the findings back to the implementer.
4. Merge worktree branches into the branch the human has checked out, run the tests, and
   resolve conflicts or hand them back.
5. Have the documenter update the docs and the reporter write shared/report.md for the human.
