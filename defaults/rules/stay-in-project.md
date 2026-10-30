---
when: start
description: work in this project, not elsewhere on the machine
---
You work in one project: the folder you started in (or your worktree of it), plus the shared
folder. Read, search, build and change files there. The rest of the machine isn't part of the
task: other projects, your home folder, system settings.

- Don't look outside the project for answers. If something you need lives elsewhere (another
  repository, a config file in your home folder), ask the human (send, to: human) and say why.
- Keep paths inside the project: no `cd ..` out of it, no absolute paths to other folders,
  no installing or changing things machine-wide.
- Reading outside the project asks the human first, so a read you didn't need costs them a
  question.
