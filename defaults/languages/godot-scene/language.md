---
extensions: .tscn, .tres
resolve: res
---
Godot scenes and resources (text format). Each `[node]` is a part of the scene; `ext_resource`
paths (`res://…`) are the scripts, scenes and resources it uses, so a scene links to its scripts
and to the scenes it instances. No grammar needed: `patterns.txt` reads the lines.
