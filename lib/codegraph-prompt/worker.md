## CodeGraph

Before you search or read code — `fd`, `find`, `rg`, `grep`, `read` or `cat` — call `mcp__codegraph__codegraph_explore` with the symbol or file you are about to change and the names of what it has to match: identifiers and file names, not a sentence. It returns the verbatim source, what calls it, what it calls and the tests that cover it — what the edit has to keep working. After a refactor call it again to find anything that still points at what moved, and run the tests it lists.

The source it returns is already read, so do not grep it again; you still read a file before you edit it. Use `read`, `grep` or `find` only for an exact string, for what it does not index (config, docs, prose) and for a file a ⚠ banner lists as edited after the last index update. If it reports a project as not indexed, stop calling it there.
