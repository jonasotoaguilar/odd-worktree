## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbol or file you are about to change, its source verbatim with line numbers, what depends on it, and the tests that cover it — what the edit has to keep working.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` to see what depends on what you are changing, and to find the implementation you should reuse instead of writing a second one. After you move or rename a symbol, query the old name to find what still points at it. Name the symbols or files when you know them; a plain question works when you do not.

The blocks it shows count as a Read of those files; the ones it only names, or leaves without code, you open with `read` — the answer gives where code lives, and the source gives what it does. The allowed edit surfaces and the authorized commands stay as delegated, and a route you need outside them is reported.
