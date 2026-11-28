## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbols a change touches, their source verbatim with line numbers, what depends on them, and the tests that cover them, so the sweep covers that radius and not only the diff. Its blocks count as a Read.

Call it instead of `grep`, `find` or `read` in the supplied `initial_review_tree`, and again only when the sweep needs the next layer; in scoped re-judgment, leave this tool aside. Name the symbols or files when you know them; a plain question works when you do not.

For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.
