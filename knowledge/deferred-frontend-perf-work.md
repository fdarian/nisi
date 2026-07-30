---
type: Decision
title: Deferred frontend perf work
description: Two known Files Changed wins not taken, and the correctness risk attached to each.
tags: [frontend, performance, pierre, deferred]
status: stable
generated: { by: claude-code/claude-opus-5, at: 2026-07-30T04:19:29Z }
sources:
  - id: budget
    resource: frontend-performance-budget.md
    title: Files Changed performance budget
  - id: set-viewed
    resource: ../apps/desktop/src/lib/pr-data.ts
    title: useSetFileViewed
---

Both were found while fixing the measured regressions in the
[performance budget](frontend-performance-budget.md).[^budget] Neither was taken, because
each trades against correctness in a way that needs its own verification pass rather than a
drive-by. Recorded so the next person measuring Files Changed doesn't rediscover them from scratch —
and knows why they're still open.

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

[^budget]: Files Changed performance budget
[^set-viewed]: useSetFileViewed
