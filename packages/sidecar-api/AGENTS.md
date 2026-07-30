# @repo/sidecar-api

Contract-first oRPC v2 contract for the desktop sidecar's wire API — the single source of truth shared
by the sidecar (implementer, [`@repo/desktop`](../../apps/desktop/AGENTS.md)) and its frontend client.
Git/review procedures sit alongside `health.check`.

- `health.ts`, `sessions.ts`, `diff.ts`, `review.ts`, `events.ts`, `walkthrough.ts`, `settings.ts`
  — schema + procedure contract per domain (`packages/sidecar-api/src/<domain>.ts`), each just
  types — no git/SQLite/agent logic lives here, that's
  `@repo/git`/`@repo/review`/`@repo/walkthrough`/`@repo/harness-local`/`@repo/settings`, consumed
  only by the sidecar's implementation. `walkthrough.ts` redeclares `@repo/walkthrough`'s
  `Location`/`ReferenceBlock`/`Section`/`Walkthrough` rather than importing them, same as
  `diff.ts` mirrors `@repo/git`'s `FileChange` — this package stays dependency-free from every
  domain package. `settings.ts` is the exception to "mirrors a domain package's type": there's no
  `HarnessId` in any domain package to mirror (`@repo/settings` deliberately stores it as a loose
  `string[]`, per its own AGENTS.md), so `HarnessId` here is sidecar-api's own invention, imported
  from `walkthrough.ts` rather than redeclared a third time.
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
- `diff.file`'s `force` input field exists so the load-on-demand size tier (see `@repo/git`) has any
  way to actually be loaded. Optional, additive, flagged here so it isn't mistaken for scope creep.
- Phase 3's range-scoped review added `review.setRangeViewed` (mirrors `setViewed`'s tick/untick
  shape, scoped to one block's claim on a set of ranges within one file) and `diff.ts`'s `ReviewRange`
  gained `reviewedVia: ReviewSource | null` — `{kind: "file"}` or `{kind: "range", blockId,
  blockLabel}`, attributing each surviving range to the claim currently covering it so Files Changed
  can render a "reviewed in `<block>`" marker instead of a bare "reviewed" one. `FileContentReview` is
  now populated whenever a file has *any* active claim, not only once it's been whole-file-ticked.
- `HarnessInfo` gained `available`/`binaryPath` (a live `@repo/bin-resolver` check — see the type's own
  doc for why this is independent of `enabled`), and `walkthrough.harnesses` gained a sibling
  `walkthrough.refreshHarnesses` — same output shape, but bypasses `model-discovery.ts`'s cache. A
  separate procedure rather than a `force` input field (unlike `diff.file`'s, above) so the UI can
  keep one stable, shared query-cache entry for `harnesses` while `refreshHarnesses` is called
  imperatively and its result written back into that same cache — see `apps/desktop/src/lib/walkthrough-data.ts`'s
  `useHarnesses`.
