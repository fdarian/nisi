---
type: Decision
title: The @pierre/diffs CodeView stale pendingScrollTarget patch
description: capturePendingLayoutAnchor() suppresses scroll anchoring for the whole duration of any in-flight smooth scrollTo(); if the app removes that scroll's own target item mid-flight, the guard never lifts and scrollTop collapses to 0 instead of compensating.
tags: [frontend, diff-pane, pierre, patches, scroll]
status: stable
generated: { by: claude-code/claude-sonnet-5, at: 2026-08-23T00:00:00Z }
sources:
  - id: verify
    resource: verifying-frontend-changes.md
    title: Verifying a frontend change
---

# Why the patch exists

`CodeView.reconcileItems()` (`patches/@pierre%2Fdiffs@1.3.5.patch`) removes items whose ids no longer
appear in the controlled list, then calls `capturePendingLayoutAnchor()` so the next render can hold
the viewport steady across the shrink. `capturePendingLayoutAnchor` early-returns whenever
`this.pendingScrollTarget != null` — correct while an in-flight `scrollTo()` still targets a
*surviving* item, since capturing a competing anchor would fight the programmatic scroll. It's wrong
when the pending target **is** the item being removed: nisi's `scrollToPath`
(`apps/desktop/src/components/diff-pane/diff-pane.tsx`) fires a smooth `scrollTo({type:"item", id,
align:"start", ...})` on every `selectedPath` change, including a plain sidebar click. With "Hide
Reviewed" on, clicking a file and immediately ticking *that same file's* Reviewed checkbox — a totally
ordinary sequence, not a race the user has to work for — starts that scroll and then removes its own
target before the animation settles. `resolveScrollTargetTop` can't resolve an id that's no longer in
`idToItem`, so the pending target can never complete on its own, and the anchor guard it's blocking
stays tripped indefinitely. Result: `scrollTop` collapses to 0 instead of shifting by the removed
file's height, and stays there.

The fix clears `pendingScrollTarget` (and any `scrollAnimation`) inside `reconcileItems`, but only
when the id it points at is one of the ids being removed — a target that survives the reconcile is
left untouched, so a normal in-flight navigation still wins over anchor capture as before. Once
cleared, the existing `capturePendingLayoutAnchor` → `getScrollAnchor` → `resolveAnchoredScrollTop` →
`applyScrollFix` path — the same one that already handles a plain Reviewed tick with no scroll
pending — runs unobstructed.

# What's verified

Measured directly against the patched `CodeView` instance (`window.__INSTANCE`, set by the teardown
patch's debug hook) via the [browser verification harness](verifying-frontend-changes.md), driving
`scrollTo`/`computeRenderRangeAndEmit` frames manually since this environment's backgrounded tab
never fires `requestAnimationFrame` on its own:

- **Tick-while-scrolling-to-self** (the bug's actual trigger): start a smooth `scrollTo` targeting an
  item, then — before any render frame runs — tick that same item's Reviewed checkbox.
  `pendingScrollTarget` is `undefined` by the next check (cleared), `scrollTop` moved from 17628 to
  17184 (**−444px**, i.e. the removed item's 432px height plus the shared sticky-header offset term
  both anchor paths apply), and a surviving neighbour's `<label>` `getBoundingClientRect().top` held
  at exactly 664px, unchanged.
- **Plain Reviewed tick, no pending scroll** (pre-existing path, reconfirmed unregressed): same math,
  different item — scrollTop 53276 → 52432 (**−844px** = 832px removed height + the same offset
  term), neighbour held at 620px, unchanged. Condition A now reproduces this exactly.
- **Plain smooth navigation, nothing removed**: `scrollTo` to a file ~34,000px away animates over
  roughly 60 simulated 16ms frames and settles precisely at `top - offset` (86376), with
  `pendingScrollTarget`/`scrollAnimation` clearing themselves only once genuinely settled — confirms
  the new removal-triggered clear doesn't fire on, or otherwise disturb, an ordinary in-flight scroll.

The identical extra offset term in both the fixed and pre-existing paths (not just the removed
item's raw height) is `getScrollAnchorViewportTop`'s sticky-header adjustment, applied the same way
in both — evidence the two paths are now doing literally the same computation, not that either has
an off-by-one.

# What's still open

A *surviving* pending target isn't stale the same way: `resolveScrollTargetTop` re-reads the item's
live `.top` every frame from the same mutated item record `reconcileItems` just relaid out (items
matched by id keep their object identity across a reconcile), and `recomputeLayout` always runs
earlier in `computeRenderRangeAndEmit` than the target-resolution step. So a surviving target's
destination is never cached — it can't drift out of sync with a relayout the way the removed-target
case could. Checked, not fixed, because there's nothing to fix.
