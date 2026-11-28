## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, the code that calls the symbols you name, and the tests that cover them — one call instead of the chain of greps and reads that would answer the same question. Its blocks count as a Read.

Name the symbols or files when you know them; a plain question works when you do not, and the code it returns is the code nearest your query.

Call it instead of `grep`, `find` or `read` when you have to say where something lives or how it works, when you follow a bug or an error across files, when you map the files a change would touch, or when you read a file you have not read yet. Follow the callers it reports instead of grepping for them, and call it again only when the next layer is what the question needs.

For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.
