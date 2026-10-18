---
type: Measurement
title: CLI-to-paint launch timing
description: How to measure CLI-to-landing-tab paint, read the milestones, and compare with the native dev baseline.
tags: [cli, desktop, performance]
stale_after: 2027-04-04
---

The launch trace measures **CLI process start → visible landing-tab content**, across the CLI,
sidecar, and frontend. It is opt-in via `NISI_LAUNCH_TRACE=<traceId>`; the measurement script sets
a fresh ID automatically. It does not force a tab: Files Changed ends at the first diff, or the
file list for an empty diff; Overview ends at its content.

# Running a measurement

Run from `apps/desktop` against a worktree with an open PR:

```sh
bun scripts/measure-launch --new-pr --warmup /path/to/other-pr-worktree --cwd /path/to/target-pr-worktree
```

The script runs this checkout's compiled CLI and only targets this checkout's
instances. It never measures or stops `/Applications/nisi.app`; inherited `NISI_DATA_DIR` and
`NISI_APP_PATH` do not select a target.

## Primary: a new PR into a running app

Use `--new-pr --warmup <other PR worktree>` for regression measurements of the common flow:
the app is already running and the target PR has never been opened in it. Both worktrees must
belong to the same repository and resolve to different PRs and branches; validation happens before
stopping the app or resetting data. The script prepares the checkout release bundle, stops only
its app/sidecar, and recreates `.data/measure-launch/new-pr/data/` on every run. It never wipes cold
or dev-sandbox data. A separate CLI trace opens the warm-up and must reach `trace.done` before
the measured CLI open starts. Warm-up timings are not reported. The app remains running afterward.

## Secondary: a running-instance quick check

Without mode flags, use the script for a quick check against whatever is running. It discovers authenticated, healthy sidecars in
`.data/sessions/*/data/` (native `bun dev` sandboxes) and `.data/measure-launch/data/` (the built
measurement app), plus `.data/measure-launch/new-pr/data/`. Zero live candidates is an error; start `bun dev` or use a managed mode. Multiple live
candidates are listed as an ambiguity error; stop the unwanted checkout-local instances first.
It probes instrumentation before handing off and disables CLI app-launch fallback.

Warm mode does not close an existing tab or clear its query cache. The script snapshots the open
session IDs before the traced CLI call and warns when the resulting session was already open:
list/diff paint offsets may reflect cached data, not a fresh-render measurement. The warning appears
in the text report, or on stderr with `--json`; the session snapshot is retained in the raw records.

## App startup: cold processes

Use `--cold` to measure startup of the app and sidecar, including CLI app launch:

```sh
bun scripts/measure-launch --cwd /absolute/path/to/pr-worktree --cold
```

