(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function

(import_statement name: (dotted_name) @import)
(import_statement name: (aliased_import name: (dotted_name) @import))
(import_from_statement module_name: (dotted_name) @import)
(import_from_statement module_name: (relative_import) @import)
