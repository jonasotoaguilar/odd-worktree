## ODD worktrees

An ODD writes only in its own worktree, never in the primary checkout or on the default
branch; the feature branch lives there. Reading anywhere is fine, and a request that stays
read-only needs no worktree.

A worktree lives at `<repo-parent>/<repo-name>-worktrees/<odd>`: the directory IS the ODD
it serves. Before the ODD's first write, call `worktree_list`: if it already has a
worktree, work there; if not, create it with `worktree_create` (use `copy_changes: true`
if the pending changes of the current checkout belong to that work).

One ODD, one worktree. An ODD is one request and its follow-ups, big or small: everything
that belongs to it goes into the same ODD and worktree, and an unrelated request is another
ODD with its own worktree.

Delegate an ODD's independent units of behavior to agents in parallel, each with the
`workspace_root` of that ODD's worktree; the only limit is that two agents never edit the
same file.

After the merge, update the default branch. Then remove the worktree, keeping its branch,
unless its tree is dirty or a session is standing in it.
