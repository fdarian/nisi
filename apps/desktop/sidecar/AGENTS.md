# sidecar

Implements `packages/sidecar-api`'s contract. Pure wiring — the actual git/persistence logic lives in
`@repo/git` and `@repo/review`; this directory composes them and translates between domain errors and
oRPC error codes. See root `AGENTS.md` → "The seam" for the port/token handshake this boots into.

- `index.ts` — boot: handshake file, builds `MainLayer` (`Store` + Bun platform services), runs one
  `Effect` program via `BunRuntime.runMain`.
- `store.ts` — `Store`, the service `http.ts`'s handlers depend on. One method per contract procedure
  (`openSession`, `listChangedFiles`, `setFileViewed`, ...), each composing `@repo/review`'s
  `ReviewStore` with `@repo/git`'s functions. `Session` here is the wire shape (`pr.baseRef`/`headRef`
  hoisted into the `pr` sub-object); `@repo/review`'s own `Session` keeps them at the top level since
  they apply whether or not there's a PR — `toWireSession` bridges the two.
- `http.ts` — the oRPC router. Each handler maps one or two of `@repo/git`/`@repo/review`'s tagged
  errors to a declared contract error via `Effect.catchTag` + `errors.XXX(...)`; anything else (gh
  auth failures, decode errors, etc.) is an uncaught defect → oRPC's generic 500. Deliberately not
  exhaustive for Phase 1 — see `packages/sidecar-api/AGENTS.md` for which shapes got extra errors and why.
- `events.ts` — in-memory pub/sub for `events.subscribe`, ported from rheya's sidecar verbatim. oRPC's
  `.effect()` can't return a live async iterator (it resolves the generator via `runPromise`), so
  `events.subscribe` uses the lower-level `.handler(async function* ...)` instead, bridging this
  module's callback-style `subscribe` into a pull loop woken by a `wake` closure.
- `live-poll.ts` — `startLivePolling`, forked as a background fiber from `index.ts`'s boot program.
  Every `POLL_INTERVAL`, diffs each open session's `@repo/git` change signature against the previous
  tick (module-level `Map`, same in-memory-state shape as `events.ts`'s subscriber `Set`) and emits
  `session-files-changed` when it moved. Never reads file content itself — that's what makes it cheap
  enough to run on every open session on every tick; a stale-data refetch is the frontend's job once
  the event lands.

## Gotchas

- **`Layer.provideMerge`, not `Layer.provide`, for `BunServices` in `index.ts`.** `Store.layer` needs
  `FileSystem`/`ChildProcessSpawner` to build `ReviewStore`, but oRPC handlers also call `@repo/git`
  functions *directly* (via `Store`'s methods) that independently require those services in their own
  effect — plain `provide` would satisfy `Store.layer`'s construction-time requirement but not
  re-expose `FileSystem`/`ChildProcessSpawner` for those per-call requirements. Same gotcha documented
  in `packages/review/AGENTS.md`, one layer up.
- **`mainContext` is captured once, in `index.ts`'s boot program**, via `Effect.context<Store |
  BunServices.BunServices>()`, then passed into `startServer` and set as the `effect/context` for
  every oRPC request. Each request's handler effect isn't part of the boot program's fiber, so it
  can't `yield*` a service unless that service is in the context this way.