`--cold` uses `release/mac-arm64/nisi.app` (electron-builder's output under `apps/desktop`). It prepares the build, streams any
build output, stops only that exact bundle's app and sidecar
executables, and waits for them to exit. Its gitignored `.data/measure-launch/data/` self-initializes
on the first run. The CLI launches a fresh app instance with that data dir, so `cli.app.launch.*`
is included. The app stays running; repeat without `--cold` to measure it warm:

```sh
bun scripts/measure-launch --cwd /absolute/path/to/pr-worktree
```

To measure native dev instead, stop the built measurement instance, start `bun dev` in this
checkout, then run the same default command from another terminal. No environment override is needed.
Keep browser frontends disconnected for a native-only measurement: two frontends can both receive
the request, making the terminal paint mark ambiguous.

- `--rebuild` requires `--cold` or `--new-pr` and rebuilds even when the bundle exists. A stale bundle without
  instrumentation fails with this hint; a dev instance without instrumentation needs a restart.
- Cold means new app and sidecar processes, not cleared filesystem, GitHub, or review-session caches.
- `--json` prints the collected records as a JSON array rather than the formatted report.
- Raw records are JSONL at `<selected data dir>/logs/launch-traces/<traceId>.jsonl`.

## Measuring the Electrobun shell

`--shell electrobun` (default `electron`) points every managed mode at the Electrobun bundle,
`build-electrobun/stable-macos-arm64/nisi-electrobun.app`, built by `bun run build:electrobun`. Per-shell
paths, executable lists and data dirs live in one descriptor, `scripts/measure-launch/shell.ts`. Electrobun
instances use their own data dirs (`.data/measure-launch/electrobun/{data,new-pr/data}`) and build stamp
(`nisi-electrobun.app.build-stamp.json`), so the two shells never clobber each other. Unmanaged warm mode
looks only at the chosen shell's managed data dirs (plus `bun dev` sandboxes for Electron).

- **Priming.** A stable Electrobun build is a self-extracting wrapper that replaces itself on first launch
  (10-25 s). After a build, and whenever `Contents/Resources/metadata.json` is still present, the script
  launches it once against a scratch data dir, waits for that sidecar, stops it and deletes the dir, so the
  extraction never lands in a measured run. The stamp hashes sources, so priming doesn't stale it.
- **Measurement flavor.** Electrobun can only take Chromium flags at build time, so the script always builds with
  `NISI_MEASUREMENT_BUILD=1`, which makes `electrobun.config.ts` add the three measurement switches plus
  `use-mock-keychain` to `build.mac.chromiumFlags`. Don't ship or install that bundle. Rebuilding by hand with
  `bun run build:electrobun` overwrites it with a non-measurement one.
- **Stopping.** Matches `launcher`, `bun` and `sidecar` under the bundle, SIGTERM only, then also waits for the
  CEF helpers (anything else under `Contents/`) to exit within the same 10 s.

`--shell electrobun-webkit` is a third descriptor for the WebKit build (`bun run build:electrobun-webkit`,
`build-electrobun-webkit/stable-macos-arm64/nisi-webkit.app`). It has its own data dirs
(`.data/measure-launch/electrobun-webkit/...`) and stamp (`nisi-webkit.app.build-stamp.json`), is primed like the CEF
bundle, and builds without Chromium flags (WKWebView has none). It has no in-bundle helpers, so stopping doesn't wait for any.

## Memory (`--memory`)

Valid with any mode. After `trace.done` the script waits `--memory-settle <ms>` (default 5000), then samples every
process whose executable is under `<bundle>/Contents/`: RSS from `ps`, physical footprint from
`footprint -p <pid> --noCategories -f bytes` (works unprivileged for your own processes). Helpers are classified by
their `--type=` argument. The report groups shell main / renderer(s) / GPU / other helpers / sidecar and totals
with and without the sidecar, which is identical between shells. Footprint is the number to compare; RSS counts
shared pages once per process. WebKit's WebContent, GPU and Networking processes are XPC services under
`/System/Library/Frameworks/WebKit.framework`, parented to launchd and outside the bundle, so for
`--shell electrobun-webkit` the script also samples every process whose *responsible PID* (what Activity Monitor
charges; `responsibility_get_pid_responsible_for_pid` from libSystem via `bun:ffi`, works unprivileged) is one of the
app's pids, minus the app's own subprocesses (the sidecar's git/gh). `com.apple.WebKit.WebContent*` is classified
renderer, `com.apple.WebKit.GPU` GPU, the rest other helpers; the sample fails if no renderer is attributed. That
includes system services macOS charges to the app (SetStoreUpdateService, MTLCompilerService, audio SandboxHelper),
which the bundle-prefix match used for Electron and CEF leaves out, so WebKit totals read about 8 MiB of footprint high next to them, ~30 MiB when MTLCompilerService is up. With `--json` and `--memory` the output is `{ "records": [...], "memory": {...} }`
instead of a bare record array.

## Build reuse

Managed modes compare HEAD and a SHA-256 content hash against `nisi.app.build-stamp.json` beside
the bundle (never inside the signed bundle). The hash includes `git diff HEAD --binary` and
untracked, non-ignored file paths and contents, excluding `knowledge/`, Markdown files, and
`apps/desktop/scripts/measure-launch/`. Uncommitted documentation/script edits do not rebuild the
app. A changed HEAD, changed hash, missing bundle/stamp, or `--rebuild` rebuilds with an explicit
reason; matching inputs print a reuse message. The stamp records build time, and report headers
identify the build commit and any uncommitted content hash. A source change during the build
fails rather than stamping an inconsistent artifact.

CLI measurements use the shipped compiled artifact, not `bun packages/cli/src/index.ts`:
managed modes use `nisi.app/Contents/MacOS/nisi-cli`, produced by `build:cli` inside `bun run build`
and covered by the app stamp. Unmanaged warm mode builds only the CLI with the same
`build-binary.ts` compile/sign helper and reuses `.data/measure-launch/cli/nisi` with its own
`nisi.build-stamp.json`. Its content scope covers CLI/transitive workspace packages, dependency
lock/config/patches, and the binary builder, excluding Markdown and tests, not desktop UI or the Electron shell.
The report names the compiled binary and its commit/content hash. Deep-link reports say `CLI: n/a`.

Managed instances opt into `NISI_MEASUREMENT_INSTANCE=1` (renamed from `NISI_MOCK_KEYCHAIN`),
forwarded by the CLI through `open --env` and inherited by the sidecar the Electron main process spawns.
The main process appends Chromium's `use-mock-keychain` switch (`electron/measurement.ts`) to avoid macOS keychain
prompts. The dedicated opt-in accepts no arbitrary Chromium switches; unset production/dev behavior
is unchanged. Mock storage uses a public encryption constant, so keep it confined to isolated
measurement data, never production credentials. Confirm prompt absence on the actual Mac;
trace completion alone is not visual verification of that.

## Deep-link entrypoint

```sh
bun scripts/measure-launch --new-pr --deeplink https://github.com/fdarian/nisi/pull/87 \
  --warmup https://github.com/fdarian/nisi/pull/134 --cwd /Users/farreldarian/code/fdarian/nisi
bun scripts/measure-launch --cold --deeplink https://github.com/fdarian/nisi/pull/87 \
  --cwd /Users/farreldarian/code/fdarian/nisi
```

Here `--cwd` is the repository's local clone, not the target PR checkout; `--warmup` is another
PR URL in the same repository. Unmanaged deep-link measurements are rejected. The script seeds
the existing `pullRequests.recordRepoPath` mapping before injection, matching a user who already
mapped the repository. A traced `needs-repo-path` fails loudly before a folder picker can appear.

No `nisi://` URL is ever handed to the OS. The managed instance's authenticated, environment-gated
diagnostics RPC injects into the same frontend queue as OS-delivered `nisi://` URLs; links retain their trace ID
and replay on event-stream reconnect until acknowledged. Everything from queue dequeue through
`pullRequests.open`, mapping, worktree/session resolution and real paint is the production path.
`NISI_MEASUREMENT_INSTANCE=1` gates both injection and the mock keychain; the old variable no
longer enables either. Production and ordinary dev instances reject injection.

Warm/new-PR offsets start at **frontend deep-link receipt**, excluding OS-to-app URL delivery,
the main-process hop, and the injection RPC transport before receipt. Cold offsets start at
the explicit bundle launch (without the CLI), including startup and mapping preparation. Cold
injection is delivered after the events stream connects, slightly later than the
`takePendingDeepLinks` startup path. Reports state these boundaries; activation ack and pending-panel
milestones are N/A because this flow has neither CLI open requests nor their pending panel.

PR worktrees follow the normal app policy: reuse an existing PR-head/nisi checkout; otherwise
create under the strict-majority parent of existing linked worktrees, or `<data dir>/worktrees/`
when no convention exists. Cleanup snapshots registrations and removes only newly registered paths
backed by successful `git worktree add` spans from this run. Existing/unrelated worktrees are never
removed, removal never uses `--force`, and cleanup also runs on failure. If cleanup is needed, the
managed app is stopped before removal. Git branches/fetched refs are not deleted.

The `pull-requests.open` span and report header distinguish **reused**, **created**, and **retargeted**
worktrees, with the actual path. Compare like outcomes: creation includes checkout and PR-head
fetching, while reuse may skip both. Created worktrees are removed after the run, but Git objects
remain in the repository. After the first created run, later created runs may fetch less; the
report warns about retained objects and flags an already-present local head ref. This is not an
object-cold benchmark—do not label repeated creation as a fresh clone/network transfer measurement.

# Reading the report

All offsets are milliseconds from `cli.process-start`. Negative boot offsets mean the component
was already running; they are not launch latency. Timeline deltas compare adjacent marks and
state-span start/end rows, not exclusive work durations. The Waterfall shows all spans, indented
by parent depth; subprocess and RPC spans are omitted from the state timeline. Slowest first shows
at most 15 leaf subprocess/RPC spans. Parallel spans overlap, so do not add their durations to
estimate the critical path. Sidecar boot records are buffered only until the first traced open;
later warm measurements of the same process do not contain boot milestones.

| Milestone | Meaning |
|-----------|---------|
| `cli.app.launch.end` | The app-launch command returned; not proof of visible content. Absent on a warm handoff. |
| `sidecar.router.ready` | The sidecar router is ready; a negative offset identifies a warm sidecar. |
| `sidecar.activation.acked` | Native activation acknowledged show/unminimize/focus; proxy for window shown, not a compositor timestamp. |
| `pending-panel.painted` | The frontend's pending-open panel reached its animation-frame mark. |
| `files.loading.painted` / `overview.loading.painted` | The landing tab's loading state reached its animation-frame mark; cached opens may skip it. |
| `files.list.painted` | The resolved Files Changed list reached its animation-frame mark; terminal only when no files changed. |
| `files.first-diff.painted` | A rendered diff host is connected and has positive height on an animation frame. |
| `overview.content.painted` | Overview content reached its animation-frame mark. |
| `tab.content.painted { tab }` | The actual landing tab reached its terminal content mark. |
| `trace.done` | Frontend trace collection finished after the terminal mark. |

`Complete` requires both `tab.content.painted` and `trace.done`. Missing milestones are reported as
`not observed`, not zero. The script waits up to 60 seconds; a timeout is an incomplete measurement.
Managed instances disable Chromium's occluded-window backgrounding, renderer backgrounding, and
background timer throttling through three fixed switches gated by `NISI_MEASUREMENT_INSTANCE`.
Before the window opens, `app.commandLine.hasSwitch` confirms each switch (`verifyMeasurementSwitches`); missing switches
fail startup. Successful checks write `<data dir>/measurement-chromium-switches.json` as evidence.
Managed measurements continue through hidden intervals and report those intervals, including for
deep links. A **minimized window may still stall**, as may screen locking; never treat such a
timeout as render latency. Unmanaged instances remain unchanged and stop if visibility is lost.

Managed launches use `open -n -g` with `NISI_MEASUREMENT_INSTANCE=1`. Native activation still
unminimizes and reveals the window and acknowledges afterward, but does not focus or raise it:
`activateMainWindow` (`electron/window-activation.ts`) calls `showInactive()` rather than
`show()`/`focus()`/`app.focus({ steal: true })`, and the main window is created hidden and shown
inactive on `ready-to-show`. The same activation policy applies to OS-delivered deep links; injection
itself never requests native focus. Production and ordinary dev activation remain unchanged.
Verify by sampling `lsappinfo front` before, during and after, without driving the UI: the
measurement instance must never become frontmost, including at startup and while real paint marks
arrive for opens into the running instance. Hidden intervals remain part of the report.

# Baseline — 2026-10-04

Single native-only run, taken on the Tauri/CEF shell, on launch-trace branch revision `5614d52`, **dev sandbox, warm app, PR #87**
(`fdarian/nisi`, Version Packages). The browser frontend was closed; Vite's connected frontend was
the native `nisi Helper`. This is a reference measurement, not a repeated-trial budget.

| Milestone | CLI offset |
|-----------|------------|
| Native activation acknowledged | 331.8ms |
| Pending panel | 509.7ms |
| Files Changed loading | 2995.4ms |
| Files Changed list | 3705.6ms |
| First diff / landing-tab content | 4173.7ms |
| Trace done | 4193.2ms |

About **4.2s to the first diff**. `sessions.open` took **2.6s**, dominated by parallel
`gh pr view` (**1.5s**) and `gh repo view` (**1.1s**), followed by base-ref `git fetch` (**0.9s**).
These are subprocess durations, not additive parallel work. After the Files Changed loading mark,
the resolved list took another **0.7s**; from list to first diff took another **0.5s**.

# Method and its limits

- **Baseline scope.** The reference above measures a warm native dev app, not process startup or
  an installed production build. `--cold` targets a checkout-local release bundle, not production.
- **No main-process launch marks.** Activation acknowledgment stands in for window shown. Frontend
  paint marks are animation-frame/DOM proxies, not compositor presentation measurements.
- **One unreproduced native diff-worker timeout.** A native run logged
  `WorkerPoolManager: worker initialization timed out after 10000ms`. Native comparisons on
  `main` (`dbc7930`) and the launch-trace branch against PR #87 did not reproduce it. Main's
  temporary probes confirmed populated diffs after reload; the branch produced the complete trace
  above. Neither a regression nor a pre-existing worker bug is established; no worker fix is implied.
