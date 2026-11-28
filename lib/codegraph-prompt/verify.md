## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, for the symbols a change touches, their source verbatim with line numbers, the call paths between them, what the change reaches, and the tests that already touch them.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` once you know what the spec requires and you need that reach to choose interaction and regression probes; call it again on a caller it surfaces when a probe needs the next layer. Name the symbols or files when you know them; a plain question works when you do not.

The answer is a map, never evidence: the probe is what proves, a verdict comes from the source you read and the checks you ran, and a probe that contradicts the graph is the one that is right. Derive your probes from the request, not from the tests it lists. Run only the commands the parent or your role authorizes, in the required isolation. The blocks it shows are already read: do not read them again. Read the files it only names, and any file whose code it leaves out.
