---
"@repo/desktop": patch
---

Harness model discovery no longer leaks a `claude`, `codex`, or `opencode` subprocess on every probe, and discovered models are now cached on disk for a day and served stale-while-revalidating instead of re-probing every few minutes.
