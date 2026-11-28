## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbols a change touches, their source verbatim with line numbers, what depends on them, and the tests that cover them, so the sweep covers that radius and not only the diff.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` in the supplied `initial_review_tree`, and again on a symbol it surfaces only when the sweep needs that layer. Name the symbols or files when you know them; a plain question works when you do not.

Confirm every finding in the supplied source at the exact location you cite, and report as unverified a relationship you have not read. In scoped re-judgment, resolve the frozen rows and the fix diff, and leave this tool aside. The blocks it shows count as a Read of those files; the ones it only names, or leaves without code, you open with `read`.
