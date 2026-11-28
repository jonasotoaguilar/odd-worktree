## CodeGraph

`mcp__codegraph__codegraph_explore` queries a prebuilt index of the code's symbols, calls and dependencies. One call returns the relevant source (verbatim, line-numbered), the call paths between those symbols (dynamic dispatch, routes and cross-language calls included), what depends on them and the tests that cover them.

Call it first — before you `grep`, `rg`, `fd`, `find`, `read` or `cat`, and before you delegate a lookup to an explorer — whenever a task starts from code you have not read:

| Task | Query with |
| --- | --- |
| Understand: where something lives, how it works, how A reaches B, what an area contains | the names involved (both ends of a flow) |
| Investigate: what an error passes through, who calls a symbol | the symbol or the error site |
| Change: what to match, what the change reaches, which tests pin it; after a refactor, what still points at what moved | the symbols to change |
| Plan or hand off: the files, callers and tests a task involves | the area's names |
| Read a file or symbol you can name | its name or path |

Query with identifiers, file names and the domain's nouns, not a sentence. If the answer misses or is too wide, call again with a name it surfaced; one to three calls settle most questions. Exempt: an exact string or a file path the user gave you.

Trust the answer: its source is already read and comes from a full parse, so do not re-open those files or grep to double-check them. Use `read`, `grep` or `find` only for what it does not index (config, docs, prose) and for a file a ⚠ banner lists as edited after the last index update. If it reports a project as not indexed, stop calling it for that project. Delegate to an explorer only when a few calls have not settled it.

It answers only for the checkout the session runs in, and each worktree is its own workspace with its own index. An ODD works in its own worktree: when the session runs elsewhere, look at that worktree, at a sibling worktree or at another git project by calling `mcp__codegraph__codegraph_explore` with `projectPath` set to that checkout, when that tool is available. That one look is enough to settle a doubt and to size the work. If it does not settle it, or the work there is more than a look, delegate an explorer to that checkout and hand it that map. An answer is only ever about the checkout it came from: never present one workspace's answer as another's.
