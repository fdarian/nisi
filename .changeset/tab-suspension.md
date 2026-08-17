---
"@repo/desktop": patch
---

A PR tab left in the background for 5 minutes now suspends: its diff content unmounts and its cached file contents are released, instead of every open tab staying fully loaded in memory for as long as it's open. Selecting a suspended tab resumes it — your file selection, filters, and search all come back, though scroll position doesn't. A tab with a walkthrough generation still running never suspends.
