## CodeGraph

Run one `mcp__codegraph__codegraph_explore` — source plus call paths in one call — before you search or
read code: `fd`, `find`, `rg`, `grep`, `read` or `cat`. Call it with the symbol you are about to change:
what calls it and what it calls are what the edit has to keep working, and after a refactor you call it
again to find anything that still points at what moved. The other tools stay available after the first
call, and you read a file before editing it — the answer says where code lives, not what it does.
