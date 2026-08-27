---
"@repo/desktop": patch
---

Fix files in a brand-new, entirely untracked folder showing "Couldn't load this file's diff." instead of their content, with "Include uncommitted" on. Git collapses a fully-untracked directory to one status line instead of one per file, and the content fetch was reading that line directly instead of the same per-file untracked listing the file tree already used.
