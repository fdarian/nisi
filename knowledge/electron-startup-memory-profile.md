---
type: Measurement
title: Where Electron startup time and memory go
description: Cold-start critical path and sustained memory by process for the Electron build, the baseline to beat when squeezing either.
tags: [desktop, electron, performance, memory, startup]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-19T07:00:00Z }
stale_after: 2027-04-19
---

Baseline numbers for the packaged Electron 44 build on Apple Silicon, from October 2026, measured
with `measure-launch`. Re-measure with the same commands before and after an optimisation, since
absolute numbers drift with the machine and GitHub latency. For how to run the tools, see
[launch-timing.md](launch-timing.md).

# Cold start critical path

These are medians of 9 cold runs, each with a fresh data dir, so the sidecar also ran its
migrations from scratch. They were taken in alternation with another shell; reproduce them with:
```sh
bun scripts/measure-launch --cold --runs 10 --discard-first --deeplink https://github.com/fdarian/nisi/pull/173 --cwd <nisi clone>
```
Times are milliseconds since the CLI's `open`.

| ms | Milestone | Gap | What fills it |
|---|---|---|---|
| 416 | `frontend.navigation-start` | 416 | Electron boot, window creation |
| 596 | `frontend.main` | 180 | Renderer parses and runs the bundle |
| 805 | `sidecar.boot` (start) | — | Sidecar spawned from `whenReady`; its `sidecar.boot` span opens |
| 1769 | `sidecar.services.init` (start) | **~960** | Inside the boot span, before the HTTP bind. Not profiled yet. The largest single gap. |
| 1828 | `sidecar.boot` (end) | 60 | SQLite open, migrations, router attach |
| 2128 | `frontend.backend.resolved` | **~300** | `electron/backend.ts` polling `sidecar.json` and health-checking it |
| 2691 | `frontend.events.connected` | **~560** | Event stream connect, after the backend resolved |
| 2726 | `files.loading.painted` | 35 | First app paint |
| 3556 | `pull-requests.open.resolved` | ~830 | GitHub plus worktree work for the PR (not shell-bound) |
| 4169 | `tab.content.painted` | ~610 | Diff fetch, parse and first diff paint |

The window shows app content at about 2.7 s, and nearly all of it is spent waiting on the sidecar.
The renderer is ready at about 0.6 s. Leads, all unverified:
- The ~1 s inside the sidecar before it binds.
- The ~300 ms resolver poll.
- The ~560 ms before the event stream connects.

None of these is engine-bound. A shell switch was measured and doesn't help; see
[electrobun-evaluation.md](electrobun-evaluation.md).

# Sustained memory

These are medians of 2 soak runs (`--soak`, see [launch-timing.md](launch-timing.md)):
fdarian/nisi#158 (211 files) opened and scrolled end to end, then #155, #138 and #134 opened and
scrolled, then tabs closed. Footprint is in MiB with the sidecar excluded.

| Phase | Total end | Renderer peak / end |
|---|---|---|
| Idle after opening #158 | 277 | 162 / 142 |
| After scrolling #158 | 730 | 558 / 545 |
| 4 PR tabs open | 833 | 650 / 644 |
| After closing tabs and idling for 60 s | 695 | 659 / 570 |

Across the whole run:
- **Time-weighted average:** 658 MiB, with a peak of 943 MiB.
- **By process:** the main process stays around 46–54 MiB, and the utility helper at 8 MiB.
- **GPU:** 122 MiB on average, spiking to about 290 MiB while scrolling.
- **Sidecar:** about 124 MiB on average, peaking near 197 MiB while opening PRs.

Two points to work from:
- **The renderer is the lever.** It holds about 75% of the shell's memory and grows by roughly
  400 MiB while one 211-file PR is scrolled end to end.
- **Closing tabs gives little back.** After closing three tabs, the renderer still holds about
  570 MiB, against 142 MiB before any scrolling. Part of that is ordinary heap that hasn't been
  collected. Part may be the residual `@pierre/diffs` CodeView retention described in
  [codeview-teardown-leak-patch.md](codeview-teardown-leak-patch.md). A soak that idles longer
  after closing, or forces GC, would separate the two.
