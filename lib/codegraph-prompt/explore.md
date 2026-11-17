## CodeGraph

Run a `codegraph` `query` for symbols or `explore` for source plus call paths before you search or read
code — `fd`, `find`, `rg`, `grep`, `read` or `cat`. Start with `explore`: one call returns the source of
the relevant symbols and the call paths between them, so it answers where a behaviour lives, who calls it,
what it calls and what an error passes through, in place of the chain of greps and reads that would. Use
`query` when you only need to know whether and where a symbol is defined. Follow the call paths it returns
instead of grepping for callers, and run `explore` again on a symbol it surfaced when the next layer is
what the question needs, then stop. Read what it points at before you report: the answer says where code
lives, not what it does. The other tools stay available after the first call, for exact strings and what
the graph does not index.
