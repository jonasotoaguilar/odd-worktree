## ODD worktrees

A worktree lives at `<repo-parent>/<repo-name>-worktrees/<odd>`: the directory IS the ODD
it serves. Before you create a worktree, start an ODD or resume one, call `worktree_list`:
if the ODD already has a worktree, work there; if not, create it with `worktree_create`
(use `copy_changes: true` if the pending changes of the current checkout belong to that
work).

One ODD, one worktree. An ODD is an area of work: everything within the same area goes into
the same ODD and worktree, and work on a different area is another ODD with its own
worktree. Delegate agents in parallel, on the same or different worktrees, unless they would
edit the same files.

After the merge, update the default branch, then remove the worktree and keep its branch,
unless a session is standing in that checkout.
