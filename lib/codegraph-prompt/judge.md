## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbols a change touches, their source verbatim with line numbers, the call paths between them, what a regression could reach, and the tests that already touch them, so the sweep covers that radius and not only the diff.

Call it during initial discovery, before you `grep`, `rg`, `fd`, `find`, `read` or `cat`, when this checkout is the supplied `initial_review_tree`. Name the symbols or files when you know them; a plain question works when you do not.

The answer is a map, never proof: confirm every finding in the supplied source at the exact location you cite, and report a relationship you have not read as unverified. During scoped re-judgment, resolve only the frozen rows and the fix diff, and leave this tool aside. The source it shows is already read, and you read the files the answer sends you to.
