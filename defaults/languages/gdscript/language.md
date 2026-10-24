---
extensions: .gd
grammar: grammar.wasm
resolve: res, name, relative
try: .gd
code: gdscript
doc: ##
---
GDScript (Godot). Grammar: tree-sitter-gdscript 6.1 (MIT), built to wasm for MetaHarness.
`preload`/`load` and `extends "res://…"` name files from the folder holding project.godot;
`extends Foo` and type hints name classes declared with `class_name` anywhere in the project.
Doc comments are `##` lines, as in Godot's own documentation.
