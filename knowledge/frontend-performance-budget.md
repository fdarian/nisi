---
type: Budget
title: Files Changed performance budget
description: What scrolling and interaction should cost in Files Changed, measured at 221 changed files.
tags: [frontend, performance, pierre]
status: stable
generated: { by: claude-code/claude-opus-5, at: 2026-07-30T04:19:29Z }
verified: { by: process:cdp-trace, at: 2026-07-29T00:00:00Z }
stale_after: 2027-01-30
sources:
  - id: one-tree
    resource: ../apps/desktop/src/components/files-sidebar/file-tree-view.tsx
    title: "commit 3e1490d — render the files sidebar as one virtualized tree"
    last_modified: 2026-07-29
  - id: parse-once
    resource: ../apps/desktop/src/components/diff-pane/diff-pane.tsx
    title: "commit 4ddd2fb — parse each file's diff once, not once per file per keystroke"
    last_modified: 2026-07-29
---

Reference numbers for a session with **221 changed files**. They exist so "the sidebar feels laggy"
can be checked rather than argued about. Both sets are post-fix; the pre-fix column is what a
regression would look like.

# Sidebar scroll[^one-tree]

|                  | regressed | budget |
|------------------|-----------|--------|
| rows in DOM      | 258       | 36     |
| shadow-DOM nodes | 8351      | 1288   |
| main-thread busy | 454–474ms | 387–434ms |
| tasks ≥16ms      | 1–3       | 0      |
| longest task     | 22–24ms   | 14ms   |
| HitTest          | 221–238ms | 45–51ms |

Row count is the leading indicator and the cheapest to check. `@pierre/trees` only windows rows its
own scroller can show, so **sizing the tree host to fit its content silently disables
virtualization** — `scrollHeight === clientHeight` means the window covers everything. The host must
stay bounded (today: `min-h-0 flex-1`). Any change that computes a host height from item count
brings the 258-row state back.

# Interaction[^parse-once]

Idle-gated, n=5, medians.

|               | regressed | budget |
|---------------|-----------|--------|
| click one file — main-thread busy | 237ms | 201ms |
| click one file — longest task     | 95ms  | 32ms  |
| mark reviewed — main-thread busy  | 445ms | 197ms |
| mark reviewed — longest task      | 86ms  | 34ms  |
| diff parses per Reviewed tick     | ~3300 | 0     |

Parse count is the leading indicator here. A full Myers diff runs per file per recompute unless
`resolveFileDiff`'s cache hits, so any new dependency folded into the `items` memo can take this
from 0 back to thousands without changing a visible frame time on a small PR.

# Method and its limits

Chrome DevTools Protocol tracing with backgrounding and throttling disabled, trials gated on idle.
Scroll input is a **synthetic 60Hz wheel, not a real trackpad**, so these numbers compare well
against each other and against a future run of the same script — they are not a claim about
perceived smoothness on device.

One trap worth naming: an all-threads trace aggregate makes this look far worse than it is.
`@pierre/diffs` does its parsing on worker threads, and those 42–122ms tasks are not jank. Read the
main thread only.
