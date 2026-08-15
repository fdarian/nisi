---
"@repo/desktop": patch
---

Closing a PR tab now releases its diff content from memory. A leak in `@pierre/diffs` kept every file view of a closed tab subscribed to a global worker-pool singleton, pinning its diff text for the lifetime of the app.
