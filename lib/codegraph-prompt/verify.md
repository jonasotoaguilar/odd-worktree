## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbols a change touches, their source verbatim with line numbers, what depends on them, and the tests that cover them. Its blocks count as a Read.

Call it instead of `grep`, `find` or `read` once you know what the spec requires and you need that reach to choose interaction and regression probes. Call it again only when a probe needs the next layer. Name the symbols or files when you know them; a plain question works when you do not.

For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.
