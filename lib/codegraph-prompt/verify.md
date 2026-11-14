## CodeGraph

Run one `mcp__codegraph__codegraph_explore` — source plus call paths in one call — before you search or
read code: `fd`, `find`, `rg`, `grep`, `read` or `cat`. Call it with the name of a symbol the change
touches: the callers and dependents it returns are what you choose interaction and regression probes from,
and you call it again on a caller it surfaces when a probe needs the next layer. The other tools stay
available after the first call.

The answer is a map, never evidence: a verdict comes from the source you read and the checks you run, and
a probe that contradicts the graph is the one that is right.
