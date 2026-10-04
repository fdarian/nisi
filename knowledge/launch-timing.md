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

Run these commands from the repository root against a worktree with an open PR. Production needs
an installed CLI and app containing the instrumentation:

```sh
env -u NISI_DATA_DIR bun apps/desktop/scripts/measure-launch.ts --cwd /absolute/path/to/pr-worktree
```

For the isolated dev sandbox, start the native app:

```sh
(cd apps/desktop && bun dev)
```

In another terminal, from the repository root, use the `NISI_DATA_DIR` printed by `bun dev`:

```sh
NISI_DATA_DIR=/absolute/path/printed/by/bun-dev \
  bun apps/desktop/scripts/measure-launch.ts \
  --cwd /absolute/path/to/pr-worktree \
  --nisi "$PWD/packages/cli/src/index.ts"
```

The explicit CLI path measures the checkout's implementation rather than the installed CLI.
Keep browser frontends disconnected for a native-only measurement: two frontends can both receive
the request, making the terminal paint mark ambiguous. To prevent an accidental production launch
if the dev sidecar is unavailable, set `NISI_APP_PATH` to a nonexistent scratch `.app` path.

- `--cold` sends SIGTERM to the selected app executable and waits for it to exit before invoking
  the CLI. It is rejected when `NISI_DATA_DIR` is set, so it is not a dev-sandbox option. It does
  not clear caches; a surviving sidecar can still be warm.
- `--json` prints the collected records as a JSON array rather than the formatted report.
- Raw records are JSONL at `<data dir>/logs/launch-traces/<traceId>.jsonl`. Production's data dir is
  `~/Library/Application Support/com.nisi.desktop/`; dev uses the printed sandbox directory.

# Reading the report

All offsets are milliseconds from `cli.process-start`. Negative boot offsets mean the component
was already running; they are not launch latency. Timeline deltas compare adjacent **state marks**,
not exclusive work durations. Subprocesses and RPCs appear separately in the Waterfall; diagnostic
mark-ingestion RPCs are excluded. Slowest first shows at most 15 spans. Parallel spans overlap, so
do not add their durations to estimate the critical path.

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

# Baseline — 2026-10-04

Single native-only run on launch-trace branch revision `5614d52`, **dev sandbox, warm app, PR #87**
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

- **Cold path unverified.** The baseline measures a warm native app, not process startup or an
  installed production build.
- **No Rust-side launch marks.** Activation acknowledgment stands in for window shown. Frontend
  paint marks are animation-frame/DOM proxies, not compositor presentation measurements.
- **One unreproduced native diff-worker timeout.** A native run logged
  `WorkerPoolManager: worker initialization timed out after 10000ms`. Native comparisons on
  `main` (`dbc7930`) and the launch-trace branch against PR #87 did not reproduce it. Main's
  temporary probes confirmed populated diffs after reload; the branch produced the complete trace
  above. Neither a regression nor a pre-existing worker bug is established; no worker fix is implied.
