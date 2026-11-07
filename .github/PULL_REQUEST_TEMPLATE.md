<!--
  Keep a PR small enough to review in one sitting. Two automated gates run on
  every PR (see "Automated Checks" below): the PR title and every commit
  subject must follow Conventional Commits, and the test suite must pass.
-->

## 🔗 Linked Issue

<!-- Use `Closes #NNN` only when this PR completes the issue, otherwise
     `Related to #NNN`. Both are fine; neither is enforced by CI. -->

Closes #

---

## 🏷️ PR Type

- [ ] `feat` — New capability
- [ ] `fix` — Bug fix
- [ ] `docs` — Documentation only
- [ ] `refactor` — No behavior change
- [ ] `test` — Tests only
- [ ] `chore` — Build, CI, or tooling
- [ ] `perf` — Performance
- [ ] Breaking change (`!` in the title, e.g. `feat(warp)!: ...`)

---

## 📝 Summary

<!-- What this PR changes and why. -->

---

## 📂 Changes

| File / Area | What Changed |
|-------------|-------------|
| `path/to/file` | Brief description |

---

## 🧪 Test Plan

```bash
node --test tools/*.test.js
```

- [ ] Tests pass
- [ ] Manually tested in Pi: <!-- which command or tool, and what you saw -->

---

## 🤖 Automated Checks

| Check | Description |
|-------|-------------|
| `CI / Test (Node 18.x, 20.x, 22.x, 24.x)` | `node --test tools/*.test.js` on every supported Node line |
| `PR Check / Check PR Title` | Title follows Conventional Commits (`type(scope): subject`) |
| `PR Check / Check Commit Messages` | Every non-merge commit subject follows Conventional Commits |
| `PR Check / Test (Node 22.x)` | The same suite once, so the PR gate is visible without reading the matrix |

---

## ✅ Contributor Checklist

- [ ] The PR title follows Conventional Commits — it becomes the squash subject
- [ ] Commits follow Conventional Commits, without `Co-Authored-By` trailers
- [ ] Tests pass locally
- [ ] Documentation updated when behavior or surface changed
- [ ] No secrets, tokens, or personal paths in the diff or the logs

---

## 💬 Notes for Reviewers

<!-- Optional: where to look first, or what you are unsure about. -->
