---
extensions: .py, .pyi
grammar: grammar.wasm
resolve: dotted
try: .py, /__init__.py
roots: ., src
---
Python. Grammar: tree-sitter-python 0.25 (MIT). Imports are dotted module names, found under the
repository root and `src/`; relative imports (`from .x import y`) start from the file's package.
