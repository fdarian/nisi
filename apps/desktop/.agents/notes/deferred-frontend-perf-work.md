Known Files Changed performance wins not taken, one open symptom not yet bisected, and why each is still open.

Each of the first three trades against correctness in a way that needs its own verification pass
rather than a drive-by. Check against the [performance budget](./frontend-performance-budget.md)
before touching any of them.

## Option identity churn defeats `areOptionsEqual`

`codeViewOptions` and `renderCustomHeader` close over `itemMetadata`, so they get fresh identities
on every recompute. `@pierre/diffs` compares options shallowly (`!areOptionsEqual(instanceRef.current.options,
newOptions)` in `useFileInstance.js`), so the comparison fails and every visible item force-renders
even when nothing about it changed.

Routing these through a ref would hold their identity stable. The catch: `itemMetadata` is also how
the Reviewed checkbox learns its own state, so stabilizing the identity changes _when_ a checkbox
update propagates. Getting this wrong renders a stale checkbox — quieter and worse than the render
cost it saves. It needs a deliberate test of the tick → re-render path, not just a frame-time
measurement.

## `setViewed` invalidates `diff.files` wholesale

Ticking one file invalidates the entire `diff.files` query, which re-runs roughly 15 memos to
repaint one row (`useSetFilesViewed`, `src/features/pull-request/data/pr-data.ts`).

This is deliberate: `changedSinceReview` and the reconciliation ranges are **server-computed** from
the snapshot the write just took, so there is nothing honest to predict client-side. An optimistic
flip would guess at values only the sidecar can produce.

The unexplored middle is having the mutation return the updated `FileChange` and patching that one
entry into the cache instead of refetching all of them — server-computed, so still honest, without
the full-list invalidation. That is a contract change in `review.setViewed`.

## `SlotPortals` rebuilds every visible header when one item enters the window

`@pierre/diffs`' `SlotPortals` (`dist/react/CodeView.js`) memoizes its portal-children list on
`itemKeys` — every rendered item's `id:version:type`, concatenated. One card entering or leaving the
virtualized window changes that string, so the memo rebuilds portal children for _every_ visible
card, synchronously inside `onSnapshotChange`'s `flushSync`, mid-scroll-frame.

`DiffFileHeader` isn't memoized, and `renderCustomHeader` (`diff-pane.tsx`) closes fresh arrow
functions for `onToggleCollapse`/`onToggleViewed` per item per call, so each rebuild re-renders a
Base UI dropdown tree for every visible file.

Two fixes, neither taken: memoize `DiffFileHeader` and stabilize its callbacks (app-side, nothing
to maintain), or patch `SlotPortals` to cache portals per item id instead of the whole list (the
repo already carries patches, and `@pierre/diffs` is pinned exact). This may already sit inside the
budget; it needs a CDP trace before it's worth touching, not a guess.

## Sticky header flicker in WKWebView — two candidates unconfirmed

The sticky file header visibly flickered while scrolling in WKWebView. The shell is now Electron
(Chromium), and whether the flicker exists there is unchecked.

One candidate is confirmed and fixed: `CodeView.applyStickyPositioning` drew a fresh `Math.random()`
offset on every render pass where sticky bounds changed and wrote it into the sticky container's
inline `top`/`bottom` (`dist/components/CodeView.js`). Upstream added it deliberately as polish for
the paged-scroll coordinate rebasing (`github.com/pierrecomputer/pierre`,
`packages/diffs/src/components/CodeView.ts`, PR #633), which activates only past
`SCROLL_REBASE_THRESHOLD` (11,000,000px, `CodeView.js:114-118`) — real PRs in nisi run ~400,000px of
scroll height, so the path it masks never engages while the jitter was paid on every render.
Removed in `patches/@pierre%2Fdiffs@1.6.1.patch`. Verified in a Chromium preview, not in the
WKWebView it was reported in.

**Untested**: the `SlotPortals` portal churn above, and nisi's own `clip-path` on
`<diffs-container>` (`diff-pane.tsx`) interacting with the sticky header. Neither has been bisected.
