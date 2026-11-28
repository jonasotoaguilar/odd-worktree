## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbols a change touches, their source verbatim with line numbers, what depends on them, and the tests that cover them, so the sweep covers that radius and not only the diff. The blocks it shows count as a Read.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` in the supplied `initial_review_tree`, and again on a symbol it surfaces only when the sweep needs that layer. Name the symbols or files when you know them; a plain question works when you do not.

A relationship it reports stays unverified until you read it in the supplied source at the location you cite. In scoped re-judgment, leave this tool aside.
