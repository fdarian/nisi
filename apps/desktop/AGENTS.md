# @repo/desktop

Tauri 2 desktop app. Phase 0: the port/token handshake between Rust and the Bun/Effect sidecar, plus
one oRPC health check the frontend renders. No git/review/walkthrough domain logic yet — see `PLAN.md`
at the repo root for what's coming.

Three parts, one seam:
- `src-tauri/` — **Rust, intentionally thin.** Spawns/discovers the sidecar, hands `{ port, token }` to
  the frontend via the `get_backend` command. No business logic.
- `sidecar/` — the real backend, a long-running Bun process (Effect). Currently just the handshake plus
  one `health.check` procedure — no DB/services yet, so `sidecar/http.ts`'s oRPC context type is
  `WithEffectContext<never>`. Swap in a real service union there once there's a Store.
- `src/` — React frontend (TanStack Router file-based routes, shadcn on the `@coss` (coss ui / Base UI)
  registry). One route today: renders the sidecar connection state.

## The seam
The sidecar binds an ephemeral port, generates a token, deletes any stale `sidecar.json` *before*
binding, then writes `{ port, token }` to `sidecar.json` (mode 0600) in the app-data dir — macOS
`~/Library/Application Support/com.nisi.desktop/` (override with `NISI_DATA_DIR`). Rust's `get_backend`
(`src-tauri/src/lib.rs`) polls for that file **asynchronously** — it must never block the main thread,
or the frontend's one-shot `invoke('get_backend')` wedges on a cold start. Regression-tested by the
`#[tokio::test]`s in `lib.rs` — keep them if you touch that file.

- **Dev**: `bun dev` runs `scripts/dev.ts`, which races the sidecar against `tauri dev`
  (`Effect.raceAll` — either exiting kills the other, via each process's Effect `Scope`).
  `beforeDevCommand` only runs `vite`; the sidecar is started by `dev.ts`, not by Tauri.
- **Prod**: Rust spawns the compiled `binaries/sidecar` (`externalBin`, `shell:allow-spawn`) from
  `.setup()` — fire-and-forget.
- Sidecar boot (`sidecar/index.ts`) is one Effect program run via `BunRuntime.runMain`: the HTTP server
  is acquired/released with `Effect.acquireRelease` inside `Effect.scoped`, so SIGINT/SIGTERM (which
  `runMain` already listens for) interrupts the fiber and the release closes the server — no manual
  `process.on()` needed.

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
- `#/*` → `src/*`, not `@/*`.
