## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, what depends on the symbols you name, and the tests that cover them. Its blocks count as a Read.

Name the symbols or files when you know them; a plain question works when you do not. The code it returns is the code nearest your query: when that is not what you meant, ask again with a name the answer surfaced.

Call it instead of `grep`, `find` or `read` when:
- you are about to change code you have not read;
- you are tracing a bug or a flow across files;
- you need to know what an edit would reach before you or a worker touch it;
- you have to size a task or delegate it to a subagent.

For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.

An answer belongs to the checkout it came from: set `projectPath` for another worktree or another git project, and say which checkout you used.
