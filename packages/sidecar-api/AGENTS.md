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
- `diff.fileContents` is batched (`paths: FileContentRequest[]` in, `FileContentResult[]` out, one
  per requested path) rather than one-path-per-call — it replaced a singular `diff.file` outright
  (its only caller, `apps/desktop/src/lib/pr-data.ts`'s `useFileContents`, chunks a large PR's paths
  across several calls rather than issuing one per file). A path not actually in the diff reports
  `content: null` in its own result entry instead of failing the batch. Each path's `force` input
  field exists so the load-on-demand size tier (see `@repo/git`) has any way to actually be loaded.
- `diff.files`/`diff.fileContents` both gained `includeUncommitted`, mirroring `@repo/git`'s option
  of the same name — the frontend sources it from `@repo/settings`'s persisted setting and folds it
  into the query `input` (not a separate param) specifically so it's part of the TanStack Query
  cache key; see `apps/desktop/src/lib/pr-data.ts`'s `useFileChanges`/`useFileContents`.
  `fileContents`' flag sits at the batch's top level, not per-path in `FileContentRequest` — it
  mirrors a session-wide setting applied uniformly, the same reasoning `@repo/git`'s
  `getFileContents` resolves it to one `DiffTarget` for the whole call rather than per-path.
- Phase 3's range-scoped review added `review.setRangeViewed` (mirrors `setViewed`'s tick/untick
  shape, scoped to one block's claim on a set of ranges within one file) and `diff.ts`'s `ReviewRange`
  gained `reviewedVia: ReviewSource | null` — `{kind: "file"}` or `{kind: "range", blockId,
  blockLabel}`, attributing each surviving range to the claim currently covering it. `FileContentReview`
  is now populated whenever a file has *any* active claim, not only once it's been whole-file-ticked.
  `ranges` itself now only feeds the walkthrough reference pane's per-file reviewed/partial/unreviewed
  checkbox (`apps/desktop/src/components/walkthrough/reference-pane.tsx`) — the diff pane stopped
  reading it once `baselineKind` shipped, below.
- `FileContentReview` gained `baselineKind: "base" | "reviewed"`, telling the diff pane which file
  `FileContent.patch`/`oldContent` are actually diffed against. `"reviewed"` means the sidecar
  substituted `@repo/review`'s synthesized `reviewedBaseline` for the usual merge-base content before
  computing the patch — so an *empty* patch under `"reviewed"` means "nothing new since your last
  pass," not "nothing changed in the PR." Always `"base"` for a size-gated file even with an active
  claim, since reconciliation needs content the size gate withheld.
- `HarnessInfo` gained `available`/`binaryPath` (a live `@repo/bin-resolver` check — see the type's own
  doc for why this is independent of `enabled`), and `walkthrough.harnesses` gained a sibling
  `walkthrough.refreshHarnesses` — same output shape, but bypasses `model-discovery.ts`'s cache. A
  separate procedure rather than a `force` input field (unlike `diff.fileContents`'s, above) so the UI can
  keep one stable, shared query-cache entry for `harnesses` while `refreshHarnesses` is called
  imperatively and its result written back into that same cache — see `apps/desktop/src/lib/walkthrough-data.ts`'s
  `useHarnesses`.
