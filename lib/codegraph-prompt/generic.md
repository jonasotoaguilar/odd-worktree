## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, what depends on the symbols you name, and the tests that cover them. Its blocks count as a Read.

Name the symbols or files when you know them; a plain question works when you do not. The code it returns is the code nearest your query: when that is not what you meant, ask again with a name the answer surfaced.

Call it instead of `grep`, `find` or `read` when you are about to change code you have not read, when you follow a flow or an error across files, when you size up what a change would reach, or when you read a file whose neighbours you do not know.

For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.
