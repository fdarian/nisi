-- Hand-written in place of drizzle-kit's generated table recreate, which
-- would destroy every review: its `DROP TABLE sessions` cascades through
-- `reviewed_files`/`review_range_claims` because `PRAGMA foreign_keys=OFF`
-- is a no-op inside the migration transaction. A plain `ADD COLUMN` reaches
-- the same shape. Keep `snapshot.json` as generated — that's what the next
-- `db:generate` diffs against.
ALTER TABLE `sessions` ADD `prState` text;
