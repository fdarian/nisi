# @repo/review

Persistence (sessions, per-file reviewed state, content-addressed blob store) plus the tracked-changes
reconciliation engine, now covering both Phase 2's whole-file review and Phase 3's range-scoped review.
`bun:sqlite` + Drizzle, data dir shared with the sidecar's own handshake file (`NISI_DATA_DIR`, same
default as `apps/desktop/sidecar`). Feeds `packages/sidecar-api`'s `review`/`diff` contracts.

- `src/store.ts` — `ReviewStore`, the public service. Sessions (open/list/close/get), whole-file review
  state (mark viewed/unviewed, read one or all), range claims (mark/unmark one block's claim on a file,
  list a file's active claims), and reading a snapshot's content back out of the blob store.
- `src/blob-store.ts` — sha256-addressed content storage on disk (`<dataDir>/blobs/<hash>`).
- `src/reconcile.ts` — `reconcile()`: reconciles `base`/`head` against every currently-active
  `ReviewClaim` on a file (the whole-file toggle and/or any number of block-scoped range claims),
  splitting each `base → head` hunk into `reviewed`/`new` sub-ranges and attributing each surviving one
  to whichever claim currently covers it (most-recently-ticked wins on overlap — see `ReviewSource`).
  Whole-file review is the degenerate case of a claim ranging over the entire file (`ranges: null`), not
  a separate code path — one reconciliation algorithm for both. Depends on `@repo/git`'s
  `diffContents` for the actual diffing — this package owns the reconciliation *algorithm*, git owns
  diffing as a primitive.
- `src/resolve-review.ts` — `resolveByPath`: looks up a value keyed by a file's current path, falling
  back to its pre-rename path — a rename changes a path-keyed row's key, not what a snapshot applies to.
  `resolveReviewState` is the whole-file-review-shaped wrapper around it; range claims resolve the same
  way but by re-querying `listRangeClaims` on `oldPath` (see `apps/desktop/sidecar/store.ts`), since
  `ReviewStore.listRangeClaims` is path-scoped rather than a whole-session map.
- `src/db/schema.ts` — `sessions` + `reviewed_files` (whole-file toggle, one row per session+path) +
  `review_range_claims` (range claims, one row per session+path+blockId — additive, not unified into
  `reviewed_files`, since a file can carry several simultaneous block claims where the whole-file toggle
  is a single mutable slot; see its own doc comment for why storage stayed split while the
  *reconciliation* did unify).
- `src/db/client.ts` — `runMigrations`/`dbUse`, thin wrappers around `@repo/db`'s
  `applyEmbeddedMigrations`/`dbUse` that re-map its generic `DbError` to this package's own
  `ReviewStoreError`. The connection itself (`SqliteDb`) and the embedded-migrations technique live in
  `@repo/db` now — this package only owns its own schema and its own generated migration bundle
  (`src/db/gen-migrations.ts`, `bun run db:generate` after any schema change; `.gen/migrations.gen.ts`
  and `drizzle/**` are committed, needed at `bun build --compile` time, not just `drizzle-kit`'s).

`ReviewStore.make` depends on `@repo/db`'s `SqliteDb` for the connection — see that package's AGENTS.md
for why review's tables and the walkthrough store's tables share one `app.db` file.

## Non-obvious decisions

- **`sessionKey` is one derived text column, not a composite unique index.** `sessions.open` is
  idempotent per *working tree* + PR — `${repoRoot}#pr${n}`, or `${repoRoot}#branch${headRef}#base${baseRef}`
  when there's no PR. The base is part of the no-PR key, not just the branch: `nisi diff <base>`
  (`packages/cli`) can review the same branch against different bases, and those are distinct
  reviews with distinct reviewed snapshots, not one session two bases would silently repoint.
  Rooted at `repoRoot`, not the GitHub repo, because review state is snapshots of those exact
  files: two clones or worktrees of one upstream are two reviews, and keying on repo identity made
  the second open silently repoint the first's `repoRoot`. SQLite treats `NULL` as distinct within
  a unique index, so anything composite involving `prNumber` would let every no-PR open insert a
  fresh row instead of reusing one — `sessionKey` sidesteps that by never being `NULL`.
- **A session's `owner`/`repo` are PR-scoped and nullable.** A repo with no GitHub origin (or one
  `gh` can't resolve) still opens a session and reviews against its default branch, so there's no
  GitHub identity to record — `Session.pr` carries `owner`/`repo` and is `null` as a unit rather
  than leaving blank strings at the top level.
- **`drizzle/0002_*.sql` is hand-written, and any future migration touching `sessions` must be too.**
  drizzle-kit's SQLite recreate drops and rebuilds the table under `PRAGMA foreign_keys=OFF` — a
  no-op inside the transaction `applyEmbeddedMigrations` runs in, so `DROP TABLE sessions` cascades
  through `reviewed_files`/`review_range_claims` and empties both. Reach the same shape with
  `ALTER TABLE` and keep drizzle-kit's generated `meta/*_snapshot.json` as-is; that's what the next
  `db:generate` diffs against.
- **`closeSession` never deletes a row.** Review state (`reviewed_files`) is keyed by a session's
  internal id and is the entire point of this package — deleting the session on close would orphan
  it, defeating "tracked changes" the moment you close a tab. `closeSession` sets `closedAt`;
  `listOpenSessions` filters `closedAt IS NULL`; the next `openSession` for the same key clears it
  and reuses the same `id`.
- **`markFileViewed`/`markFileUnviewed` are two methods, not one `setViewed(bool)`.** The wire
  contract's `review.setViewed({ viewed })` is a single toggle, but "viewed" needs the current
  content to snapshot and "unviewed" doesn't — the sidecar branches on `input.viewed` and calls
  the matching method, instead of this package accepting a `content: Uint8Array | null` whose
  validity depends on another field. `markRangeViewed`/`unmarkRangeViewed` mirror this split for the
  same reason.
- **`unmarkRangeViewed` deletes the row; `markFileUnviewed` upserts `viewed: false` in place.**
  `reviewed_files` is a single mutable per-file slot whose whole reason to exist is remembering "this
  file was reviewed, then un-reviewed" — a session; `review_range_claims` is a genuine
  one-row-per-active-claim table, so unticking a block's claim has nothing left worth keeping a row
  for.
- **Reconciliation is one algorithm, storage stayed two tables.** Range claims weren't folded into
  `reviewed_files` even though `reconcile()` treats a whole-file review as just a claim ranging over
  the entire file — the two have different mutation semantics (one mutable slot per file vs. several
  simultaneous claims per file from different blocks), and unifying the *storage* would mean either a
  nullable-blockId composite key (SQLite treats `NULL` as distinct in unique indexes, same footgun
  `sessionKey` above sidesteps) or conditional validation on which fields matter. Unifying only the
  reconciliation math avoided both without losing the "one code path" goal.
- **Overlapping claims attribute to the most recently ticked one, not the whole-file claim.** When a
  whole-file review and a block-scoped range both still cover the same head line, `reconcile()`
  compares `viewedAt` — freshest wins. This matters for what Files Changed renders as the "reviewed
  in `<block>`" marker vs. a plain "reviewed" one; see `reconcile.ts`'s `splitRangeByClaims`.

## Gotchas

- Column names are literally the JS property names (no `snake_case` casing config) — see
  `code-db-schema` skill. Table names are still explicit snake_case.
- `Context.Service`-based services here don't get an auto-generated `.Default` layer (that was
  `Effect.Service`); build one explicitly (`static layer = Layer.effect(Self, Self.make)`).
- Composing `ReviewStore.layer` with its `FileSystem` dependency: use `Layer.provideMerge`, not
  `Layer.provide`, if the caller's effect also calls `FileSystem`-requiring code directly (e.g.
  `markFileViewed`) — plain `provide` hides `FileSystem` after building `ReviewStore`, leaving it
  unsatisfied for anything else that needs it independently.
- Effect v4 dropped `Layer.setConfigProvider`; the replacement is `ConfigProvider.layer(provider)`
  (see `test/fixtures.ts` for overriding `NISI_DATA_DIR` per test without touching `process.env` —
  bun test doesn't strictly serialize independent `test()` bodies, so a shared env mutation is a
  real race, not just a style preference).
