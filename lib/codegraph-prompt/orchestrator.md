## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, the call paths between those symbols — including calls grep cannot follow — what a change reaches, and the tests that already touch it.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` when:
- you are about to change code you have not read;
- you are tracing a bug or a flow across files;
- you need to know what an edit would reach before you or a worker touch it;
- you have to size a task or hand it off.

Name the symbols or files when you know them; a plain question works when you do not. Refine a miss with a name the answer surfaced. Read an exact file path, or search an exact string, directly.

The blocks it shows are already read: do not read them again. Read the files it only names, and any file whose code it leaves out; an `edit` replaces exact text, so the bytes it replaces come from what you have read. A verdict comes from the source and the tests. Set `projectPath` when the code you need is in another worktree or another git project, and never present one workspace's answer as another's.
