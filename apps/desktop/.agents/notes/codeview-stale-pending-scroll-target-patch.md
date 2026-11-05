Why `patches/@pierre%2Fdiffs@1.6.1.patch` clears `pendingScrollTarget` in `CodeView.reconcileItems()` when the target is removed, and how it was verified.

`reconcileItems()` removes items whose ids no longer appear in the controlled list, then calls
`capturePendingLayoutAnchor()` so the next render can hold the viewport steady across the shrink.
`capturePendingLayoutAnchor` early-returns whenever `this.pendingScrollTarget != null` — correct
while an in-flight `scrollTo()` still targets a _surviving_ item, since capturing a competing anchor
would fight the programmatic scroll. It is wrong when the pending target **is** the item being
removed.

nisi's `scrollToPath` (`apps/desktop/src/features/pull-request/files/diff-pane/diff-pane.tsx`)
fires a smooth `scrollTo({type:"item", id, align:"start", ...})` on every `selectedPath` change,
including a plain sidebar click. With "Hide Reviewed" on, clicking a file and immediately ticking
_that same file's_ Reviewed checkbox — an ordinary sequence — starts that scroll and then removes its
own target before the animation settles. `resolveScrollTargetTop` can't resolve an id that's no
longer in `idToItem`, so the pending target can never complete and the anchor guard stays tripped
indefinitely. `scrollTop` collapses to 0 instead of shifting by the removed file's height, and stays
there.

The patch clears `pendingScrollTarget` (and any `scrollAnimation`) inside `reconcileItems`, only
when the id it points at is among the removed ids. A surviving target is untouched, so a normal
in-flight navigation still wins over anchor capture. Once cleared, the existing
`capturePendingLayoutAnchor` → `getScrollAnchor` → `resolveAnchoredScrollTop` → `applyScrollFix`
path — the one that already handles a plain Reviewed tick with no scroll pending — runs unobstructed.

## A surviving target needs no fix

`resolveScrollTargetTop` re-reads the item's live `.top` every frame from the same item record
`reconcileItems` just relaid out (items matched by id keep their object identity across a
reconcile), and `recomputeLayout` always runs earlier in `computeRenderRangeAndEmit` than target
resolution. A surviving target's destination is never cached, so it can't drift out of sync with a
relayout the way a removed target does.

## How it was verified

Against the patched `CodeView` instance (`window.__INSTANCE`) via the browser harness in
[verifying-frontend-changes.md](./verifying-frontend-changes.md), driving
`scrollTo`/`computeRenderRangeAndEmit` frames manually because a backgrounded tab never fires
`requestAnimationFrame` on its own. Three scenarios, one PR with several hundred files:
- **Tick while scrolling to self** (the bug's trigger): start a smooth `scrollTo` at an item, then
  tick that same item's Reviewed checkbox before any render frame runs. Expected: `pendingScrollTarget`
  is `undefined` afterwards; `scrollTop` moves by the removed item's height plus the sticky-header
  offset term (measured 17628 → 17184, −444px for a 432px item); a surviving neighbour's `<label>`
  `getBoundingClientRect().top` stays put (664px before and after).
- **Plain Reviewed tick, no pending scroll**: same arithmetic through the same anchor path
  (53276 → 52432, −844px for an 832px item; neighbour held at 620px).
- **Plain smooth navigation, nothing removed**: a `scrollTo` ~34,000px away animates over ~60
  simulated 16ms frames, settles at `top - offset` (86376), and `pendingScrollTarget`/
  `scrollAnimation` clear only once genuinely settled — the removal-triggered clear doesn't disturb
  an ordinary scroll.

The extra offset term in the first two is `getScrollAnchorViewportTop`'s sticky-header adjustment,
applied identically by both paths.
