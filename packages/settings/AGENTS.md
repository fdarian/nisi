# @repo/settings

Persistent app-level preferences the *sidecar itself* needs to read — as opposed to view-only
state, which stays in the frontend's `localStorage` the way `next-themes` already keeps theme.
`bun:sqlite` + Drizzle, data dir shared with the sidecar's own handshake file and every other
domain package's tables (`NISI_DATA_DIR`, same default as `@repo/review`/`@repo/db`).

- `src/store.ts` — `SettingsStore`, the public service. One singleton row; `get()` returns
  `DEFAULT_SETTINGS` when the row doesn't exist yet, `update()` merges a partial patch over the
  current row (reading it first) so untouched fields survive, then inserts the row on first
  write or updates it thereafter — the same read-then-insert-or-update shape as `@repo/review`'s
  `sessions.open`.
- `src/db/schema.ts` — the `settings` table. `enabledHarnesses` is a JSON-encoded `string[]`
  column (nullable — `NULL` means never configured, distinct from `"[]"`'s deliberate
  disable-everything), not a typed one — this package stays independent of `@repo/sidecar-api`'s
  `HarnessId`, same as `@repo/walkthrough`'s `harness` column does for the same reason. The
  sidecar's wiring layer (`apps/desktop/sidecar/http.ts`) is where "must be one of the four known
  ids" is actually enforced, at the wire boundary.
- `src/db/client.ts` — `runMigrations`/`dbUse`, thin wrappers around `@repo/db`'s
  `applyEmbeddedMigrations`/`dbUse` that re-map its generic `DbError` to this package's own
  `SettingsStoreError`. `src/db/gen-migrations.ts` regenerates `.gen/migrations.gen.ts`
  (`bun run db:generate` after any schema change; `.gen/migrations.gen.ts` and `drizzle/**` are
  committed, needed at `bun build --compile` time, not just `drizzle-kit`'s).

## Why this is a package, not sidecar wiring

`@repo/walkthrough`'s actual `WalkthroughStore` (the I/O half) lives in
`apps/desktop/sidecar/walkthrough/store.ts`, not in that package — because `@repo/walkthrough`
has real pure logic (coverage validation, buffer, prompt building) that has to stay testable
without SQLite. Settings has no such pure half: the whole of its logic *is* the I/O. So it
follows `@repo/review`'s shape instead — a self-contained package with its own `bun test` suite
— since `apps/desktop/sidecar` has no test setup of its own, and this store needs one (defaults
on first read, round-trip update, partial update not clobbering other fields).

## Gotchas

- Same migration-table gotcha as every other domain package sharing `@repo/db`'s `SqliteDb`
  connection — `runMigrations` passes its own `migrationsTable`
  (`__drizzle_migrations_settings`), never the default. See `@repo/db`'s AGENTS.md for what goes
  wrong if two domains share one.
- `Settings.enabledHarnesses` is a loose `ReadonlyArray<string>` here, not a literal union of the
  four known harness ids — see `src/db/schema.ts`'s comment for why, and don't add a dependency
  on `@repo/sidecar-api` to "fix" it.
