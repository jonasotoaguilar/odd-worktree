## ODD worktrees

Each ODD feature has its own worktree.

Starting a new ODD: create its worktree (`worktree_create`) before writing
anything.

Resuming an ODD: check with `worktree_list` whether it already has an associated
worktree. If it does, resume it there; if it does not, create it. ODD work never
starts in the principal checkout.

`worktree_create` places the checkout at `<repo-parent>/<repo-name>-worktrees/<name>`,
where `<name>` defaults to the branch with its first segment dropped
(`feat/login` → `login`). Setup runs in the background, so the checkout is usable
before it finishes; `worktree_list` says where it stands.

Deleting a checkout and warping are the human's actions, taken from `/warp`.
Never remove a checkout and never warp on your own. Once the work is merged into
the trunk the branch is kept, and the checkout can be removed from `/warp`.
