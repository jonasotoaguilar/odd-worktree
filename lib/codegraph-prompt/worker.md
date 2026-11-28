## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbol or file you are about to change, its source verbatim with line numbers, what depends on it, and the tests that cover it — what the edit has to keep working. The blocks it shows count as a Read.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` to see what depends on what you are changing, and to find the implementation you should reuse instead of writing a second one. After you move or rename a symbol, query the old name to find what still points at it. Name the symbols or files when you know them; a plain question works when you do not.

The answer gives where code lives, and the source gives what it does.
