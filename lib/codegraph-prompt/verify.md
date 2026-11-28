## CodeGraph

Before you search or read code — `fd`, `find`, `rg`, `grep`, `read` or `cat` — call `mcp__codegraph__codegraph_explore` with the names of the symbols the change touches: identifiers and file names, not a sentence. It returns their verbatim source, their callers and dependents, and the tests that cover them. Choose interaction and regression probes from those callers, run the tests it lists, and call it again on a caller it surfaces when a probe needs the next layer.

The answer is a map, never evidence: a verdict comes from the source you read and the checks you run, and a probe that contradicts the graph is the one that is right. The source it returns is already read; Use `read`, `grep` or `find` only for an exact string, for what it does not index (config, docs, prose) and for a file a ⚠ banner lists as edited after the last index update. If it reports a project as not indexed, stop calling it there.
