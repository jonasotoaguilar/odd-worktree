## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbol or file behind the finding, its source verbatim with line numbers, what depends on it, and the tests that cover it — what the patch has to keep working, so the fix stays inside it and the focused tests are the right ones. Its blocks count as a Read.

Call it instead of `grep`, `find` or `read` on the finding's code, within your allowed edit surfaces and the checkout you are authorized to fix. Call it again only when the patch needs the next layer. Name the symbols or files when you know them; a plain question works when you do not.
For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.
