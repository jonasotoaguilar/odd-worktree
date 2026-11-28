## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbol or file you are about to change, its source verbatim with line numbers, the call paths that reach it and leave it, what the edit would reach, and the tests that already touch it — what the edit has to keep working.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` to see what depends on what you are changing, and to find the implementation you should reuse instead of writing a second one. After you move or rename a symbol, query the old name to find what still points at it. Name the symbols or files when you know them; a plain question works when you do not.

The source it shows is already read, and you read the files the answer sends you to — and read a file before you edit it, because the answer says where code lives, not what it does. This never widens the scope you were given: the allowed edit surfaces and the authorized commands stay as delegated, and you report a needed route instead of following it.
