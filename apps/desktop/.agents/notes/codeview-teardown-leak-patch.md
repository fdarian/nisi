Why `patches/@pierre%2Fdiffs@1.6.1.patch` sweeps every `CodeView` item on teardown, and the leak that is still open.

`CodeView.cleanAllRenderedItems()` only walked `this.renderState.firstIndex..lastIndex` — the last
virtualization window — before `reset()` wiped that bookkeeping. Any item scrolled out of view
before teardown was skipped, so its `VirtualizedFile`/`VirtualizedFileDiff` stayed subscribed to the
worker-pool singleton's `themeSubscribers` Set after the tab unmounted, pinning that item's
`fileContents` Map of raw diff text. `reconcileItems()` already sweeps the full `this.items` array on
update; teardown never matched it. The patch makes `cleanAllRenderedItems()` do the same full sweep,
and also clears the `window.__INSTANCE` debug hook (set by upstream's `CodeView`) in `cleanUp()` so
it stops pinning the last-mounted instance. The `__INSTANCE` clear sits before `cleanUp()` rethrows
a caught `reset()` failure, so it runs even when `reset()` throws.

As of `@pierre/diffs` 1.6.1 upstream has fixed neither half, so the patch is still necessary.

## What's still open

Measured against `@pierre/diffs` 1.3.6 with the
[CDP heap-retention protocol](./verifying-frontend-changes.md#measuring-heap-retention): orphaned
`themeSubscribers` at zero open tabs went from 11 to 1, and heap retention after closing all tabs
went from 78% of what opening the tabs had added down to ~45%. Both numbers are non-zero — one
subscriber still survives teardown, and the residual ~45% retention hasn't been traced to a cause.
These numbers haven't been re-measured against 1.6.1; start there rather than assume this patch
closed the leak completely.
