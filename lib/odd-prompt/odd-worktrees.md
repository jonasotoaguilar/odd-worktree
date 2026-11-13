## ODD worktrees

A worktree lives at `<repo-parent>/<repo-name>-worktrees/<odd>`: the directory IS the ODD
it serves. `worktree_list` finds existing assignments, so resume one instead of
duplicating it. `worktree_create` creates it; if there are pending changes that belong to
that work, carry them with `copy_changes: true`.

One ODD, one worktree. Work on the same feature goes into its ODD, adding tasks, and
therefore into its worktree; a different feature is a different ODD, with another
worktree. You may delegate several subagents in parallel — on the same or on different
worktrees — as long as they do not edit the same files.

After the merge, keep the branch and remove the worktree, unless a session is standing in
that checkout.
