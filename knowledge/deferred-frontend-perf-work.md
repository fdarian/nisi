---
type: Decision
title: Deferred frontend perf work
description: Known Files Changed wins not taken, and one open symptom not yet bisected — with the reason each is still open.
tags: [frontend, performance, pierre, deferred]
status: stable
generated: { by: human:farreldarian, at: 2026-08-15T00:00:00Z }
sources:
  - id: budget
    resource: frontend-performance-budget.md
    title: Files Changed performance budget
  - id: set-viewed
    resource: ../apps/desktop/src/lib/pr-data.ts
    title: useSetFileViewed
---

The first two were found while fixing the measured regressions in the
[performance budget](frontend-performance-budget.md).[^budget] Neither was taken, because
each trades against correctness in a way that needs its own verification pass rather than a
drive-by. The third turned up fixing the Files Changed scroll stutter, deferred for the same
reason — it needs a trace, not a guess. The last entry isn't a fix at all, just an unresolved
symptom worth recording rather than re-investigating blind. Recorded so the next person working on
Files Changed doesn't start any of this from scratch.

# Option identity churn defeats `areOptionsEqual`

`codeViewOptions` and `renderCustomHeader` close over `itemMetadata`, so they get fresh identities
on every recompute. `@pierre/diffs` compares options shallowly — `const forceRender =
!areOptionsEqual(instanceRef.current.options, newOptions)` in `useFileInstance.js:51` — so the
comparison fails and every visible item force-renders, even when nothing about it changed.

Routing these through a ref would hold their identity stable. The catch: `itemMetadata` is also how
the Reviewed checkbox learns its own state, so stabilizing the identity changes *when* a checkbox
update propagates. Getting this wrong makes a checkbox render stale — quieter and worse than the
render cost it saves. Needs a deliberate test of the tick → re-render path, not just a frame-time
measurement.

# `setViewed` invalidates `diff.files` wholesale

Ticking one file invalidates the entire `diff.files` query, which re-runs roughly 15 memos to
repaint one row.[^set-viewed]

This is deliberate today, and the reason is in the code: `changedSinceReview` and the reconciliation
ranges are **server-computed** from the snapshot the write just took, so there is nothing honest to
predict client-side. An optimistic flip would be guessing at values only the sidecar can produce.

The unexplored middle is having the mutation return the updated `FileChange` and patching that one
entry into the cache instead of refetching all of them — server-computed, so still honest, but
without the full-list invalidation. That means a contract change in `review.setViewed`, which is
why it wasn't done as part of a perf pass.

# `SlotPortals` rebuilds every visible header when one item enters the window

`@pierre/diffs`' `SlotPortals` (`dist/react/CodeView.js`) memoizes its portal-children list on
`itemKeys` — every rendered item's `id:version:type`, concatenated. One card entering or leaving
the virtualized window changes that string, so the memo rebuilds portal children for *every*
visible card, not just the one that changed — and it happens inside `onSnapshotChange`'s
`flushSync`, synchronously, mid-scroll-frame.

Our `DiffFileHeader` isn't memoized, and `renderCustomHeader` (`diff-pane.tsx`) closes fresh arrow
functions for `onToggleCollapse`/`onToggleViewed` per item per call, so each rebuild re-renders a
Base UI dropdown tree for every visible file.

Two fixes, neither taken: memoize `DiffFileHeader` and stabilize its callbacks (app-side, nothing
to maintain), or patch `SlotPortals` to cache portals per item id instead of the whole list (the
repo already carries patches, and `@pierre/diffs` is pinned exact). Not done because after the two
fixes that landed in this pass, this may already sit inside the
[budget](frontend-performance-budget.md)[^budget] — it needs a CDP trace before it's worth
touching, not a guess.

# Sticky header flicker in WKWebView — cause unconfirmed

The sticky file header visibly flickers while scrolling, in WKWebView specifically. Three
candidates, none ruled in or out: the portal churn above; `CodeView.applyStickyPositioning`'s
`Math.random()` jitter on the sticky container's `top`/`bottom` offsets
(`dist/components/CodeView.js`); or our own `clip-path` on `<diffs-container>` (`diff-pane.tsx`)
interacting with the sticky header. Not yet bisected.

[^budget]: Files Changed performance budget
[^set-viewed]: useSetFileViewed
