; Highlights for GDScript, written for tree-sitter-gdscript 6.1 by MetaHarness.
; Later patterns win over earlier ones: the general rules come first, the particular ones after.

(identifier) @variable

; Names written like classes and constants
((identifier) @type (#match? @type "^[A-Z][a-z0-9]"))
((identifier) @constant (#match? @constant "^[A-Z][A-Z0-9_]+$"))
((identifier) @variable.builtin (#eq? @variable.builtin "self"))

; Properties, calls and definitions
(attribute "." (identifier) @property)
(call (identifier) @function)
(attribute_call (identifier) @function.method)
(base_call (identifier) @function)
(function_definition name: (name) @function)
(constructor_definition "_init" @function)
(signal_statement name: (name) @function)
(class_definition name: (name) @type)
(class_name_statement name: (name) @type)
(enum_definition name: (name) @type)
(enumerator (identifier) @constant)
(const_statement name: (name) @constant)
(type (identifier) @type)

; Parameters
(parameters (identifier) @variable.parameter)
(typed_parameter (identifier) @variable.parameter)
(default_parameter (identifier) @variable.parameter)
(typed_default_parameter (identifier) @variable.parameter)

; Literals
(integer) @number
(float) @number
[(true) (false) (null)] @constant.builtin
(string) @string
(string_name) @string
(node_path) @string
(get_node) @string
(escape_sequence) @escape

(annotation) @attribute
(annotation (identifier) @attribute)

[
  "and" "as" "await" "break" "class" "class_name" "const" "continue" "elif" "else" "enum"
  "export" "extends" "for" "func" "get" "if" "in" "is" "match" "not" "onready" "or" "return"
  "set" "setget" "signal" "var" "when" "while"
  "remote" "master" "puppet" "remotesync" "mastersync" "puppetsync"
] @keyword
(static_keyword) @keyword
(pass_statement) @keyword
(break_statement) @keyword
(continue_statement) @keyword
(breakpoint_statement) @keyword

[
  "+" "-" "*" "/" "%" "**" "==" "!=" "<" ">" "<=" ">=" "=" ":=" "+=" "-=" "*=" "/=" "%=" "**="
  "&" "|" "^" "~" "<<" ">>" "&=" "|=" "^=" "<<=" ">>=" "&&" "||" "!" "->"
] @operator

(comment) @comment
(region_start) @comment
(region_end) @comment
