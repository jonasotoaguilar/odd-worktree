## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbol or file you are about to change, its source verbatim with line numbers, the code that calls it, and the tests that cover it — the code your edit can break. Its blocks count as a Read. Name the symbols or files when you know them; a plain question works when you do not.

Call it instead of `grep`, `find` or `read` to see what calls the files in your allowed edit surfaces, and to find the implementation you should reuse instead of writing a second one. After you move or rename a symbol, ask for the old name to find what still uses it.

For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.
