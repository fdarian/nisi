---
"@repo/desktop": patch
---

Walkthrough and chat agents now run through the `ai-sandbox-local` package, with their CLI installs kept under `~/.nisi/harness-home`. The first walkthrough per harness reinstalls its CLI there (roughly 13–28s); after that it is warm. The agent no longer sees your own dotfiles such as `~/.gitconfig`. If you ran an earlier version, `~/.nisi/harness-sandbox` is left over and can be deleted.
