## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, what depends on the symbols you name, and the tests that cover them.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` when:
- you are about to change code you have not read;
- you are tracing a bug or a flow across files;
- you need to know what an edit would reach before you or a worker touch it;
- you have to size a task or hand it off.

Name the symbols or files when you know them; a plain question works when you do not. Refine a miss with a name the answer surfaced. Read an exact file path, or search an exact string, directly.

The blocks it shows count as a Read of those files; the ones it only names, or leaves without code, you read yourself. A verdict comes from the source and the tests. The answer belongs to the checkout it came from: set `projectPath` for another worktree or another git project, and say which checkout you used.
