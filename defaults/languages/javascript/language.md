---
extensions: .js, .mjs, .cjs, .jsx
grammar: grammar.wasm
resolve: relative
try: .js, .jsx, .mjs, .ts, /index.js, /index.jsx
---
JavaScript, JSX included. Grammar: tree-sitter-javascript 0.23 (MIT). Imports starting with `.` are
files next to this one; package imports are left out.
