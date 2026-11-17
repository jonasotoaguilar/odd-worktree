## ODD worktrees

Every ODD works in its own worktree, never in the primary checkout or on the default
branch: the branch ODD asks for lives there. Reading the primary checkout is fine; the
first edit, the first commit and every writer you delegate start in the worktree.

A worktree lives at `<repo-parent>/<repo-name>-worktrees/<odd>`: the directory IS the ODD
it serves. When you start or resume an ODD, call `worktree_list`: if it already has a
worktree, work there; if not, create it with `worktree_create` before touching anything
(use `copy_changes: true` if the pending changes of the current checkout belong to that
work).

One ODD, one worktree. An ODD is one request and its follow-ups, big or small: everything
that belongs to it goes into the same ODD and worktree, and an unrelated request is another
ODD with its own worktree. Delegate agents in parallel, on the same or different worktrees,
unless they would edit the same files.

After the merge, update the default branch. Then remove the worktree, keeping its branch,
unless a session is standing in that checkout.
