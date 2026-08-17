---
"@repo/desktop": patch
---

A PR tab left in the background for 5 minutes now suspends: its diff content unmounts and its cached file contents are released, instead of every open tab staying fully loaded in memory for as long as it's open. Selecting a suspended tab resumes it — your file selection, filters, and search all come back, though scroll position doesn't. A tab with a walkthrough generation still running never suspends. A suspended tab's icon turns into a leaf so you can tell at a glance, and right-clicking any PR tab now opens an in-app menu with a "Suspend" item to suspend it immediately instead of waiting out the timer — disabled (with why) for the tab you're currently viewing, one that's already suspended, or one with a walkthrough generation in progress.
