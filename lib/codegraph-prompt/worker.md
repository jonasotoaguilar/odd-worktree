## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbol or file you are about to change, its source verbatim with line numbers, what depends on it, and the tests that cover it — what the edit has to keep working. Its blocks count as a Read.

Call it instead of `grep`, `find` or `read` to see what depends on the files in your allowed edit surfaces, and to find the implementation you should reuse instead of writing a second one. After you move or rename a symbol, query the old name to find what still points at it. Name the symbols or files when you know them; a plain question works when you do not.

For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.
