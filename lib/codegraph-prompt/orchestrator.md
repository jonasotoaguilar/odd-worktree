## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, the code that calls the symbols you name, and the tests that cover them. Its blocks count as a Read.

Name the symbols or files when you know them; a plain question works when you do not. The code it returns is the code nearest your query: when that is not what you meant, ask again with a name the answer surfaced.

Call it instead of `grep`, `find` or `read` when:
- you are about to change code you have not read;
- you are chasing a bug or an error across files;
- you or a worker are about to change code, and you need to see what calls it and which tests cover it;
- you have to size a task or delegate it to a subagent.

For an exact file path use `read`, for an exact string use `grep`, and for a file that is not code — docs, config, data — use `find`.

An answer belongs to the checkout it came from: set `projectPath` for another worktree or another git project, and say which checkout you used.
