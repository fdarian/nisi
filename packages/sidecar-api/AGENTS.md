# @repo/sidecar-api

Contract-first oRPC v2 contract for the desktop sidecar's wire API — the single source of truth shared
by the sidecar (implementer, [`@repo/desktop`](../../apps/desktop/AGENTS.md)) and its frontend client.
Phase 1 adds git/review procedures on top of Phase 0's `health.check`; see `PLAN.md` (root), "The
contract", for the shapes these were specified against.

- `health.ts`, `sessions.ts`, `diff.ts`, `review.ts`, `events.ts` — schema + procedure contract per
  domain (`packages/sidecar-api/src/<domain>.ts`), each just types — no git/SQLite logic lives here,
  that's `@repo/git`/`@repo/review`, consumed only by the sidecar's implementation.
- `contract.ts` — composes domain contracts into the router; owns the two
  `@orpc/experimental-effect/extensions/*` side-effect imports. These **must** run before any domain
  module calls `oc.input()`/`oc.output()` — every domain module is imported only from here, never
  directly, which `package.json`'s narrow `exports` map (`"." -> "./src/index.ts"`) enforces from
  outside this package.
- `client.ts` — `makeSidecarClient({ port, token })`, a typed `RouterContractClient`.

## Gotchas
- `effect` here is the `beta` dist-tag (`4.0.0-beta.x`) — `latest` on npm is still v3. Pinned exact,
  not `^`.
- `oc.input()`/`oc.output()` accept an Effect `Schema` directly (that's what the extension imports
  in `contract.ts` buy you) — but helpers outside that patched surface, like `eventIterator`
  (`events.ts`), still want a Standard Schema. Convert with `Schema.toStandardSchemaV1(...)`.
- `diff.file`'s `force` input field isn't in PLAN.md's contract sketch — added so the load-on-demand
  size tier (see `@repo/git`) has any way to actually be loaded. Optional, additive, flagged here so
  it isn't mistaken for scope creep.
