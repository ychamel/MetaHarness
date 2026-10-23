(class_name_statement name: (name) @name) @definition.class
(class_definition name: (name) @name) @definition.class
(function_definition name: (name) @name) @definition.function
(signal_statement name: (name) @name) @definition.signal
(enum_definition name: (name) @name) @definition.enum

((call (identifier) @_load arguments: (arguments (string) @import)) (#match? @_load "^(preload|load)$"))
(extends_statement (string) @import)
(type (identifier) @name) @reference.class
