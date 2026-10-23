---
name: debug-nisi
description: Debug the running nisi app when it misbehaves — stale state (e.g. a stale merge button or PR status), a wrong or outdated diff, a stuck or empty UI, a session that won't open or refresh — or whenever asked to inspect, diagnose, or debug the live sidecar. Read-only; never drive the app.
---

# Debugging a running nisi

Work from cheapest evidence to most expensive, and stop as soon as something explains the symptom.

## 1. `nisi debug`

```sh
nisi debug                 # every open session + recent RPC failures, anomalies marked with "!"
nisi debug --session <id>  # one session (the id is sessions.publicId)
nisi debug --json          # raw snapshot
```

It asks the running sidecar for its in-memory state (the snapshot's shape is documented in
`packages/sidecar-api/src/diagnostics.ts`; the implementation is `apps/desktop/sidecar/diagnostics-snapshot.ts`).
It is read-only and never starts background work. If it says no sidecar is running, the app is not up
(or you are pointed at the wrong data dir, see 4); do not try to start it.

Anomalies it flags, and what they usually mean:
- `repoRoot is missing on disk` — the worktree was deleted or moved; anything that shells out against it fails.
- `worktree HEAD ... differs from stored head` — the checkout moved to another commit or branch than the
  session was opened for. Can be a false positive in a nisi-created worktree whose local branch name
  differs from the PR's `headRef`.
- `open PR is unwatched with no poll scheduled` — merge status only re-polls while the PR is watched
  (`packages/git/src/github/gh/watch.ts`, `mergeStatusInterval`), so the UI keeps showing the last value.
- `rpc failures` — a handler keeps failing; the log has the full cause (see 3).

## 2. Persisted state: SQLite

Always `-readonly`; the sidecar holds the file open in WAL mode.

```sh
sqlite3 -readonly "<data dir>/app.db" "select id, publicId, repoRoot, prNumber, headRef, closedAt from sessions where closedAt is null"
```

Schemas live in `packages/review/src/db/schema.ts`, `packages/walkthrough/src/db/schema.ts`,
`packages/settings/src/db/schema.ts`. The ones that matter:
- `sessions` — one row per review. `publicId` is the id on the wire and in `nisi debug` output;
  `id` is the integer foreign key. `closedAt IS NULL` means an open tab. `repoRoot`, `owner`/`repo`/`prNumber`
  (null for a branch session), `baseRef`, `headRef`, `updatedAt`.
- `reviewed_files`, `review_range_claims` — tracked-changes state, keyed by integer `sessionId` -> `sessions.id`.
  `snapshotHash` points into `<data dir>/blobs`.
- `walkthroughs` — keyed by `sessionId` text = `sessions.publicId`.
- `scheduled_merges`, `repo_paths`, `repo_merge_methods`, `settings` — see the settings schema.

## 3. Sidecar log

`<data dir>/logs/sidecar.log` (rotates to `sidecar.log.1` at 10MB), logfmt lines. Default level is `info`;
`LOG_LEVEL=debug` has to be set on the sidecar's own environment to see more.

```sh
grep 'rpc call failed' "<data dir>/logs/sidecar.log" | tail            # path=<proc.name> on each line
grep -i 'RepoPathNotFound\|WorktreeRelocationFailed' "<data dir>/logs/sidecar.log" | tail
grep 'level=ERROR\|level=WARN' "<data dir>/logs/sidecar.log" | tail -50
```

## 4. Which data dir

- Production app: `~/Library/Application Support/com.nisi.desktop/` (what a plain `nisi` targets).
- Dev sandbox (`bun dev` in `apps/desktop`): `apps/desktop/.data/sessions/<slug>/data/` under the worktree
  that ran it. `bun dev` prints a copy-pasteable `NISI_DATA_DIR=<path>` line; prefix any `nisi` command
  with it to inspect that sandbox, e.g. `NISI_DATA_DIR=<path> nisi debug`. See `apps/desktop/AGENTS.md`
  "Dev/prod isolation".

## Do not

- Do not read `sidecar.json` or call the sidecar's API with its token directly. `nisi debug` is the
  sanctioned path and never exposes the token.
- Do not write to `app.db`, and do not drive the app UI to reproduce; reason from the evidence above.
