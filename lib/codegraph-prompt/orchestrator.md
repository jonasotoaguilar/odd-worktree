## CodeGraph

Before you `grep`, `rg`, `fd`, `find`, `read` or `cat` to answer where code lives, who calls it, how it
works, or what a change reaches, call CodeGraph first: `codegraph` with `operation: "explore"` and
`query: "<symbols or the question>"` returns the source and the call paths in one call, and it is
also what scope, size and any handoff depend on. Use `operation: "query"` only to find where one
symbol is defined. Skip it only for an exact string or a file path the user gave you. The other tools stay for
what the graph does not index. Its answer is a map: confirm it in the source, and a verdict comes
from the source and from tests.

`codegraph` answers only for the checkout the session runs in, and each worktree is its own workspace with
its own index. An ODD works in its own worktree: when the session runs elsewhere, look at that worktree, at
a sibling worktree or at another git project by calling `mcp__codegraph__codegraph_explore` with
`projectPath` set to that checkout, when that tool is available. That one look is enough to settle a doubt
and to size the work. If it does not settle it, or the work there is more than a look, delegate an explorer
to that checkout and hand it that map. An answer is only ever about the checkout it came from: never
present one workspace's answer as another's.
