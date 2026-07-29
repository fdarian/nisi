# @repo/db

Shared SQLite plumbing extracted out of `@repo/review` once a second consumer
(the walkthrough store) needed it too — connection + embedded-migration
application, nothing domain-specific. Domain tables stay where the domain
that owns them lives (`@repo/review`'s in `packages/review/src/db/schema.ts`,
the walkthrough store's in `packages/walkthrough/src/db/schema.ts`), each
with its own `drizzle-kit generate` and its own embedded migration bundle —
this package only knows how to open one connection and apply a bundle to it,
not what any bundle contains.

- `src/client.ts` — `SqliteDb`, the one shared connection + Drizzle client for
  the whole sidecar process (`getAppDbPath`'s `app.db`, at `NISI_DATA_DIR`).
  Every domain store depends on `SqliteDb` instead of opening its own
  `bun:sqlite` handle; `dbUse` wraps a query, turning a thrown error into
  `DbError` instead of letting it escape untyped.
- `src/migrations.ts` — `applyEmbeddedMigrations`: ports drizzle's internal
  `dialect.migrate()` call so a migration bundle (journal + raw SQL, already
  read into memory) can be applied without touching the filesystem — the
  technique a `bun build --compile` binary needs, since the source `drizzle/`
  folder doesn't exist on disk in the compiled binary. Domain packages call
  this once each, against the same `SqliteDb` connection, during their own
  store's construction.
- `src/paths.ts` — `getDataDirConfig` (`NISI_DATA_DIR`, defaulting to
  `~/Library/Application Support/com.nisi.desktop`) and `getAppDbPath`. The
  sidecar's own handshake file (`sidecar.json`) lives in the same directory,
  computed independently in `apps/desktop/sidecar/index.ts` — that one isn't
  SQLite, so it stays outside this package.

## Non-obvious decisions

- **One SQLite file, not one per domain.** "Migrations generated per package,
  applied together at boot" (PLAN.md, Phase 3) reads as "one connection,
  applied in sequence" rather than "one file per package plus a boot-order
  guarantee." SQLite doesn't namespace by schema, so two packages' `CREATE
  TABLE` statements coexisting in one file is fine as long as table names
  don't collide (they don't: `sessions`/`reviewed_files` vs `walkthroughs`).
  This also means cross-domain foreign keys are possible in principle, but
  nothing here uses one — the walkthrough store's `sessionId` column is a
  plain text column holding `@repo/review`'s `sessions.publicId`, not a
  declared FK, so `@repo/walkthrough` never has to import `@repo/review`'s
  schema just to reference it.
- **The blob store stayed in `@repo/review`.** Content-addressed blob storage
  is the review domain's own building block (whole-file snapshots for
  tracked-changes reconciliation) — the walkthrough store persists a small
  JSON document and a map of file fingerprints, both plain `text` columns, no
  binary blob storage at all. Nothing today shares that need, so it wasn't
  pulled into this package; move it here if a second blob consumer shows up.
- **`SqliteDb.make` needs `FileSystem`** (to `makeDirectory` the data dir
  before `bun:sqlite`'s `Database` constructor, which doesn't create missing
  parent directories itself) — callers must have `FileSystem` in context
  wherever `SqliteDb.layer` is composed, same as `@repo/review`'s
  `ReviewStore.layer` already required before this extraction.

## Gotchas

- **`applyEmbeddedMigrations`'s `migrationsTable` argument is required, never default it back to
  drizzle's own `__drizzle_migrations`.** Drizzle's migration runner decides "already applied" by
  comparing each migration's *generation-time* timestamp against the single most recent row in that
  one table (`ORDER BY created_at DESC LIMIT 1`) — sound for one continuous history, not for two
  domains sharing it. Caught live: with both domains defaulting to the same table, whichever bundle
  happened to be generated *later* (by wall-clock `drizzle-kit generate` time), if applied first,
  made the *other* domain's genuinely-new migration look older than "already applied" and silently
  skipped it — its tables never got created, first surfacing as `no such table: sessions` at runtime,
  not at migration time. Every domain passes its own distinct table name
  (`__drizzle_migrations_review`, `__drizzle_migrations_walkthrough`, …).
- `dbUse`'s `DrizzleClient` type carries no `schema` type parameter (`drizzle(sqlite)`,
  not `drizzle(sqlite, { schema })`) — nothing in this codebase uses Drizzle's
  relational query API (`db.query.*`), only the plain query builder
  (`.select().from(table)`), which doesn't need the schema type to type a
  result correctly. If something ever needs `db.query`, revisit this.
- Effect Layers are memoized by reference within one layer graph — composing
  `SqliteDb.layer` into two different domain layers (`ReviewStore.layer` and
  the walkthrough store's layer) only opens the connection once, *as long as*
  both reference the same `SqliteDb.layer` value rather than each building
  their own `Layer.effect(SqliteDb, SqliteDb.make)`.
