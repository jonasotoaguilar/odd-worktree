## CodeGraph

Run one `mcp__codegraph__codegraph_explore` — source plus call paths in one call — before you search or
read code: `fd`, `find`, `rg`, `grep`, `read` or `cat`. Call it with the symbols the change touches: their
callers and callees show how far a regression could reach and which relationships the change bends, so the
sweep covers that radius and not only the diff. The other tools stay available after the first call.

The answer is a map, never proof: confirm every finding in the source before reporting it, and an answer on
its own is not a finding.
