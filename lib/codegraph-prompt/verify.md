## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbols a change touches, their source verbatim with line numbers, what depends on them, and the tests that cover them.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` once you know what the spec requires and you need that reach to choose interaction and regression probes; call it again on a symbol it surfaces when a probe needs the next layer. Name the symbols or files when you know them; a plain question works when you do not.

The answer is a map of where to look: a probe that contradicts what it reports is the one that is right. The blocks it shows count as a Read of those files.
