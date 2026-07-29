# sidecar

Implements `packages/sidecar-api`'s contract. Pure wiring — the actual git/persistence/agent logic
lives in `@repo/git`, `@repo/review`, `@repo/walkthrough`, and `@repo/harness-local`; this directory
composes them and translates between domain errors and oRPC error codes. See root `AGENTS.md` → "The
seam" for the port/token handshake this boots into.

- `index.ts` — boot: handshake file, builds `MainLayer` (`Store` + `WalkthroughStore` +
  `SettingsStore` + `SqliteDb` + Bun platform services), runs one `Effect` program via
  `BunRuntime.runMain`.
- `services.ts` — `AppServices`, the service union `mainContext` carries. One alias so `http.ts` and
  the walkthrough generation loop (which bridges Effect from a plain `async function*`, not `.effect()`)
  agree on what's available without each hand-rolling the union.
- `store.ts` — `Store`, the service `http.ts`'s git/review handlers depend on. One method per contract
  procedure (`openSession`, `listChangedFiles`, `setFileViewed`, ...), each composing `@repo/review`'s
  `ReviewStore` with `@repo/git`'s functions. `Session` here is the wire shape (`pr.baseRef`/`headRef`
  hoisted into the `pr` sub-object); `@repo/review`'s own `Session` keeps them at the top level since
  they apply whether or not there's a PR — `toWireSession` bridges the two.
- `http.ts` — the oRPC router. Each handler maps one or two domain packages' tagged errors to a
  declared contract error via `Effect.catchTag` + `errors.XXX(...)`; anything else (gh auth failures,
  decode errors, etc.) is an uncaught defect → oRPC's generic 500. Deliberately not exhaustive for
  Phase 1 — see `packages/sidecar-api/AGENTS.md` for which shapes got extra errors and why.
  `settings.get`/`settings.update` are the one pair of handlers backed directly by a domain
  package's own store (`@repo/settings`'s `SettingsStore`) rather than a sidecar-local wrapper —
  see that package's AGENTS.md for why it didn't need the `WalkthroughStore` split.
  `walkthrough.harnesses` reads `SettingsStore` first and passes its `enabledHarnesses` into
  `listHarnesses`, so the registry reflects the user's declared harnesses instead of always
  reporting all four.
- `events.ts` — in-memory pub/sub for `events.subscribe`, ported from rheya's sidecar verbatim. oRPC's
  `.effect()` can't return a live async iterator (it resolves the generator via `runPromise`), so
  `events.subscribe` uses the lower-level `.handler(async function* ...)` instead, bridging this
  module's callback-style `subscribe` into a pull loop woken by a `wake` closure. `walkthrough.generate`
  uses the same `.handler()` escape hatch, for the same reason.
- `live-poll.ts` — `startLivePolling`, forked as a background fiber from `index.ts`'s boot program.
  Every `POLL_INTERVAL`, diffs each open session's `@repo/git` change signature against the previous
  tick (module-level `Map`, same in-memory-state shape as `events.ts`'s subscriber `Set`) and emits
  `session-files-changed` when it moved. Never reads file content itself — that's what makes it cheap
  enough to run on every open session on every tick; a stale-data refetch is the frontend's job once
  the event lands.
- `walkthrough/` — Phase 3's wiring layer. See its own AGENTS.md.

## Gotchas

- **`Layer.provideMerge`, not `Layer.provide`, throughout `index.ts`'s `MainLayer`.** `Store.layer`
  and `WalkthroughStore.layer` both need `SqliteDb` (`@repo/db`'s shared connection) and
  `FileSystem`/`ChildProcessSpawner` (via `@repo/review`'s `ReviewStore` and, per-call, `@repo/git`'s
  functions), but oRPC handlers and the walkthrough generation loop also reach some of those services
  *directly* — plain `provide` would satisfy each layer's own construction-time requirement without
  re-exposing the service for those per-call requirements. Same gotcha documented in
  `packages/review/AGENTS.md`, one layer up, now applied one more time for `ReviewStore` itself
  (`store.ts`'s `Store.layer`) and for `SqliteDb` (shared by both `Store` and `WalkthroughStore`).
- **`mainContext` is captured once, in `index.ts`'s boot program**, via `Effect.context<AppServices>()`,
  then passed into `startServer` and set as the `effect/context` for every oRPC request. Each request's
  handler effect isn't part of the boot program's fiber, so it can't `yield*` a service unless that
  service is in the context this way. The walkthrough generation loop (`walkthrough/generate.ts`)
  receives the same `mainContext` and bridges Effect from its own plain `async function*` with it.
