---
type: Playbook
title: Verifying a frontend change
description: How to prove a UI fix actually landed, and why a Shadow DOM assertion fails open.
tags: [frontend, testing, verification, pierre]
status: stable
generated: { by: claude-code/claude-opus-5, at: 2026-07-30T04:19:29Z }
sources:
  - id: browser-harness
    resource: ../apps/desktop/AGENTS.md
    title: Browser dev harness (apps/desktop/AGENTS.md)
---

# Browser verification is available, and it is the default

`getBackend()` has a dev-only `VITE_DEV_BACKEND_PORT` / `VITE_DEV_BACKEND_TOKEN` escape hatch, so a
plain browser tab drives the real app against a live sidecar. The full recipe — including the
scratch `NISI_DATA_DIR` rule — is in [apps/desktop/AGENTS.md](../apps/desktop/AGENTS.md).[^browser-harness]

Anything that renders in the webview is therefore reachable from browser automation: sticky headers,
row geometry, scroll behaviour, spinners, hit testing. Reach for it before concluding a UI change
can't be verified.

The genuine exceptions are the native surfaces Tauri owns, not the webview: titlebar drag,
double-click-to-zoom, and the ⌘W "Close Tab" menu item. Those need the packaged window.

# A Shadow DOM assertion fails open

`@pierre/diffs` and `@pierre/trees` render into Shadow DOM, so a hit test must pierce it
(`elementFromPoint` then `composedPath()`) **and** name the element the library actually renders. A
diff row is `div[data-line]`.

A predicate written against `data-code` or `data-gutter` matches nothing at every probe point. That
result is indistinguishable from "nothing is overlapping" — which is exactly what a passing sticky
header test looks like. The assertion reports a clean pass while testing nothing.

**Run the control.** Point the same predicate at the unfixed code and confirm it reports the bug. A
predicate that cannot detect the known-broken case cannot confirm the fixed one, and this is the
only cheap way to tell the two apart.

The same shape of error applies to any "absence" assertion here — no overlap, no jump, no
misalignment. Absence is only evidence once you have shown the probe can detect presence.

[^browser-harness]: Browser dev harness (apps/desktop/AGENTS.md)
