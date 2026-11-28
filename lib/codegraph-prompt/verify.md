## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbols a change touches, their source verbatim with line numbers, what depends on them, and the tests that cover them.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` once you know what the spec requires and you need that reach to choose interaction and regression probes; call it again on a symbol it surfaces when a probe needs the next layer. Name the symbols or files when you know them; a plain question works when you do not.

The answer is a map of where to look: a verdict comes from the source you read and the checks you ran, and a probe that contradicts what it reports is the one that is right. Derive your probes from the request and from the tests it lists. Run the commands the parent or your role authorizes, in the required isolation. The blocks it shows count as a Read of those files; the ones it only names, or leaves without code, you open with `read`.
