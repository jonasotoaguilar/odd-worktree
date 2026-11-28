## CodeGraph

Before you search or read code — `fd`, `find`, `rg`, `grep`, `read` or `cat` — call `mcp__codegraph__codegraph_explore` with the names of the symbols the change touches. It returns their verbatim source with their callers and callees, which show how far a regression could reach and which relationships the change bends, so the sweep covers that radius and not only the diff; the tests it lists show what already pins them.

The answer is a map, never proof: confirm every finding in the source before reporting it, and an answer on its own is not a finding. The source it returns is already read, so confirm there without opening the file again. Use `read`, `grep` or `find` for an exact string, for what it does not index (config, docs) or for a file it flags as changed on disk.
