## CodeGraph

Run a `codegraph` `query` for symbols or `explore` for source plus call paths before you search or read
code — `fd`, `find`, `rg`, `grep`, `read` or `cat` — and before you plan or size a change: one `explore` on
the change's subject shows the files and callers it reaches, which is what scope, size and the handoff
depend on, and `query` locates a symbol. Exact strings, a file you already know and a run that only
executes commands or tests need no call. The call comes first, not instead: the other tools stay for what
the graph does not index, and its answer is a map — a verdict comes from the source and from tests.

Each worktree is its own workspace with its own index, and `codegraph` answers only for the checkout it
runs in. To look at a sibling worktree or another git project, call `mcp__codegraph__codegraph_explore`
with `projectPath` set to that checkout, when that tool is available (a worktree lives at
`<repo-parent>/<repo-name>-worktrees/<odd>`): that one look is enough to settle a doubt and to size the
work. If it does not settle it, or the work there is more than a look, delegate an explorer to that
checkout and hand it that map. An answer is only ever about the checkout it came from: never present
one workspace's answer as another's.
