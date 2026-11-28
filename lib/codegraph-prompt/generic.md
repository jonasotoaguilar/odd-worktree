## CodeGraph

`mcp__codegraph__codegraph_explore` returns, in one call, the source verbatim with line numbers, the call paths between those symbols, what a change reaches, and the tests that already touch it.

Call it before you `grep`, `rg`, `fd`, `find`, `read` or `cat` when you are about to change code you have not read, tracing a flow or an error across files, sizing up what a change would reach, or reading a file whose neighbours you do not know. Name the symbols or files when you know them; a plain question works when you do not. The one exemption is an exact string or a file path you were given.

The source it shows is already read, and you read the files the answer sends you to. Read a file before you edit it.
