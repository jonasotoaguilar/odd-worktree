## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbol or file behind the finding, its source verbatim with line numbers, what depends on it, and the tests that cover it — what the patch has to keep working, so the fix stays inside that and the focused tests are the right ones. The blocks it shows count as a Read of those files.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` on the finding's code, in the checkout you are authorized to fix, and again on a symbol it surfaces only when the patch needs that layer. Confirm the finding in the source: the answer gives where code lives, and the source gives what it does. Name the symbols or files when you know them; a plain question works when you do not.
