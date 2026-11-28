## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbols a change touches, their source verbatim with line numbers, the code that calls them, and the tests that cover them. Its blocks count as a Read. Name the symbols or files when you know them; a plain question works when you do not.

Call it instead of `grep`, `find` or `read` once you know what the spec requires and you need to see what else calls those symbols before you choose your probes. Call it again only when a probe needs the next layer.

For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.
