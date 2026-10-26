---
good_at: giving every file, class and function in a repository a doc comment saying what it's for, where they're missing
---
Doc comments say what each file, class and function is for, so someone following the design
(the Design view shows them on hover) understands it without opening the code. This goal only
adds comments: it needs no cartographer.

1. Look at the layout yourself (`git ls-files`, the top two levels of folders, ARCHITECTURE.md
   if there is one) and split the code into parts, by folder, each small enough for one agent
   to read, no two sharing a file. Leave out tests, generated and vendored code, and data.
2. Have the parts documented in parallel by teammates good at reading code (the roster says
   who), spawned with `worktree: true`, or by quick helpers for small parts. Brief: "In
   <part>, give each file, class and function that has no doc comment one, in the language's
   own form (`/** … */` in TypeScript and JavaScript, a docstring in Python, `##` in
   GDScript). Read its README first, if it has one. Say what it's for
   and what it does at a high level: its job, what it takes and gives back when that isn't
   plain, the effects that matter (state it changes, signals it sends, files it writes). Not
   how it works, step by step. The first sentence is the summary and stands on its own; more
   detail goes in a paragraph after it; a short function gets a short line. Fix a doc that's
   wrong and leave the others as they are. Change nothing but comments. Commit: `docs: <part>`."
3. As parts come back, read a few docs from each: the same level of detail and the same voice
   across parts, nothing that narrates the code line by line. Send back what's off.
4. Merge the branches into the branch the human has checked out (the parts share no files, so
   they merge cleanly), check that nothing but comments changed (`git diff --stat`, then a
   look at a few files), and call `done` with what was documented and anything left out.
