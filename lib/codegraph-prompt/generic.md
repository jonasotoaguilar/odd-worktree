## CodeGraph

Before you search or read code — `fd`, `find`, `rg`, `grep`, `read` or `cat` — your first call is `mcp__codegraph__codegraph_explore`: pass a question or the names you know (identifiers, file names, the code's own words) and it returns the verbatim, line-numbered source of the relevant code, its call paths, what depends on it and the tests that cover it. Use it to find where something lives or how it works, to follow how one symbol reaches another, to see who calls a symbol and what a change reaches, or to read a file or symbol you can name.

The source it returns is already read: do not open or grep it again. Use `read`, `grep` or `find` only for an exact string, for what it does not index (config, docs, prose) and for a file a ⚠ banner lists as edited after the last index update. If it reports a project as not indexed, stop calling it there. Read a file before editing it.
