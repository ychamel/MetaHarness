---
good_at: a feature whose approach is clear: design it, then build it
---
1. Write the design to shared/design.md. Get a second opinion from a reviewer on a different
   provider if it's non-trivial.
2. If it changes the architecture, ask the human to approve it: `send` to human with
   `decision: true`, saying what to approve and where it is, then `wait` for the answer. If they
   ask for changes, revise and ask again.
3. Continue with the `implementation` workflow.
