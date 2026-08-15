# @repo/db

Shared SQLite plumbing extracted out of `@repo/review` once a second consumer
(the walkthrough store) needed it too — connection + embedded-migration
application, nothing domain-specific. Domain tables stay where the domain
that owns them lives (`@repo/review`'s in `packages/review/src/db/schema.ts`,
the walkthrough store's in `packages/walkthrough/src/db/schema.ts`), each
with its own `drizzle-kit generate` and its own embedded migration bundle —
this package only knows how to open one connection, not what any bundle
contains or how to apply one (that's `deskkit/sqlite`'s job now, see below).

- `src/client.ts` — `SqliteDb`, the one shared connection + Drizzle client for
  the whole sidecar process (`getAppDbPath`'s `app.db`, at `NISI_DATA_DIR`),
  built on `deskkit/sqlite`'s `layerSqliteClient` (an `@effect/sql-sqlite-bun`
  `SqliteClient` with `PRAGMA foreign_keys = ON` already run) and
  `drizzle-orm/effect-sqlite-bun`'s `SqliteDrizzle.make()`. `yield* SqliteDb`
  returns the drizzle db directly — every domain store queries it with
  `yield* db.select()...` straight, no wrapper of ours: the effect-native
  adapter's query builders already fail typed
  (`drizzle-orm/effect-core`'s `EffectDrizzleQueryError`), so each domain
  store maps that itself onto its own error type instead of this package
  re-wrapping it into a generic one.
- `src/paths.ts` — `getDataDirConfig` (`NISI_DATA_DIR`, defaulting to
  `~/Library/Application Support/com.nisi.desktop`) and `getAppDbPath`. The
  sidecar's own handshake file (`sidecar.json`) lives in the same directory,
  computed independently in `apps/desktop/sidecar/index.ts` — that one isn't
  SQLite, so it stays outside this package.

Migration application itself (`applyEmbeddedMigrations`) isn't this
package's anymore — it's `deskkit/sqlite`'s. Each domain package imports it
directly from there and calls it once against `SqliteDb`'s connection during
its own store's construction (see `packages/review/src/db/client.ts`,
`packages/settings/src/db/client.ts`, and the inline call in
`apps/desktop/sidecar/walkthrough/store.ts`).

## Non-obvious decisions

- **One SQLite file, not one per domain.** "Migrations generated per package,
  applied together at boot" reads as "one connection, applied in sequence"
  rather than "one file per package plus a boot-order guarantee." SQLite
  doesn't namespace by schema, so two packages' `CREATE
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
- **Nothing here sets `busy_timeout` or `journal_mode` directly anymore.**
  `@effect/sql-sqlite-bun`'s `SqliteClient.make` (which `deskkit`'s
  `layerSqliteClient` wraps) already defaults to a 5-second `busy_timeout`
  and WAL journal mode on its own — the two pragmas the old hand-rolled
  `bun:sqlite` connection used to set explicitly for exactly this reason
  (concurrent openers of `app.db` racing a fresh file's first `CREATE
  TABLE`). `test/client.test.ts` regression-tests both are still in effect
  on this stack; if a future deskkit/`@effect/sql-sqlite-bun` bump ever drops
  either default, set it back explicitly here rather than letting the test
  go red silently.
- **`SqliteDb.make` needs `FileSystem`** (to `makeDirectory` the data dir
  before opening the connection — `SqliteClient.make`'s underlying
  `bun:sqlite` handle doesn't create missing parent directories itself) —
  callers must have `FileSystem` in context wherever `SqliteDb.layer` is
  composed, same as `@repo/review`'s `ReviewStore.layer` already required
  before this extraction.

## Gotchas

- **`applyEmbeddedMigrations`'s `migrationsTable` argument must always be passed explicitly, never
  left at deskkit's own default (`'__drizzle_migrations'`).** Drizzle's migration runner decides
  "already applied" by comparing migration names already recorded in that one bookkeeping table —
  sound for one continuous history, not for two domains sharing it. Two domains sharing the default
  table name risks one domain's migration looking "already applied" (a name collision) and being
  silently skipped — its tables never get created, first surfacing as a missing-table error at query
  time, not at migration time. Every domain passes its own distinct table name
  (`__drizzle_migrations_review`, `__drizzle_migrations_settings`, `__drizzle_migrations_walkthrough`).
- **`effect` stays pinned at `4.0.0-beta.102` monorepo-wide, one version behind what
  `@effect/sql-sqlite-bun@4.0.0-beta.107` (and `drizzle-orm/effect-sqlite-bun`, transitively) declare
  as their peer requirement.** `pnpm peers check` reports this as an unmet peer — expected, not a bug
  to fix by bumping `effect` further. `deskkit` (an unpinned `github:fdarian/deskkit` dependency) has
  its *own* `effect@4.0.0-beta.102` pin baked into its package.json; bumping this repo's `effect` past
  that makes TypeScript see two structurally-incompatible `Effect` module instances and `deskkit/sqlite`
  itself stops typechecking (see its `client.ts`). Matches the shape of the syne repo's own
  `apps/desktop/package.json` (same deskkit commit, same `effect@4.0.0-beta.102` pin, same
  `@effect/sql-sqlite-bun@4.0.0-beta.107` addition) — re-check that reference before changing this.
- Effect Layers are memoized by reference within one layer graph — composing
  `SqliteDb.layer` into two different domain layers (`ReviewStore.layer` and
  the walkthrough store's layer) only opens the connection once, *as long as*
  both reference the same `SqliteDb.layer` value rather than each building
  their own `Layer.effect(SqliteDb, SqliteDb.make)`.
- `bun run db:generate` failing with `Please install latest version of
  drizzle-orm` is a lie — it's drizzle-kit's `bin.cjs` swallowing a failed
  `await import("drizzle-orm/version")`, i.e. module-not-found, not a version
  mismatch. Cause: drizzle-kit declares no peerDependency on drizzle-orm, and
  `enableGlobalVirtualStore: true` puts its package dir outside the project
  tree, so pnpm never links one as a sibling — fixed via a `drizzle-kit`
  `packageExtensions` entry in the root `pnpm-workspace.yaml`.
