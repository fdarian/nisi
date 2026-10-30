---
"@repo/cli": minor
"@repo/desktop": minor
---

Guides are kept per repo and branch in nisi's data dir instead of in each worktree's `.nisi/guide`, so a guide follows its branch and survives worktree cleanup. `nisi guide path` prints (and creates) the folder to write into, and `check` and `render` use it. A guide still in `.nisi/guide` keeps showing until it is moved.
