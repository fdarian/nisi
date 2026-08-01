---
type: Constraint
title: Reverted lines are invisible after review
description: Content that existed only in a review snapshot has no row in the base → head diff, so nothing renders it.
tags: [review, reconciliation, tracked-changes, diff-pane]
generated: { by: claude-code/claude-opus-5, at: 2026-08-01T05:48:15Z }
verified: { by: claude-code/claude-opus-5, at: 2026-08-01 }
sources:
  - id: reconcile
    resource: ../packages/review/src/reconcile.ts
    title: reconcile()
  - id: review-state
    resource: ../apps/desktop/src/lib/pr-data.ts
    title: useReviewState
---

Files Changed renders exactly one diff — `base → head` — and reviewed-ness is an *annotation layer*
over it, never a second diff. `reconcile()` iterates `baseHeadHunks` and splits each hunk's head-line
range into `reviewed`/`new` sub-ranges; nothing outside that domain can produce a
range.[^reconcile]

The consequence, which is not obvious from the algorithm: **a line that lived only in the review
snapshot can never be shown.** Add a line, commit, tick Reviewed, then drop the commit — the line is
absent from base and absent from head, so `base → head` has no row for it. Git agrees; there is no
deletion in that diff to render. The reviewed snapshot is the only artifact that ever contained it,
and the snapshot is not a diff side.

This is not silent. `changedSinceReview` fires anyway, off a separate check — `claim.ranges === null
&& claim.snapshotContent !== headContent` — which is deliberately independent of whether any range
survives.[^reconcile] The file gets its "Modified after review" badge and the sidebar's orange
dot,[^review-state] and the Reviewed tick reads as stale. So the *signal* is correct; only the
*content* of the change is unrenderable.

# Who hits this

Anyone who reverts, rebases away, or amends out a change they had already reviewed — common enough
when a reviewer follows a branch that's still being rewritten. Expect the report to arrive as "the
detection works but the diff looks untouched," which reads like a bug in the change-detection work
and isn't.

# What it would take to fix

Rendering `reviewed → head` for diverged files instead of `base → head`. That is a genuinely
different diff, in different line coordinates, so it is not reachable by extending the annotation
overlay: the diff pane, the wire shape in `packages/sidecar-api/src/diff.ts`, and every consumer of
head-coordinate line numbers would all have to accept two coordinate spaces. Nobody has scoped it.

Note the root `AGENTS.md` describes tracked changes as showing you "`reviewed → head`, not the whole
file again." That's the user-facing *effect* — achieved by collapsing already-reviewed runs of the
base → head diff, not by diffing against the snapshot. The distinction is the whole of this
constraint.

[^reconcile]: reconcile()
[^review-state]: useReviewState
