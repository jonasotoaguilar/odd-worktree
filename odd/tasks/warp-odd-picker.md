# warp-odd-picker — the create wizard asks for the ODD once, and chooses it

Goal: drop the wizard's `Name` field (the checkout's directory IS the ODD) and turn
`Odd` from free text into a picker — `new odd` first, then the ODDs that exist in
`main` — with nothing else in the create changed: same hooks, same symlink
behaviour for an unversioned `odd/`, same background setup, same output lines.

## Specs

- **S1** — «**The wizard asks for `Name` and `Odd` and they are the same thing.** The
  `Name` field must go. The worktree's directory is the ODD; there is no second
  identity.» The wizard's field strip is `Type · Odd`; the branch is derived from
  the type and the ODD, and no surface asks for a second name.
- **S2** — «**`Odd` is free text; it should be chosen, like `Type`.** It becomes a
  dropdown listing the ODDs that already exist … plus an entry to create a new one.
  Choosing that entry takes a typed name.» The ODD is picked from a list, not typed
  from nothing; the one typed case is the new-ODD entry.
- **S3** — «The screenshot he sent shows the row `Type · Name · Odd` and below it a
  stray `Odd: dagea` line; check whether that lower line is a leftover of the old
  field and remove it, so the panel shows each fact once.» The panel renders each
  fact exactly once: no `Name` field and no second `Odd:` echo under the strip.
- **S4** — «1. The ODD list is the ODDs that exist **in `main`** (`main`'s
  `odd/tasks/*.md`), not the checkout the panel runs in. Read it from `main`'s tree.
  2. **First entry is `new odd`.** Choosing it lets him type the name. 3. The
  worktree path is created with that odd name, as it is today.» The list's source is
  the `main` ref's tree; `new odd` is its first entry and the only typed one; the
  create lands in `<repo-parent>/<repo-name>-worktrees/<odd>` exactly as before.
- **S5** — «The tool's parameters do not change: `branch`, `odd`, `copy_changes`.»
  `worktree_create` keeps its three parameters and its exact output lines; `odd`
  stays required and stays the directory name.
- **S6** — «The document itself is **left to the agent**: an agent that starts work
  on an ODD writes `odd/tasks/<odd>.md` with its own file tools when it decides to,
  exactly as it writes any other file. Nothing in this package anticipates that,
  waits for it, or reports it.» No automated step creates the document — not the
  panel, not `worktree_create`, not the hooks — and no output line or notification
  mentions it.
- **S7** — «the create returns before the chain runs, so an output line about the
  file would make the tool synchronous and hide the hooks. It must not.» The
  create's output says nothing about an ODD document, now or later.

## Tasks

- T1: the wizard drops `Name`: the strip is `Type · Odd`, each fact once (S1, S3).
- T2: the `Odd` field lists `main`'s `odd/tasks/*.md` names, sorted, `new odd` first; that entry takes a typed name (S2, S4).
- T3: the create path derives the branch from the type and the ODD, keeps the same directory rule, and nothing anywhere creates or reports an ODD document (S4, S5, S6, S7).
- T4: README and the suites follow; the wizard suite proves a chosen ODD and an escape write nothing (S3, S6).

## Log

- **L1** — «1. **The wizard asks for `Name` and `Odd` and they are the same thing.**
  The `Name` field must go. The worktree's directory is the ODD; there is no second
  identity. 2. **`Odd` is free text; it should be chosen, like `Type`.** It becomes a
  dropdown listing the ODDs that already exist — the `odd/tasks/*.md` documents of
  the repository the panel runs in — plus an entry to create a new one. Choosing
  that entry takes a typed name and **creates `odd/tasks/<odd>.md` in the new
  worktree**, empty, so the ODD exists before work starts. The screenshot he sent
  shows the row `Type · Name · Odd` and below it a stray `Odd: dagea` line; check
  whether that lower line is a leftover of the old field and remove it, so the panel
  shows each fact once.»
- **L2** — «The ODD list is the ODDs that exist **in `main`** (`main`'s
  `odd/tasks/*.md`), not the checkout the panel runs in. **First entry is `new
  odd`.** Choosing it lets him type the name. The worktree path is created with that
  odd name, as it is today. Then, **in the new worktree**, create
  `odd/tasks/<odd>.md` **only if it does not already exist there**. Typing the name
  of an existing ODD is **not an error** … Existence decides the write, not a
  duplicate-name check.»
- **L3** — «The **agent tool** `worktree_create` does the same thing as the panel …
  Keep both surfaces on one implementation — the tool path and the panel path must
  not each grow their own copy of this rule. One helper, called from both.»
  *Withdrawn by L7.*
- **L4** — «The create chain already has a hook that handles `odd/` … a naive write
  to `odd/tasks/<odd>.md` would land **through the symlink into the source
  checkout** — the opposite of what the human wants. So the `.md` creation belongs
  **inside that same hook**, immediately after the symlink is created or confirmed.»
  *Withdrawn by L7.*
- **L5** — «When `worktree_create` writes `odd/tasks/<odd>.md` in the new worktree,
  the tool's output states it — one line naming the file and where it lives … the
  line distinguishes "created" from "already there" — never one line covering both.»
  *Withdrawn by L6.*
- **L6** — «The human corrected it and he is right: the create returns before the
  chain runs, so an output line about the file would make the tool synchronous and
  hide the hooks. It must not. So: **the `worktree_create` output says nothing about
  the ODD document.** Drop that `S#` and any line you already planned. If any
  surface reports it, it is the notification that arrives **after** the background
  chain finishes — the panel's completion path, which already reports setup
  outcomes — never the create's own output.»
- **L7** — «**drop the ODD document creation entirely.** Nothing creates
  `odd/tasks/<odd>.md` — not the panel, not `worktree_create`, not the inputs hook,
  not anywhere. What remains of this ODD is only this: 1. The create wizard no
  longer asks for `Name`; `Odd` is the single identity and `odd` is still the
  directory name. 2. `Odd` is a picker, first entry `new odd` to type a name, the
  rest the ODDs that exist in `main`'s `odd/tasks/`. 3. Everything else about the
  create stays exactly as it is today.» Plus, at closing: «The document itself is
  **left to the agent** … Nothing in this package anticipates that, waits for it, or
  reports it.» L3, L4, L5 and the write half of L2 are history only; S6/S7 are what
  they became.
