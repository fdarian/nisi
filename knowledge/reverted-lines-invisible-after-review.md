---
type: Constraint
title: Content invisible in the base → head diff can't be shown, even reviewed
description: A line added then reverted away lives only in a review snapshot, never in base or head, so no diff between real file states can render it.
tags: [review, reconciliation, tracked-changes, diff-pane]
generated: { by: claude-code/claude-opus-5, at: 2026-08-01T05:48:15Z }
verified: { by: claude-code/claude-sonnet-5, at: 2026-08-08 }
sources:
  - id: reconcile
    resource: ../packages/review/src/reconcile.ts
    title: reconcile(), synthesizeReviewedBaseline()
---

The diff pane now renders a genuine `reviewedBaseline → head` diff (`@repo/review`'s `reconcile()`
synthesizes `reviewedBaseline`; `apps/desktop/sidecar/store.ts`'s `readFileContents` substitutes it
for `base` when computing the patch) — reviewed-and-unchanged content is ordinary context, not an
annotation layer over a `base → head` patch. That fixed the common complaint this note used to
describe: a change already reviewed and then reverted away no longer reads as an untouched diff,
because the divergence between base and head is still there for `synthesizeReviewedBaseline` to
walk.

One case survives, structurally: **`synthesizeReviewedBaseline` only ever walks `base → head`'s own
hunks.**[^reconcile] A line added, reviewed, and reverted *before head ever diverged from base at
that spot* — i.e. base and head end up byte-identical there — leaves no hunk for the synthesis to
walk, so the transient content the review snapshot once held is simply not part of the alignment.
`reviewedBaseline` falls back to copying head's (== base's) text through as context, same as
untouched content anywhere else, and the diff pane correctly but unhelpfully reports "no changes."

# Who hits this

Someone who reviews a change, then the branch gets rebased/amended so that specific hunk vanishes
(not just gets superseded) — round-tripping the file back to what base already had. Rare relative to
the "reviewed, then further edited" case this feature targets, since it requires the *net* diff
against base to fully cancel out, not just move.

# What it would take to fix

A direct `diff(anySnapshot, head)` independent of the `base → head` alignment — which is a different,
heavier computation (which snapshot, of possibly several claims, would even be the one to diff
against for content `base → head` never touched?) and not what `reviewedBaseline` does. Not scoped.

[^reconcile]: reconcile(), synthesizeReviewedBaseline()
