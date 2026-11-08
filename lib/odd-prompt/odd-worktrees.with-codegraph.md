## ODD worktrees

Each ODD feature has its own worktree.

Starting a new ODD: create its worktree (`worktree_create`) before writing
anything.

Resuming an ODD: check whether it already has an associated worktree. If it does,
resume it there; if it does not, create it. ODD work never starts in the principal
checkout.

`worktree_create` places the checkout at `<repo-parent>/<repo-name>-worktrees/<name>`
and runs `codegraph init` there, so the new checkout has its own index from the
start. Edits and writes trigger a background `codegraph sync` for that checkout.
Every worktree keeps its own `.codegraph/`; never copy, symlink or reuse another
checkout's index.

When the work is merged into the trunk, remove the checkout (`worktree_delete`) —
the branch is kept, so the merge comes first.
