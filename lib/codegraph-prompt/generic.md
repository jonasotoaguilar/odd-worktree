## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, what depends on the symbols you name, and the tests that cover them. The blocks it shows count as a Read. For an exact file path, use `read`; for an exact string, use `grep`.

Call it instead of `grep`, `rg`, `fd`, `find`, `read` or `cat` when you are about to change code you have not read, tracing a flow or an error across files, sizing up what a change would reach, or reading a file whose neighbours you do not know. Name the symbols or files when you know them; a plain question works when you do not. The code it returns is the code nearest your query: when that is not what you meant, ask again with a name the answer surfaced.
