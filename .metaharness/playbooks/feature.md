Suggested flow for a feature. Adapt it to the task, and skip steps that don't apply.

1. Write the design to shared/design.md. Get a second opinion from a reviewer on a different
   provider if the design is non-trivial.
2. Ask the human to look at the design before code is written if it changes architecture.
3. Spawn implementers for the independent pieces, in parallel. Their branches start from your
   latest commit, so commit anything they need first. Give each one a brief that points to the
   design, and tell implementers who depend on each other.
4. Have the code reviewed by someone other than its author: spawn the reviewer with `from` set
   to the implementer, so its worktree has the code. Send findings back to the implementer.
5. Merge the finished branches into the goal branch.
6. Ask the documenter to update docs and the reporter to write shared/report.md for the human.
