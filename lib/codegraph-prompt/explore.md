## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, what depends on the symbols you name, and the tests that cover them, which replaces the chain of greps and reads that would answer the same question. The blocks it shows count as a Read of those files.

Call it before you `grep`, `find` or `read` when you have to say where something lives or how it works, follow a flow or an error across files, map the files a change would touch, or read a file whose neighbours you do not know. Follow what it reports as depending on a symbol instead of grepping for callers, and call it again on a symbol it surfaced when the next layer is what the question needs, then stop.

Name the symbols or files when you know them; a plain question works when you do not, and the code it returns is the code nearest your query. Report what the source says: the answer gives where code lives, and the source gives what it does.
