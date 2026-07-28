# @repo/review

Persistence (sessions, per-file reviewed state, content-addressed blob store) plus Phase 2's
tracked-changes reconciliation engine. `bun:sqlite` + Drizzle, data dir shared with the sidecar's own
handshake file (`NISI_DATA_DIR`, same default as `apps/desktop/sidecar`). See `PLAN.md` (root) for the
contract this feeds, and its Phase 2 section for the `base`/`reviewed`/`head` three-way model.

- `src/store.ts` — `ReviewStore`, the public service. Sessions (open/list/close/get) and per-file
  review state (mark viewed/unviewed, read one or all, read a snapshot's content back out).
- `src/blob-store.ts` — sha256-addressed content storage on disk (`<dataDir>/blobs/<hash>`).
- `src/reconcile.ts` — `reconcile()`: three-way reconciliation (`base`/`reviewed`/`head`), splitting
  each `base → head` hunk into `reviewed`/`new` sub-ranges by overlaying `diff(reviewed, head)` on top.
  Depends on `@repo/git`'s `diffContents` for the actual diffing — this package owns the reconciliation
  *algorithm* (per `PLAN.md`'s Layout section), git owns diffing as a primitive.
- `src/resolve-review.ts` — `resolveReviewState`: looks up a file's review row by current path, falling
  back to its pre-rename path — a rename changes `reviewed_files`' key, not what a snapshot applies to.
- `src/db/schema.ts` — `sessions` + `reviewed_files` tables.
- `src/db/client.ts`, `src/db/apply-migrations.ts`, `src/db/gen-migrations.ts` — the embedded-migrations
  technique ported from rheya's `packages/db-migrations` (read there for the full rationale), but
  inlined here rather than split into its own package: this is the only SQLite consumer in nisi so
  far, and duplicating this ~100 lines a second time is the trigger to extract it, not a guess that
  it'll be needed. `bun run db:generate` after any schema change; `.gen/migrations.gen.ts` and
  `drizzle/**` are committed (needed at `bun build --compile` time, not just `drizzle-kit`'s).

## Non-obvious decisions

- **`sessionKey` is one derived text column, not a composite unique index.** `sessions.open` is
  idempotent per repo+PR, keyed by PR number when there is one, by branch when there isn't. SQLite
  treats `NULL` as distinct within a unique index, so `UNIQUE(owner, repo, prNumber)` would let
  every no-PR open insert a fresh row instead of reusing one — `sessionKey` sidesteps that by never
  being `NULL`.
- **`closeSession` never deletes a row.** Review state (`reviewed_files`) is keyed by a session's
  internal id and is the entire point of this package — deleting the session on close would orphan
  it, defeating "tracked changes" the moment you close a tab. `closeSession` sets `closedAt`;
  `listOpenSessions` filters `closedAt IS NULL`; the next `openSession` for the same key clears it
  and reuses the same `id`.
- **`markFileViewed`/`markFileUnviewed` are two methods, not one `setViewed(bool)`.** The wire
  contract's `review.setViewed({ viewed })` is a single toggle, but "viewed" needs the current
  content to snapshot and "unviewed" doesn't — the sidecar branches on `input.viewed` and calls
  the matching method, instead of this package accepting a `content: Uint8Array | null` whose
  validity depends on another field.

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
