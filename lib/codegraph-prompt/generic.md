## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, what depends on the symbols you name, and the tests that cover them. Its blocks count as a Read of those files.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` when you are about to change code you have not read, tracing a flow or an error across files, sizing up what a change would reach, or reading a file whose neighbours you do not know. Name the symbols or files when you know them; a plain question works when you do not. Read an exact file path, or search an exact string, directly.
