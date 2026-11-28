## CodeGraph

CodeGraph is this project's pre-built index of every symbol, call and dependency. `mcp__codegraph__codegraph_explore` answers from it in one call: pass a question or the names you know — symbols, files, the code's own words — and it returns the verbatim, line-numbered source of the relevant code, the call paths between it and what depends on it, and the tests that cover it.

Before you `grep`, `rg`, `fd`, `find`, `read` or `cat`, and before you delegate a lookup to an explorer, make it your first call whenever the task is to:

- find where something lives or how it works, or follow a flow from one symbol to another;
- change, add or reuse something in code you have not read — "use the checking colour", "add an option to X": it shows the code to match and what the change reaches;
- size, scope or hand off work: one call names the files, callers and tests involved;
- read a file or symbol you can name: put its name or path in the query.

Name things the way the code does: identifiers, file names and the domain's own nouns beat a sentence, and filler such as "where is it defined and used" dilutes the match. If the answer misses, call again with a name it surfaced; one to three calls settle most questions. The one exemption is an exact string or a file path the user gave you.

The source it returns is already read: do not open those files again or grep to double-check it. Use `read`, `grep` or `find` for what it does not index (config, docs, prose) or for a file it flags as changed on disk. Delegate to an explorer only when a few calls have not settled it.

It answers only for the checkout the session runs in, and each worktree is its own workspace with its own index. An ODD works in its own worktree: when the session runs elsewhere, look at that worktree, at a sibling worktree or at another git project by calling `mcp__codegraph__codegraph_explore` with `projectPath` set to that checkout, when that tool is available. That one look is enough to settle a doubt and to size the work. If it does not settle it, or the work there is more than a look, delegate an explorer to that checkout and hand it that map. An answer is only ever about the checkout it came from: never present one workspace's answer as another's.
