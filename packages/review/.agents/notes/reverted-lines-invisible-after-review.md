A line added, reviewed, then reverted so base and head match there is invisible to the diff pane, even though a review snapshot once held it; why, who hits it, and what a fix would take.

The diff pane renders a genuine `reviewedBaseline → head` diff: `@repo/review`'s `reconcile()`
synthesizes `reviewedBaseline`, and `apps/desktop/sidecar/store.ts`'s `readFileContents` substitutes
it for `base` when computing the patch. Reviewed-and-unchanged content is ordinary context, not an
annotation layer over a `base → head` patch. A change reviewed and then edited further therefore
shows up correctly.

One case is structurally invisible: **`synthesizeReviewedBaseline` only walks `base → head`'s own
hunks** (`src/reconcile.ts`). A line added, reviewed, and reverted _before head ever diverged from
base at that spot_ — base and head byte-identical there — leaves no hunk to walk, so the transient
content the review snapshot held is not part of the alignment. `reviewedBaseline` copies head's
(== base's) text through as context, like untouched content anywhere else, and the diff pane
correctly but unhelpfully reports "no changes."

## Who hits this

Someone who reviews a change, then the branch gets rebased/amended so that specific hunk vanishes
(not just gets superseded), round-tripping the file back to what base already had. Rare relative to
the "reviewed, then further edited" case this feature targets, since the _net_ diff against base has
to fully cancel out, not just move.

## What it would take to fix

A direct `diff(anySnapshot, head)` independent of the `base → head` alignment — a different, heavier
computation (which snapshot, of possibly several claims, would be the one to diff against for
content `base → head` never touched?) and not what `reviewedBaseline` does. Not scoped.
