## CodeGraph

Run a `codegraph` `query` for symbols or `explore` for source plus call paths before you search or read
code — `fd`, `find`, `rg`, `grep`, `read` or `cat` — and before you plan or size a change: one `explore` on
the change's subject shows the files and callers it reaches, which is what scope, size and the handoff
depend on, and `query` locates a symbol. Exact strings, a file you already know and a run that only
executes commands or tests need no call. The call comes first, not instead: the other tools stay for what
the graph does not index, and its answer is a map — a verdict comes from the source and from tests.

Each worktree is its own workspace with its own index, and a query answers only for the checkout it runs
in. Structure in a sibling worktree or another repository belongs to an explorer delegated there; this
workspace's answer is never carried across.
