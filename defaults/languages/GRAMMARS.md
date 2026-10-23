# Grammars

The `grammar.wasm` files here are tree-sitter grammars compiled to WebAssembly, read with
web-tree-sitter. Each is under the MIT license (Copyright (c) Max Brunsfeld and the grammar's
contributors):

| Pack | Grammar | Version | Source |
|---|---|---|---|
| python | tree-sitter-python | 0.25.0 | npm package, as published |
| typescript, tsx | tree-sitter-typescript | 0.23.2 | npm package, as published |
| javascript | tree-sitter-javascript | 0.23.1 | npm package, as published |
| gdscript | tree-sitter-gdscript | 6.1.0 | built from the npm package's `src/` with emscripten 4.0.15: `emcc -o grammar.wasm -Os -fPIC -std=c11 -sWASM=1 -sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=_tree_sitter_gdscript -I src src/parser.c src/scanner.c` |

To add a language, see the user guide (Language packs): many grammars publish a `.wasm` and a
`queries/tags.scm` that works here as is.
