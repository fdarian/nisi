---
type: Measurement
title: Electrobun (CEF) vs Electron shell
description: Size, cold start, and memory of the Electrobun 2.0.2 + CEF shell against Electron 44, and what it would take to switch.
tags: [desktop, electron, electrobun, performance]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-19T01:30:00Z }
stale_after: 2027-04-19
---

`apps/desktop/electrobun/` is a second desktop shell on Electrobun 2.0.2 with bundled CEF. It
implements the same `window.nisi` `NativeApi` as `electron/`, over Electrobun RPC. Both shells
run the identical frontend and sidecar, so any difference below comes from the shell and its
Chromium build.

**Verdict:** Electrobun is worse or equal on everything measured except the compressed download
size. It also ships an older Chromium. Switching isn't worth it on these numbers. The one lever
that could change that is untested; see [Open question](#open-question).

# Results

Measured on an Apple Silicon Mac, 2026-10-19.

| | Electron 44.7.2 | Electrobun 2.0.2 |
|---|---|---|
| Chromium | 152.0.7977.149 | 147.0.7727.118 (CEF, pinned by the Electrobun release) |
| Installed `.app` | 461 MB | 544 MB |
| Download | 198 MB DMG | 181 MB DMG, 176 MB `.app.tar.zst` |
| Cold launch → renderer navigation start | 443 ms | 1056 ms |
| Cold launch → first app paint (`files.loading.painted`) | 2769 ms | 3222 ms |
| Cold launch → PR diff painted (`tab.content.painted`) | 4205 ms | 4922 ms |
| Memory footprint, PR open, sidecar excluded | 330 MiB | 385 MiB |
| Shell processes (sidecar excluded) | 4 | 7 |

Timings are medians of 14 runs per shell. Memory is the median `phys_footprint`.

Memory footprint by process group, in MiB:

| | Electron | Electrobun |
|---|---|---|
| Main | 55 (`nisi`) | 75 (`launcher` + `bun`) |
| Renderers | 183 (1 process) | 220 (2 processes; the second is about 13 MiB) |
| GPU | 84 | 75 |
| Other helpers | 8 (1 process) | 16 (2 processes) |
| Sidecar | 113 | 114 |

**Variance.** Electron is steady: in the last 9 runs, first paint stayed between 2650 and
2780 ms. Electrobun swings between runs:
- Its best runs beat Electron by about 350 ms (first paint 2310 ms, diff 3832 ms). Its Bun main
  process spawns the sidecar about 200 ms sooner.
- Its typical runs lose by 0.5 to 1 s, with renderer navigation starting 1 to 1.6 s after launch.

The cause of the slow Electrobun runs wasn't investigated. The likely suspects are the
`launcher` → `bun` hop and CEF initialization.

# Method

From `apps/desktop`:

```sh
rm -rf .data/measure-launch/data   # Electron. For Electrobun: .data/measure-launch/electrobun/data
bun scripts/measure-launch --cold --shell electron --memory --json \
  --deeplink https://github.com/fdarian/nisi/pull/173 --cwd /Users/farreldarian/code/fdarian/nisi
```

- **Runs.** Each round ran Electron and Electrobun back to back, for 16 rounds. Each run started
  from a fresh measurement data dir, so the sidecar ran its migrations from scratch.
- **Dropped runs.** Round 1 was excluded because it was the first launch after a build. One run
  per shell failed at teardown ("did not exit after SIGTERM") and was dropped. That leaves 14
  runs per shell.
- **Rounds 1–6 were slower** for both shells, by about 3 s on `tab.content.painted`. That time
  went to the GitHub side of the PR open, not the shell. Medians include those rounds.
- **Memory** comes from `--memory`: a sample 5 s after `trace.done`, with the PR's Files Changed
  painted. It covers every process under the bundle's `Contents/`. RSS was noisier than footprint
  and told the same story: Electron 463 MiB, Electrobun 571 MiB.
- **Timings** count from `measurement.app-launch.start`, the CLI's `open -n -g`.
- **Measurement switches.** The Electrobun bundle measured was a measurement build: `measure-launch`
  sets `NISI_MEASUREMENT_BUILD=1`, which bakes the measurement Chromium switches into
  `chromiumFlags`. Electron appends the same switches at runtime.
- **Size** is `du -sh` of the `.app` and `ls` of the release artifacts. Both bundles include the
  same `sidecar` and `nisi-cli` binaries, about 158 MB.

# Switching costs and gaps

Parity gaps in the prototype:
- No Services menu role.
- The folder picker can't take a title or attach to a parent window.
- Clicking a notification doesn't raise the window.
- No minimum window size.
- "Open in editor" detects editors through Spotlight bundle IDs.
- The traffic-light position was guessed, and nobody has checked it visually.

Electrobun behaviour that differs from Electron:
- **CEF profile location.** The profile lives at
  `~/Library/Application Support/com.nisi.desktop.electrobun/stable/CEF`, regardless of
  `NISI_DATA_DIR`. Dev and prod would share one Chromium profile (and its `localStorage`) and
  contend for its lock. Electron's `userData` override is what prevents this today.
- **No SPA fallback on `views://`.** The bridge preload `replaceState`s to the route before the app
  boots, so reloading a deep route would 404.
- **No context isolation.** Bridge globals are readable from page JS. The risk is low because the
  renderer only loads our own bundle, and the navigation rules block every other origin.
- **First launch self-extracts.** A stable build is a wrapper that replaces itself with the real
  app on first launch, which takes 10–25 s.
- **Chromium switches are build-time only** (`chromiumFlags`), so the measurement flavor is a
  separate build.
- **Closed-source tooling.** The build tool, Hutch, is closed source. Packaging needs a `postBuild`
  hook to put the binaries in `Contents/MacOS`, because a `postWrap` copy is discarded.

Missing from the prototype: `bun dev` integration, the updater, and signing. Electrobun does ship
bsdiff delta updates, which Electron's setup here has no equivalent for.

# Open question

Electrobun's main process is Bun, the same runtime as the sidecar. Running the sidecar in-process
would remove a process (about 114 MiB) and the spawn-and-handshake step, which is about 1.2 s of
cold start before `frontend.backend.resolved`. That could flip both the memory and the startup
comparison. It would break what currently relies on the sidecar being a separate process:
- `sidecar/updater/restart-helper.ts`.
- A sidecar outliving a crashed app.
- `acquireSidecar`'s single-owner lock, which is shared with the CLI.

Untested.
