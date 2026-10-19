---
type: Measurement
title: Electrobun (CEF and WebKit) evaluated against Electron
description: Why the desktop shell stays on Electron — startup, snapshot and sustained memory, and size of Electrobun 2.0.2 with CEF or WKWebView, measured against Electron 44.
tags: [desktop, electron, electrobun, performance, rejected-alternative]
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-19T07:00:00Z }
stale_after: 2027-04-19
---

In October 2026 a second desktop shell was built on Electrobun 2.0.2 and measured against
Electron 44.7.2. It ran in two variants:
- **Bundled CEF.** Chromium 147, pinned by the Electrobun release.
- **System WKWebView.**

Both variants implemented the same `window.nisi` `NativeApi` over Electrobun RPC and ran the
identical frontend and sidecar, so every difference below comes from the shell and its engine. The
experiment was then removed. The code is in commits `30a9a51` (CEF shell) and `084b389` (WebKit
variant), and the last commit that contains everything is `0d2d7d0`.

**Verdict: stay on Electron.**
- **Electrobun with CEF** is slower to start, uses 15–22% more memory under sustained use, and
  ships an older Chromium.
- **Electrobun with WebKit** is a third the download size. Its first snapshot didn't use less
  memory, and its page stalls whenever the window is covered, which makes it unworkable for nisi
  as built.

# Results

All figures are physical footprint (`phys_footprint`) with the sidecar excluded. The sidecar is
identical across shells, at about 115 MiB at rest and up to about 190 MiB under load.

## Size

| | Electron | Electrobun CEF | Electrobun WebKit |
|---|---|---|---|
| Installed `.app` | 461 MB | 544 MB | 241 MB |
| DMG | 198 MB | 181 MB | 74 MB |
| Engine | Chromium 152 | Chromium 147 (CEF) | System WebKit |

All three bundles include about 158 MB of compiled `sidecar` and `nisi-cli` binaries.

## Cold start

These are medians of 14 cold runs per shell, alternating between the shells, with deep-link mode
opening fdarian/nisi#173. Each time is measured from the moment the CLI launches the app.

| Milestone | Electron | Electrobun CEF |
|---|---|---|
| Renderer navigation start | 443 ms | 1056 ms |
| First app paint (`files.loading.painted`) | 2769 ms | 3222 ms |
| PR diff painted (`tab.content.painted`) | 4205 ms | 4922 ms |

- **Electron is steady.** Across its last 9 runs, first paint stayed between 2650 and 2780 ms.
- **Electrobun CEF is bimodal.** Its best runs beat Electron by about 350 ms, because its Bun main
  process spawns the sidecar earlier. Its typical runs lose by 0.5 to 1 s, and the cause wasn't
  investigated.
- **WebKit had a single run.** It painted the diff at 2298 ms, which is not comparable with the
  medians above.

## Snapshot memory (5 s after the diff paints)

| | Electron | Electrobun CEF | Electrobun WebKit (1 run) |
|---|---|---|---|
| Total | 330 MiB | 385 MiB | 397 MiB |
| Renderer | 183 MiB | 220 MiB | 297 MiB |
| Main process | 55 MiB | 75 MiB | 49 MiB |
| GPU | 84 MiB | 75 MiB | 33 MiB |

WebKit's lighter GPU and main processes were outweighed by its WebContent process.

## Sustained memory (soak)

The soak (`measure-launch --soak`) samples memory every 2 s over about 12 minutes of scripted use,
driven from inside the frontend:
1. Open fdarian/nisi#158 (211 files).
2. Idle for 60 s.
3. Scroll every file of Files Changed.
4. Open #155, #138 and #134 (125, 92 and 82 files), scrolling each.
5. Close the extra tabs.
6. Idle for 60 s.

The table gives medians: Electron n=2, CEF n=3. One Electron run timed out opening a soak PR, and
the cause wasn't diagnosed.

| | Electron | Electrobun CEF | Δ |
|---|---|---|---|
| Time-weighted average | 658 MiB | 805 MiB | +22% |
| Peak | 943 MiB | 1144 MiB | +21% |
| After scrolling #158 | 730 MiB | 853 MiB | +17% |
| With 4 PR tabs open | 833 MiB | 1065 MiB | +28% |
| After closing tabs and idling for 60 s | 695 MiB | 713 MiB | ≈ |
| Renderer average | 482 MiB | 578 MiB | +20% |
| Main process average | 46 MiB | 89 MiB | +93% |
| GPU average / peak | 122 / 291 MiB | 121 / 283 MiB | ≈ |

Most of the gap is in the renderer, which is Chromium 147 under CEF's Chrome runtime against
Electron's Chromium 152. The rest is in Electrobun's `launcher` + `bun` main process pair.

**WebKit has no soak data.** All three WebKit soak runs failed, and so did a separate snapshot run
on #158:
- Shortly after launch the page reported `document.hidden = true`. The measurement window opens
  without focus and other windows cover it.
- From then on WKWebView suspended the page, and the frontend stopped advancing. Twice it got
  stuck at `pull-requests.open.resolved` and never painted the file list. Once a scroll step went
  unacknowledged for 15 minutes.

Chromium has switches that disable this backgrounding (`MEASUREMENT_CHROMIUM_SWITCHES`), but
WKWebView exposes no equivalent.

The suspension also matters beyond measurement. A WebKit nisi would stop loading a PR that the CLI
opened behind other windows. Measuring WebKit's running memory would need the window kept visible
and in front for the whole run, which wasn't done.

# Method and caveats

- **Tooling.** Measurements used `apps/desktop/scripts/measure-launch`, with `--cold --memory
  --deeplink` and `--soak`; see [launch-timing.md](launch-timing.md). During the experiment it
  also took `--shell electron|electrobun|electrobun-webkit`.
- **Process attribution.** Memory counted every process under the bundle's `Contents/`. For
  WebKit, it also counted the WebContent, Networking and GPU XPC services that macOS charges to
  the app (`responsibility_get_pid_responsible_for_pid`). That method also picks up small system
  services, about 8–30 MiB, which the Chromium shells' totals exclude.
- **Electrobun measurement build.** The Electrobun CEF bundle baked the measurement Chromium
  switches in at build time (`chromiumFlags`), while Electron appends them at runtime.
- **First launch excluded.** Each shell's first launch after a build was discarded.
- **Electrobun stable builds self-extract** on their first launch, which takes 10–25 s.
  Measurements ran against the extracted app.

# Switching costs found (beyond the numbers)

- **The CEF profile ignores `NISI_DATA_DIR`.** It lives under
  `~/Library/Application Support/<identifier>/stable/CEF`, so dev and prod would share one
  profile and contend for its lock.
- **`views://` has no SPA fallback.** Routes had to be set with `replaceState` before the app
  booted.
- **There is no context isolation** for the RPC bridge.
- **Smaller missing features:**
  - No Services menu role.
  - No minimum window size.
  - Clicking a notification doesn't raise the window.
  - The folder picker can't take a title.
- **Packaging needs workarounds.** Packaging goes through Hutch, which is closed source. It needs
  a `postBuild` hook to put the binaries in `Contents/MacOS`, because a `postWrap` copy is
  discarded.

# What could reopen this

Electrobun's main process is Bun, the same runtime as the sidecar. Hosting the sidecar in-process
would remove a process (about 115 MiB) and about 1.1 s of sidecar boot from cold start. It would
also break what currently depends on the sidecar being a separate process:
- `sidecar/updater/restart-helper.ts`.
- A sidecar surviving an app crash.
- The single-owner lock that the sidecar shares with the CLI.

This was not tried.
