## ODD worktrees

Every write goes in a worktree, whatever the size of the task, a one-line fix included. Never write
in the primary checkout or on the default branch.

A worktree lives at `<repo-parent>/<repo-name>-worktrees/<odd>`: the directory IS the ODD it serves, and
its feature branch lives there. Before your first `edit` or `write`:

1. Run `worktree_list`.
2. If the ODD has a worktree, work there.
3. If not, run `worktree_create` (`copy_changes: true` if the pending changes of the current checkout
   belong to that work).

Reading anywhere is fine, and a request that stays read-only needs no worktree.

One ODD, one worktree. An ODD is one request and its follow-ups, big or small: everything
that belongs to it goes into the same ODD and worktree, and an unrelated request is another
ODD with its own worktree.

Delegate an ODD's independent units of behavior to agents in parallel, each with the
`workspace_root` of that ODD's worktree; the only limit is that two agents never edit the
same file.

After the merge, update the default branch. Then remove the worktree, keeping its branch,
unless its tree is dirty or a session is standing in it.
