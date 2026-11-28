## CodeGraph

`mcp__codegraph__codegraph_explore` is your first tool, not a fallback: it queries a prebuilt index of the code's symbols, calls and dependencies. Call it before you search or read code — `fd`, `find`, `rg`, `grep`, `read` or `cat` — to:

- find where something lives or how it works;
- follow how one symbol reaches another, or what an error passes through;
- see who calls a symbol, what it calls and what a change reaches;
- survey an unfamiliar area;
- read a file or symbol you can name: put its name or path in the query.

It returns verbatim, line-numbered source, the call paths between the symbols (dynamic dispatch, routes and cross-language calls included), what depends on them and the tests that cover them. Query with identifiers, file names and the domain's nouns, not a sentence. If the answer misses, call again with a name it surfaced, and again on a symbol it surfaced when the next layer is what the question needs, then stop.

Cite `path:line` from the answer: its source is already read, so do not open or grep those files again. Use `read`, `grep` or `find` only for an exact string, for what it does not index (config, docs, prose) and for a file a ⚠ banner lists as edited after the last index update. If it reports a project as not indexed, stop calling it there.
