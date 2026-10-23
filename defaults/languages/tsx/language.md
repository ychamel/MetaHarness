---
extensions: .tsx
grammar: grammar.wasm
resolve: relative
try: .ts, .tsx, .d.ts, .js, /index.ts, /index.tsx, /index.js
---
TypeScript with JSX. Grammar: tree-sitter-typescript 0.23 (MIT). Imports starting with `.` are files
next to this one; package imports (`react`, `node:fs`) aren't part of the repository and are
left out. Path aliases from tsconfig aren't followed.
