---
"@repo/desktop": patch
---

Fix walkthrough generation failing with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY when the reviewed repo sits inside a pnpm workspace — the claude-code, codex, and opencode harnesses now bootstrap their CLI install under ~/.nisi/harness-sandbox instead of the repo's parent directory.
