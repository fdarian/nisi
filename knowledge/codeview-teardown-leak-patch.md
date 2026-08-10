---
type: Decision
title: The @pierre/diffs CodeView teardown leak patch
description: cleanAllRenderedItems() only released items inside the last virtualization window, so items scrolled out of view before a tab closed stayed pinned to the worker-pool singleton forever.
tags: [frontend, performance, pierre, patches]
status: stable
generated: { by: claude-code/claude-sonnet-5, at: 2026-08-10T00:00:00Z }
sources:
  - id: verify
    resource: verifying-frontend-changes.md
    title: Verifying a frontend change
---

# Why the patch exists

`CodeView.cleanAllRenderedItems()` (`patches/@pierre%2Fdiffs@1.3.5.patch`) only walked
`this.renderState.firstIndex..lastIndex` — the last virtualization window — before `reset()` wiped
that bookkeeping. Any item scrolled out of view before teardown was skipped, so its
`VirtualizedFile`/`VirtualizedFileDiff` stayed subscribed to the worker-pool singleton's
`themeSubscribers` Set forever after the tab unmounted, pinning that item's `fileContents` Map of raw
diff text. `reconcileItems()` already swept the full `this.items` array on update — teardown just
never matched it. The patch makes `cleanAllRenderedItems()` do the same full sweep, and also clears
the `window.__INSTANCE` debug hook in `cleanUp()` so it stops pinning the last-mounted `CodeView`.

# What's still open

Measured with the [CDP heap-retention protocol](verifying-frontend-changes.md#measuring-heap-retention):[^verify]
orphaned `themeSubscribers` at zero open tabs went from 11 to 1, and heap retention after closing all
tabs went from 78% of what opening the tabs had added down to ~45%. Both numbers are non-zero — one
subscriber still survives teardown, and the residual ~45% retention hasn't been traced to a cause.
The next investigation should start there rather than assume this patch closed the leak completely.

[^verify]: Verifying a frontend change
