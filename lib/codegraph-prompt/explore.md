## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, the call paths between those symbols — including calls grep cannot follow — what a change reaches, and the tests that already touch it, which replaces the chain of greps and reads that would answer the same question.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` when you have to say where something lives or how it works, follow a flow or an error across files, map the files a change would touch, or read a file whose neighbours you do not know. Follow the call paths it returns instead of grepping for callers, and call it again on a symbol it surfaced when the next layer is what the question needs, then stop.

Name the symbols or files when you know them; a plain question works when you do not. Cite `path:line` from what it returned. The blocks it shows are already read: do not read them again. Read the files it only names, or flags as changed on disk. Read before you report: the answer says where code lives, not what it does. Your handoff is evidence you observed.
