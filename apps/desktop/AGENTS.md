# @repo/nisi

Tauri 2 desktop app: the port/token handshake between Rust and the Bun/Effect sidecar, the
sidecar's git/review/walkthrough/settings domains, and a frontend wired to that live contract —
see `PLAN.md` at the repo root for the phase breakdown (all four phases are built) and
`apps/desktop/sidecar/AGENTS.md` for how the sidecar's own pieces fit together.

Three parts, one seam:
- `src-tauri/` — **Rust, intentionally thin.** Spawns/discovers the sidecar, hands `{ port, token }` to
  the frontend via the `get_backend` command. No business logic.
- `sidecar/` — the real backend, a long-running Bun process (Effect). Implements `packages/sidecar-api`'s
  contract by composing `@repo/git` (pure PR/diff detection) and `@repo/review` (SQLite persistence)
  behind one `Store` service — see `sidecar/AGENTS.md`.
- `src/` — React frontend (TanStack Router file-based routes, shadcn on the `@coss` (coss ui / Base UI)
  registry). Two routes: `/` (`AppShell` — multi-PR tab strip + Files Changed sidebar + diff pane) and
  `/settings` (Phase 4, `Cmd/Ctrl+,`), each wired to the live sidecar contract through `src/lib/pr-data.ts`
  / `src/lib/settings-data.ts` (oRPC + TanStack Query via `backend-context.tsx`). `settings-data.ts` is
  the one place that reads/writes `@repo/settings`-backed prefs (`sidebarViewMode`, `diffStyleMode`,
  `enabledHarnesses` for the settings page's checkboxes) — theme is the one exception, staying in
  `localStorage` via `next-themes` (wired in `routes/__root.tsx`) since nothing server-side reads it.
  The diff pane (`src/components/diff-pane/`) renders with `@pierre/diffs`, same shadow-DOM/Worker-pool
  shape as the `@pierre/trees` sidebar — `src/lib/build-collapsed-diff.ts` slices a file's patch down to
  `FileContentReview.ranges`' `"new"` spans for Phase 2's collapsed reviewed regions.

## The seam
The sidecar binds an ephemeral port, generates a token, deletes any stale `sidecar.json` *before*
binding, then writes `{ port, token }` to `sidecar.json` (mode 0600) in the app-data dir — macOS
`~/Library/Application Support/com.nisi.desktop/` (override with `NISI_DATA_DIR`). Rust's `get_backend`
(`src-tauri/src/lib.rs`) polls for that file **asynchronously** — it must never block the main thread,
or the frontend's one-shot `invoke('get_backend')` wedges on a cold start. Regression-tested by the
`#[tokio::test]`s in `lib.rs` — keep them if you touch that file.

- **Dev**: `bun dev` runs `scripts/dev.ts`, a [devsess](https://devsess.fdarian.com/) orchestrator
  (see below) that races the sidecar against `tauri dev` (`Effect.raceAll` — either exiting kills
  the other, via each process's Effect `Scope`). `beforeDevCommand` only runs `vite`; the sidecar
  is started by `dev.ts`, not by Tauri.
- **Prod**: Rust spawns the compiled `binaries/sidecar` (`externalBin`, `shell:allow-spawn`) from
  `.setup()` — fire-and-forget.
- Sidecar boot (`sidecar/index.ts`) is one Effect program run via `BunRuntime.runMain`: the HTTP server
  is acquired/released with `Effect.acquireRelease` inside `Effect.scoped`, so SIGINT/SIGTERM (which
  `runMain` already listens for) interrupts the fiber and the release closes the server — no manual
  `process.on()` needed.

## Dev/prod isolation
Dev and prod both resolve their data dir (`sidecar.json` + `app.db`, see [The seam](#the-seam))
from `NISI_DATA_DIR`, defaulting to the same path — `~/Library/Application Support/com.nisi.desktop/`
— when it's unset. Left alone, that means a `bun dev` sidecar and the production app's sidecar
fight over the same `sidecar.json` and the same SQLite file, and whichever wrote `sidecar.json`
last is the one `nisi` (or the window you're looking at) actually talks to — this is what caused
production to show a stale PR list while a dev server had the fresh one.

`scripts/dev.ts` fixes this with [devsess](https://devsess.fdarian.com/): each `bun dev` run resolves
(or creates) a **session** — a directory under `apps/desktop/.data/sessions/<slug>/` (gitignored,
`<slug>` a generated word like `walrus`, not something you choose) — and sets `NISI_DATA_DIR` to
that session's own `data/` subdirectory before starting the sidecar and `tauri dev`. Each git
worktree resolves its own `apps/desktop/.data/sessions/` tree, so two worktrees' dev sessions never
share one either. `dev.ts` also reads a sticky vite port from the session (`getStickyPort`) and
passes it to `tauri dev` via `-c '{"build":{"devUrl":...}}'`, so the frontend port stays stable
across restarts of the same session too.

`dev.ts` prints `NISI_DATA_DIR=<path>` on startup — that line is deliberately copy-pasteable.
Since prod keeps the untouched default, a plain `nisi` from a terminal always reaches the
**production** app; pointing it at a dev session instead is `NISI_DATA_DIR=<path from that line> nisi`.
There's no flag or auto-detection for this by design (see root `PLAN.md`'s "The seam" for why
`packages/cli` doesn't get special-cased here) — and note the override only works this way because
you set it yourself: devsess sets `NISI_DATA_DIR` only for the subprocesses `dev.ts` itself spawns
(`runManagedSubprocess` merges `env` into *that child's* environment), never for a separate shell
you happen to have open. There's no direnv-style magic where opening a terminal "inside" a session
picks it up automatically.

## Non-obvious decisions
- `tsconfig.json` (the frontend one) is hand-rolled, not `extends: "@total-typescript/tsconfig/..."`
  like `tsconfig.sidecar.json`/`tsconfig.scripts.json` are. The shared preset doesn't set `jsx` or path
  aliases and Vite doesn't use `tsc` to build anyway — this file is purely for editor/type-checking, so
  it mirrors Vite's own React template instead.
- `biome.jsonc` here (`root: false`, extends the repo root) exists only to exempt
  `src/components/ui/**` from a11y lint rules — that directory is vendored from the `@coss` registry
  (`bunx --bun shadcn@latest add @coss/<name>`), not hand-authored.

## Gotchas
- `bun dev:vite` is vite-only — no Tauri IPC, so `invoke('get_backend')` throws. Useful only for
  checking the page renders, not the real connection.
- `bun run sidecar` runs the sidecar standalone (useful for curl-testing `packages/sidecar-api`'s
  contract) — writes to the real app-data dir since `NISI_DATA_DIR` is unset outside a manual override.
- The compiled `src-tauri/binaries/sidecar-*` is gitignored; `beforeBuildCommand` regenerates it via
  `build:sidecar` (host triple `aarch64-apple-darwin` only — cross-compile is future work).
- **`enabledHarnesses` still has two disagreeing sources.** `src/hooks/use-enabled-harnesses.ts`
  (the walkthrough tab's first-use onboarding gate) is `localStorage`, `null`-until-configured;
  `settings-data.ts` (the settings page's checkboxes) is `@repo/settings`. The backend blocker is
  gone — `Settings.enabledHarnesses` is now `string[] | null` (`null` = never configured) and
  `sidecar/walkthrough/harnesses.ts`'s `listHarnesses` returns all four harnesses with an `enabled`
  flag instead of filtering, so it can serve the onboarding picker directly. Unifying the frontend
  onto that one store is what's left; don't delete `use-enabled-harnesses.ts` until that lands.
- `#/*` → `src/*`, not `@/*`.
