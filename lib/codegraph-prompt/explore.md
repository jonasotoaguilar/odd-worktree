## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, what depends on the symbols you name, and the tests that cover them, which replaces the chain of greps and reads that would answer the same question.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` when you have to say where something lives or how it works, follow a flow or an error across files, map the files a change would touch, or read a file whose neighbours you do not know. Follow what it reports as depending on a symbol instead of grepping for callers, and call it again on a symbol it surfaced when the next layer is what the question needs, then stop.

Name the symbols or files when you know them; a plain question works when you do not. Cite `path:line` from what it returned. The blocks it shows count as a Read of those files; the ones it only names, or leaves without code, you open with `read`. Report what the source says: the answer gives where code lives, and the source gives what it does. Your handoff is evidence you observed.
