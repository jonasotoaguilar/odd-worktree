## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbol or file behind the finding, its source verbatim with line numbers, the call paths that reach it and leave it, what the patch would reach, and the tests that already touch it — the whole reach of the patch, so the fix stays inside it and the focused tests are the right ones.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` on the finding's code, in the checkout you are authorized to fix, and again on a caller it surfaces only when the patch needs that layer. Confirm the finding in the source: the answer says where code lives, not what it does, so the source is what proves the defect. Name the symbols or files when you know them; a plain question works when you do not.

The blocks it shows are already read: do not read them again. Read the files it only names, and any file whose code it leaves out; an `edit` replaces exact text, so the bytes it replaces come from what you have read. This never widens the patch: stay within the authorized batch and its allowed edit surfaces.
